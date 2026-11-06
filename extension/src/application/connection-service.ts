import { randomUUID } from 'node:crypto'

import type { ConnectionDraft, ConnectionState, ConnectionSummary, ConnectionTestResult, ConnectionTestTarget } from '@shared/protocol'

import type { DriverCapabilitiesDto } from '@shared/protocol'
import { createProfile, sameProfileName } from '../domain/connection'
import type { ConnectionConfig, ConnectionCredentials, ConnectionProfile } from '../domain/connection'
import type {
  DatabaseDriver,
  DataEditingDriver,
  DdlDriver,
  ObjectCatalogDriver,
  TableExportDriver,
  TransactionalDriver,
} from '../domain/driver'
import { DataForgeError, wrapError } from '../domain/errors'
import { scopeKey, scopeOf } from '../domain/scope'
import { Emitter } from './ports'
import type { ConnectionStore, ConnectionTunnel, DriverFactory, Logger, SecretStore, TunnelFactory } from './ports'

export interface ConnectionServiceDeps {
  readonly store: ConnectionStore
  readonly secrets: SecretStore
  readonly createDriver: DriverFactory
  /** Optional: profiles with a tunnel cannot connect without it. */
  readonly createTunnel?: TunnelFactory
  readonly logger: Logger
}

interface RuntimeState {
  state: ConnectionState
  serverVersion?: string
  lastError?: string
}

/**
 * Editing is a capability, not a property of every driver: a future MySQL or
 * SQLite adapter may ship read-only first and grow the writes later.
 */
export function isDataEditingDriver(driver: DatabaseDriver): driver is DataEditingDriver {
  const candidate = driver as Partial<DataEditingDriver>
  return (
    typeof candidate.selectPage === 'function' &&
    typeof candidate.applyMutations === 'function' &&
    typeof candidate.countRows === 'function'
  )
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
  private readonly databases = new Map<string, Promise<string[]>>()
  /** Extra pools, one per browsed database other than the connection's own. */
  private readonly scopedDrivers = new Map<string, DatabaseDriver>()
  /** Open SSH forwarders, one per connection, reused by every scoped pool. */
  private readonly tunnels = new Map<string, ConnectionTunnel>()
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
      await this.deps.secrets.write(profile.id, {
        password: draft.password,
        sshPassword: draft.sshPassword,
        sshPassphrase: draft.sshPassphrase,
      })
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
        kind: patch.kind ?? current.kind,
        name: patch.name ?? current.name,
        host: patch.host ?? current.host,
        port: patch.port ?? current.port,
        database: patch.database ?? current.database,
        user: patch.user ?? current.user,
        ssl: patch.ssl ?? current.ssl,
        readOnly: patch.readOnly ?? current.readOnly,
        tunnel: patch.tunnel === undefined ? current.tunnel : patch.tunnel ?? undefined,
      },
      current.createdAt,
    )

    this.profiles.set(connectionId, updated)
    await this.persist()

    if (
      patch.password ||
      patch.sshPassword !== undefined ||
      patch.sshPassphrase !== undefined ||
      patch.tunnel !== undefined
    ) {
      const existing = await this.deps.secrets.read(connectionId)
      // A profile that no longer has a tunnel (or switched to a key) must not
      // keep an unused SSH password around in SecretStorage.
      const keepSsh =
        patch.tunnel === undefined || patch.tunnel?.auth !== 'private key' ? existing : undefined
      await this.deps.secrets.write(connectionId, {
        password: patch.password || existing?.password || '',
        sshPassword: patch.sshPassword !== undefined ? patch.sshPassword : keepSsh?.sshPassword,
        sshPassphrase: patch.sshPassphrase !== undefined ? patch.sshPassphrase : keepSsh?.sshPassphrase,
      })
    }
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
    const profile = target.connectionId
      ? this.profile(target.connectionId)
      : createProfile('probe', target.draft ?? {}, Date.now())
    const credentials: ConnectionCredentials = target.connectionId
      ? await this.credentialsFor(profile)
      : {
        password: target.draft?.password ?? '',
        sshPassword: target.draft?.sshPassword,
        sshPassphrase: target.draft?.sshPassphrase,
      }

    let tunnel = this.tunnels.get(profile.id)
    const owned = !tunnel && profile.tunnel ? await this.openTunnel(profile, credentials) : undefined
    if (owned) tunnel = owned
    const driverProfile = tunnel ? { ...profile, host: tunnel.host, port: tunnel.port } : profile
    const driver = this.createDriver({ profile: driverProfile, credentials })
    const started = Date.now()
    try {
      const info = await driver.testConnection()
      return { ...info, latencyMs: Date.now() - started }
    } catch (error) {
      throw wrapError('connection_failed', 'Connection test failed', error)
    } finally {
      await driver.dispose().catch(() => undefined)
      if (owned) await owned.dispose().catch(() => undefined)
    }
  }

  async connect(connectionId: string): Promise<ConnectionSummary> {
    const profile = this.profile(connectionId)
    if (this.drivers.has(connectionId)) return this.toSummary(profile)

    const credentials = await this.credentialsFor(profile)
    let tunnel: ConnectionTunnel | undefined
    let driver: DatabaseDriver | undefined
    try {
      if (profile.tunnel && !this.tunnels.has(connectionId)) {
        tunnel = await this.openTunnel(profile, credentials)
        this.tunnels.set(connectionId, tunnel)
      }
      driver = this.createDriver({ profile: this.tunnelled(profile), credentials })
      const info = await driver.testConnection()
      this.drivers.set(connectionId, driver)
      this.runtime.set(connectionId, { state: 'connected', serverVersion: info.serverVersion })
      this.deps.logger.info(`Connected to "${profile.name}" — ${info.serverVersion}`)
    } catch (error) {
      await driver?.dispose().catch(() => undefined)
      if (tunnel) {
        this.tunnels.delete(connectionId)
        await tunnel.dispose().catch(() => undefined)
      }
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
    const tunnel = this.tunnels.get(connectionId)
    this.drivers.delete(connectionId)
    this.tunnels.delete(connectionId)
    this.databases.delete(connectionId)
    await this.releaseScopes(connectionId)
    this.runtime.set(connectionId, { state: 'disconnected' })
    if (driver) await driver.dispose().catch((error: unknown) => this.deps.logger.warn(`Dispose failed: ${String(error)}`))
    if (tunnel) await tunnel.dispose().catch((error: unknown) => this.deps.logger.warn(`Tunnel close failed: ${String(error)}`))
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

  /** Same as {@link requireDriver}, but the driver must support browsing and writing rows. */
  requireEditingDriver(connectionId: string): DataEditingDriver {
    const driver = this.requireDriver(connectionId)
    if (!isDataEditingDriver(driver)) {
      throw new DataForgeError('internal', 'This connection does not support data editing yet.')
    }
    return driver
  }

  isConnected(connectionId: string): boolean {
    return this.drivers.has(connectionId)
  }

  /**
   * Driver for an explicit `(connection, database)` scope. The connection's own
   * database reuses the primary pool; any other database gets its own cached,
   * read-only pool (PostgreSQL cannot query across databases).
   */
  async requireScopedDriver(connectionId: string, database?: string): Promise<DatabaseDriver> {
    const profile = this.profile(connectionId)
    const target = database?.trim() || profile.database
    if (target === profile.database) return this.requireDriver(connectionId)
    const key = scopeKey(scopeOf(connectionId, target))
    const existing = this.scopedDrivers.get(key)
    if (existing) return existing
    const driver = this.createDriver(await this.configFor({ ...profile, database: target }))
    this.scopedDrivers.set(key, driver)
    this.deps.logger.info(`Opened scope "${target}" on "${profile.name}"`)
    return driver
  }

  /**
   * Databases the connected server exposes. Cached per connection because the
   * list changes rarely; drivers without cross-database listing see their own.
   */
  async listDatabases(connectionId: string, refresh = false): Promise<string[]> {
    const driver = this.requireDriver(connectionId)
    if (!driver.listDatabases) return [this.profile(connectionId).database]
    if (refresh) this.databases.delete(connectionId)
    const cached = this.databases.get(connectionId)
    if (cached) return cached
    const pending = driver.listDatabases().catch((error: unknown) => {
      this.databases.delete(connectionId)
      throw error
    })
    this.databases.set(connectionId, pending)
    return pending
  }

  /**
   * Points the connection at another database and reconnects. PostgreSQL needs a
   * separate backend per database, so this rebuilds the pool instead of nesting.
   */
  async switchDatabase(connectionId: string, database: string): Promise<ConnectionSummary> {
    const profile = this.profile(connectionId)
    const target = database.trim()
    if (!target) throw new DataForgeError('invalid_request', 'Pick a database first.')
    if (target === profile.database) return this.toSummary(profile)
    await this.update(connectionId, { database: target })
    const summary = await this.connect(connectionId)
    this.deps.logger.info(`Switched "${profile.name}" to database "${target}"`)
    return summary
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const drivers = [...this.drivers.values(), ...this.scopedDrivers.values()]
    const tunnels = [...this.tunnels.values()]
    this.drivers.clear()
    this.scopedDrivers.clear()
    this.tunnels.clear()
    await Promise.all(drivers.map((driver) => driver.dispose().catch(() => undefined)))
    await Promise.all(tunnels.map((tunnel) => tunnel.dispose().catch(() => undefined)))
  }

  private profile(connectionId: string): ConnectionProfile {
    const profile = this.profiles.get(connectionId)
    if (!profile) throw new DataForgeError('not_found', 'That connection no longer exists.')
    return profile
  }

  private createDriver(config: ConnectionConfig): DatabaseDriver {
    return this.deps.createDriver(config)
  }

  /** Disposes every extra pool opened for a connection (all browsed databases). */
  private async releaseScopes(connectionId: string): Promise<void> {
    const prefix = `${connectionId}\u0000`
    const keys = [...this.scopedDrivers.keys()].filter((key) => key.startsWith(prefix))
    const drivers = keys
      .map((key) => this.scopedDrivers.get(key))
      .filter((driver): driver is DatabaseDriver => driver !== undefined)
    for (const key of keys) this.scopedDrivers.delete(key)
    await Promise.all(
      drivers.map((driver) => driver.dispose().catch((error: unknown) => this.deps.logger.warn(`Scope dispose failed: ${String(error)}`))),
    )
  }

  private async configFor(profile: ConnectionProfile, fallbackPassword?: string): Promise<ConnectionConfig> {
    const credentials = await this.credentialsFor(profile, fallbackPassword)
    return { profile: this.tunnelled(profile), credentials }
  }

  private async credentialsFor(profile: ConnectionProfile, fallbackPassword = ''): Promise<ConnectionCredentials> {
    return (await this.deps.secrets.read(profile.id)) ?? { password: fallbackPassword }
  }

  /** While a tunnel is open, the driver talks to its loopback listener. */
  private tunnelled(profile: ConnectionProfile): ConnectionProfile {
    const tunnel = this.tunnels.get(profile.id)
    return tunnel ? { ...profile, host: tunnel.host, port: tunnel.port } : profile
  }

  private async openTunnel(
    profile: ConnectionProfile,
    credentials: ConnectionCredentials,
  ): Promise<ConnectionTunnel> {
    if (!profile.tunnel) throw new DataForgeError('internal', 'That connection has no SSH tunnel configured.')
    if (!this.deps.createTunnel) {
      throw new DataForgeError('internal', 'SSH tunnels are not available in this build.')
    }
    try {
      return await this.deps.createTunnel(profile, credentials)
    } catch (error) {
      throw wrapError('connection_failed', `Could not open the SSH tunnel to "${profile.tunnel.host}"`, error)
    }
  }

  /** Capability snapshot of the live driver, absent while disconnected. */
  private capabilitiesFor(connectionId: string): DriverCapabilitiesDto | undefined {
    const driver = this.drivers.get(connectionId)
    if (!driver) return undefined
    const optional = driver as Partial<DataEditingDriver> &
      Partial<TableExportDriver> &
      Partial<TransactionalDriver> &
      Partial<DdlDriver> &
      Partial<ObjectCatalogDriver>
    return {
      query: true,
      dataEditing:
        typeof optional.selectPage === 'function' &&
        typeof optional.applyMutations === 'function' &&
        typeof optional.countRows === 'function',
      exportCsv: typeof optional.exportTable === 'function',
      transactions: typeof optional.openSession === 'function',
      schemaChanges: typeof optional.applyDdl === 'function',
      objectBrowser: typeof optional.objectDdl === 'function',
      databaseList: typeof driver.listDatabases === 'function',
    }
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
    const capabilities = this.capabilitiesFor(profile.id)
    return {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      ssl: profile.ssl,
      readOnly: profile.readOnly,
      state: runtime.state,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(profile.tunnel === undefined ? {} : { tunnel: profile.tunnel }),
      ...(runtime.serverVersion === undefined ? {} : { serverVersion: runtime.serverVersion }),
      ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
    }
  }
}
