import { randomUUID } from 'node:crypto'

import type { ConnectionDraft, ConnectionState, ConnectionSummary, ConnectionTestResult, ConnectionTestTarget } from '@shared/protocol'

import { createProfile, sameProfileName } from '../domain/connection'
import type { ConnectionConfig, ConnectionProfile } from '../domain/connection'
import type { DatabaseDriver } from '../domain/driver'
import { DataForgeError, wrapError } from '../domain/errors'
import { Emitter } from './ports'
import type { ConnectionStore, DriverFactory, Logger, SecretStore } from './ports'

export interface ConnectionServiceDeps {
  readonly store: ConnectionStore
  readonly secrets: SecretStore
  readonly createDriver: DriverFactory
  readonly logger: Logger
}

interface RuntimeState {
  state: ConnectionState
  serverVersion?: string
  lastError?: string
}

/**
 * Owns the connection catalogue and the live drivers behind it.
 *
 * The service is deliberately VS Code free: the extension passes adapters in,
 * which keeps the whole connection lifecycle unit-testable.
 */
export class ConnectionService {
  private readonly profiles = new Map<string, ConnectionProfile>()
  private readonly drivers = new Map<string, DatabaseDriver>()
  private readonly runtime = new Map<string, RuntimeState>()
  private readonly changed = new Emitter<readonly ConnectionSummary[]>()
  private disposed = false

  /** Fires whenever the catalogue or any runtime state changes. */
  readonly onDidChange = this.changed.event

  constructor(private readonly deps: ConnectionServiceDeps) {}

  async initialize(): Promise<void> {
    const stored = await this.deps.store.load()
    for (const profile of stored) {
      this.profiles.set(profile.id, profile)
      this.runtime.set(profile.id, { state: 'disconnected' })
    }
    this.deps.logger.info(`Loaded ${stored.length} connection profile(s)`)
    this.changed.fire(this.list())
  }

  list(): ConnectionSummary[] {
    return [...this.profiles.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => this.toSummary(profile))
  }

  get(connectionId: string): ConnectionSummary {
    return this.toSummary(this.profile(connectionId))
  }

  async create(draft: ConnectionDraft): Promise<ConnectionSummary> {
    this.assertNameAvailable(draft.name)
    const profile = createProfile(randomUUID(), draft, Date.now())
    this.profiles.set(profile.id, profile)
    this.runtime.set(profile.id, { state: 'disconnected' })

    try {
      await this.persist()
      if (draft.password) {
        await this.deps.secrets.write(profile.id, { password: draft.password })
      }
    } catch (error) {
      this.profiles.delete(profile.id)
      this.runtime.delete(profile.id)
      throw wrapError('internal', 'Could not save the connection', error)
    }

    this.deps.logger.info(`Created connection "${profile.name}" (${profile.user}@${profile.host}:${profile.port})`)
    this.changed.fire(this.list())
    return this.toSummary(profile)
  }

  async update(connectionId: string, patch: Partial<ConnectionDraft>): Promise<ConnectionSummary> {
    const current = this.profile(connectionId)
    if (patch.name && !sameProfileName(patch.name, current.name)) {
      this.assertNameAvailable(patch.name)
    }

    const updated = createProfile(
      current.id,
      {
        name: patch.name ?? current.name,
        host: patch.host ?? current.host,
        port: patch.port ?? current.port,
        database: patch.database ?? current.database,
        user: patch.user ?? current.user,
        ssl: patch.ssl ?? current.ssl,
        readOnly: patch.readOnly ?? current.readOnly,
      },
      current.createdAt,
    )

    this.profiles.set(connectionId, updated)
    await this.persist()

    if (patch.password) await this.deps.secrets.write(connectionId, { password: patch.password })
    // Connection parameters changed: the open pool is stale.
    await this.disconnect(connectionId).catch(() => undefined)

    this.deps.logger.info(`Updated connection "${updated.name}"`)
    this.changed.fire(this.list())
    return this.toSummary(updated)
  }

  async delete(connectionId: string): Promise<void> {
    const profile = this.profile(connectionId)
    await this.disconnect(connectionId).catch(() => undefined)
    this.profiles.delete(connectionId)
    this.runtime.delete(connectionId)
    await this.deps.secrets.delete(connectionId)
    await this.persist()
    this.deps.logger.info(`Deleted connection "${profile.name}"`)
    this.changed.fire(this.list())
  }

  async test(target: ConnectionTestTarget): Promise<ConnectionTestResult> {
    const config = target.connectionId
      ? await this.configFor(this.profile(target.connectionId))
      : await this.configFor(createProfile('probe', target.draft ?? {}, Date.now()), target.draft?.password ?? '')

    const driver = this.createDriver(config)
    const started = Date.now()
    try {
      const info = await driver.testConnection()
      return { ...info, latencyMs: Date.now() - started }
    } catch (error) {
      throw wrapError('connection_failed', 'Connection test failed', error)
    } finally {
      await driver.dispose().catch(() => undefined)
    }
  }

  async connect(connectionId: string): Promise<ConnectionSummary> {
    const profile = this.profile(connectionId)
    if (this.drivers.has(connectionId)) return this.toSummary(profile)

    const driver = this.createDriver(await this.configFor(profile))
    try {
      const info = await driver.testConnection()
      this.drivers.set(connectionId, driver)
      this.runtime.set(connectionId, { state: 'connected', serverVersion: info.serverVersion })
      this.deps.logger.info(`Connected to "${profile.name}" — ${info.serverVersion}`)
    } catch (error) {
      await driver.dispose().catch(() => undefined)
      const failure = wrapError('connection_failed', `Could not connect to "${profile.name}"`, error)
      this.runtime.set(connectionId, { state: 'error', lastError: failure.message })
      this.changed.fire(this.list())
      throw failure
    }

    this.changed.fire(this.list())
    return this.toSummary(profile)
  }

  async disconnect(connectionId: string): Promise<ConnectionSummary> {
    const profile = this.profile(connectionId)
    const driver = this.drivers.get(connectionId)
    this.drivers.delete(connectionId)
    this.runtime.set(connectionId, { state: 'disconnected' })
    if (driver) await driver.dispose().catch((error: unknown) => this.deps.logger.warn(`Dispose failed: ${String(error)}`))
    this.changed.fire(this.list())
    return this.toSummary(profile)
  }

  /** Returns the live driver of a connected profile, or a precise domain error. */
  requireDriver(connectionId: string): DatabaseDriver {
    const driver = this.drivers.get(connectionId)
    if (driver) return driver
    const profile = this.profiles.get(connectionId)
    if (!profile) throw new DataForgeError('not_found', 'That connection no longer exists.')
    throw new DataForgeError('connection_failed', `Connection "${profile.name}" is not connected.`)
  }

  isConnected(connectionId: string): boolean {
    return this.drivers.has(connectionId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const drivers = [...this.drivers.values()]
    this.drivers.clear()
    await Promise.all(drivers.map((driver) => driver.dispose().catch(() => undefined)))
  }

  private profile(connectionId: string): ConnectionProfile {
    const profile = this.profiles.get(connectionId)
    if (!profile) throw new DataForgeError('not_found', 'That connection no longer exists.')
    return profile
  }

  private createDriver(config: ConnectionConfig): DatabaseDriver {
    return this.deps.createDriver(config)
  }

  private async configFor(profile: ConnectionProfile, fallbackPassword?: string): Promise<ConnectionConfig> {
    const credentials = await this.deps.secrets.read(profile.id)
    return { profile, credentials: credentials ?? { password: fallbackPassword ?? '' } }
  }

  private async persist(): Promise<void> {
    await this.deps.store.save([...this.profiles.values()])
  }

  private assertNameAvailable(name: string): void {
    const taken = [...this.profiles.values()].some((profile) => sameProfileName(profile.name, name))
    if (taken) throw new DataForgeError('invalid_request', `A connection named "${name.trim()}" already exists.`)
  }

  private toSummary(profile: ConnectionProfile): ConnectionSummary {
    const runtime = this.runtime.get(profile.id) ?? { state: 'disconnected' as const }
    return {
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      ssl: profile.ssl,
      readOnly: profile.readOnly,
      state: runtime.state,
      ...(runtime.serverVersion === undefined ? {} : { serverVersion: runtime.serverVersion }),
      ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
    }
  }
}
