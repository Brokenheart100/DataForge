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

interface SessionRecord {
  readonly session: DriverSession
  readonly connectionId: string
}

/**
 * One explicit transaction per console (or per connection when no console id is
 * given), bound to a dedicated backend client.
 *
 * A session is released by `commit`, `rollback`, `rollbackConsole` or
 * `rollbackAll`; nothing here touches the pool used by ordinary statements.
 */
export class QuerySessionService {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(private readonly deps: QuerySessionDeps) {}

  isOpen(connectionId: string, consoleId?: string): boolean {
    return this.sessions.has(this.keyOf(connectionId, consoleId))
  }

  async begin(connectionId: string, database?: string, consoleId?: string): Promise<void> {
    const key = this.keyOf(connectionId, consoleId)
    if (this.sessions.has(key)) {
      throw new DataForgeError(
        'invalid_request',
        consoleId ? 'A transaction is already open in this console.' : 'A transaction is already open on this connection.',
      )
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
    this.sessions.set(key, { session, connectionId })
    this.deps.logger.info(`Transaction opened on ${this.nameOf(connectionId)}`)
  }

  async run(
    connectionId: string,
    sql: string,
    requestedRows?: number,
    consoleId?: string,
  ): Promise<DriverQueryResult> {
    const { session } = this.require(this.keyOf(connectionId, consoleId))
    return session.query({ sql, maxRows: clampMaxRows(requestedRows, this.deps.defaultMaxRows ?? 500) })
  }

  async commit(connectionId: string, consoleId?: string): Promise<void> {
    const key = this.keyOf(connectionId, consoleId)
    const { session } = this.require(key)
    this.sessions.delete(key)
    try {
      await session.commit()
      this.deps.logger.info(`Transaction committed on ${this.nameOf(connectionId)}`)
    } catch (error) {
      this.deps.logger.error(`Commit failed on ${this.nameOf(connectionId)}`, error)
      throw error
    }
  }

  /**
   * Without a console id this closes every session of the connection, so a
   * disconnect still rolls back transactions left by several consoles.
   */
  async rollback(connectionId: string, consoleId?: string): Promise<void> {
    const keys = consoleId
      ? [this.keyOf(connectionId, consoleId)]
      : [...this.sessions.entries()]
          .filter(([, record]) => record.connectionId === connectionId)
          .map(([key]) => key)
    if (keys.length === 0 && !consoleId) {
      throw new DataForgeError('not_found', 'No transaction is open on this connection.')
    }
    for (const key of keys) {
      const record = this.sessions.get(key)
      if (!record) {
        if (consoleId) throw new DataForgeError('not_found', 'No transaction is open in this console.')
        continue
      }
      this.sessions.delete(key)
      try {
        await record.session.rollback()
        this.deps.logger.info(`Transaction rolled back on ${this.nameOf(connectionId)}`)
      } catch (error) {
        this.deps.logger.error(`Rollback failed on ${this.nameOf(connectionId)}`, error)
        throw error
      }
    }
  }

  /** Rolls back the session owned by one console; used when that console closes. */
  async rollbackConsole(consoleId: string): Promise<void> {
    const record = this.sessions.get(consoleId)
    if (!record) return
    this.sessions.delete(consoleId)
    try {
      await record.session.close()
      this.deps.logger.info(`Rolled back the transaction of a closed console on ${this.nameOf(record.connectionId)}`)
    } catch (error) {
      this.deps.logger.error(`Could not roll back the transaction of a closed console`, error)
    }
  }

  /** Rolls back every open session; used when the workbench closes or the extension stops. */
  async rollbackAll(): Promise<void> {
    const entries = [...this.sessions.entries()]
    this.sessions.clear()
    for (const [, record] of entries) {
      try {
        await record.session.close()
        this.deps.logger.info(`Rolled back the leftover transaction on ${this.nameOf(record.connectionId)}`)
      } catch (error) {
        this.deps.logger.error(
          `Could not roll back the leftover transaction on ${this.nameOf(record.connectionId)}`,
          error,
        )
      }
    }
  }

  private keyOf(connectionId: string, consoleId?: string): string {
    return consoleId ?? connectionId
  }

  private require(key: string): SessionRecord {
    const record = this.sessions.get(key)
    if (!record) throw new DataForgeError('not_found', 'No transaction is open on this connection.')
    return record
  }

  private nameOf(connectionId: string): string {
    return this.deps.connections.list().find((item) => item.id === connectionId)?.name ?? connectionId
  }
}
