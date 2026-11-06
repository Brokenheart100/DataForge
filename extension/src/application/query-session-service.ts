import type { DatabaseDriver, DriverQueryResult, DriverSession, TransactionalDriver } from '../domain/driver'
import { DataForgeError } from '../domain/errors'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'
import { clampMaxRows } from './query-service'

/** Capability check: sessions are optional, so read-only drivers still work. */
export function isTransactionalDriver(driver: DatabaseDriver): driver is TransactionalDriver {
  return typeof (driver as Partial<TransactionalDriver>).openSession === 'function'
}

export interface QuerySessionDeps {
  readonly connections: ConnectionService
  readonly logger: Logger
  /** Fallback row cap when the webview does not ask for one. */
  readonly defaultMaxRows?: number
}

/**
 * One explicit transaction per connection, bound to a dedicated backend client.
 *
 * A session is created on demand and released by `commit`, `rollback` or
 * `rollbackAll`; nothing here touches the pool used by ordinary statements.
 */
export class QuerySessionService {
  private readonly sessions = new Map<string, DriverSession>()

  constructor(private readonly deps: QuerySessionDeps) {}

  isOpen(connectionId: string): boolean {
    return this.sessions.has(connectionId)
  }

  async begin(connectionId: string, database?: string): Promise<void> {
    if (this.sessions.has(connectionId)) {
      throw new DataForgeError('invalid_request', 'A transaction is already open on this connection.')
    }
    if (database !== undefined) {
      const profile = this.deps.connections.get(connectionId)
      if (database !== profile.database) {
        throw new DataForgeError(
          'invalid_request',
          `Transactions run on the connection's own database. Switch the connection to "${database}" first.`,
        )
      }
    }
    const driver = this.deps.connections.requireDriver(connectionId)
    if (!isTransactionalDriver(driver)) {
      throw new DataForgeError('internal', 'This connection does not support transactions yet.')
    }
    const session = await driver.openSession()
    this.sessions.set(connectionId, session)
    this.deps.logger.info(`Transaction opened on ${this.nameOf(connectionId)}`)
  }

  async run(connectionId: string, sql: string, requestedRows?: number): Promise<DriverQueryResult> {
    const session = this.require(connectionId)
    return session.query({ sql, maxRows: clampMaxRows(requestedRows, this.deps.defaultMaxRows ?? 500) })
  }

  async commit(connectionId: string): Promise<void> {
    const session = this.require(connectionId)
    this.sessions.delete(connectionId)
    try {
      await session.commit()
      this.deps.logger.info(`Transaction committed on ${this.nameOf(connectionId)}`)
    } catch (error) {
      this.deps.logger.error(`Commit failed on ${this.nameOf(connectionId)}`, error)
      throw error
    }
  }

  async rollback(connectionId: string): Promise<void> {
    const session = this.require(connectionId)
    this.sessions.delete(connectionId)
    try {
      await session.rollback()
      this.deps.logger.info(`Transaction rolled back on ${this.nameOf(connectionId)}`)
    } catch (error) {
      this.deps.logger.error(`Rollback failed on ${this.nameOf(connectionId)}`, error)
      throw error
    }
  }

  /** Rolls back every open session; used when the workbench closes or the extension stops. */
  async rollbackAll(): Promise<void> {
    const entries = [...this.sessions.entries()]
    this.sessions.clear()
    for (const [connectionId, session] of entries) {
      try {
        await session.close()
        this.deps.logger.info(`Rolled back the leftover transaction on ${this.nameOf(connectionId)}`)
      } catch (error) {
        this.deps.logger.error(`Could not roll back the leftover transaction on ${this.nameOf(connectionId)}`, error)
      }
    }
  }

  private require(connectionId: string): DriverSession {
    const session = this.sessions.get(connectionId)
    if (!session) throw new DataForgeError('not_found', 'No transaction is open on this connection.')
    return session
  }

  private nameOf(connectionId: string): string {
    return this.deps.connections.list().find((item) => item.id === connectionId)?.name ?? connectionId
  }
}
