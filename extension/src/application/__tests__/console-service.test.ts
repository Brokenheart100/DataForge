import { describe, expect, it, vi } from 'vitest'

import { ConnectionService } from '../connection-service'
import { ConsoleService } from '../console-service'
import { QueryService } from '../query-service'
import type { QuerySessionService } from '../query-session-service'
import type { Logger } from '../ports'
import type { ConnectionConfig } from '../../domain/connection'
import type { ConnectionDraft } from '@shared/protocol'
import { DataForgeError } from '../../domain/errors'
import type {
  ColumnInfo,
  DatabaseDriver,
  DriverQueryInput,
  DriverQueryResult,
  RelationInfo,
} from '../../domain/driver'
import { MemoryConnectionStore, MemorySecretStore } from '../../test/memory-stores'

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

class HangingDriver implements DatabaseDriver {
  readonly kind = 'postgresql' as const
  async testConnection() {
    return { serverVersion: 'PostgreSQL 17', database: 'forge', user: 'postgres' }
  }
  async query(input: DriverQueryInput): Promise<DriverQueryResult> {
    if (!input.sql.includes('sleep')) {
      return { columns: [], rows: [[1]], command: 'SELECT', durationMs: 1, truncated: false, affectedRows: null }
    }
    return new Promise((_, reject) => {
      const abort = (): void => reject(new DataForgeError('cancelled', 'Query was cancelled.'))
      if (input.signal?.aborted) {
        abort()
        return
      }
      input.signal?.addEventListener('abort', abort)
    })
  }
  async listSchemas(): Promise<string[]> {
    return ['public']
  }
  async listRelations(): Promise<RelationInfo[]> {
    return []
  }
  async listColumns(): Promise<ColumnInfo[]> {
    return []
  }
  async dispose(): Promise<void> {
    return undefined
  }
}

const DRAFT: ConnectionDraft = {
  name: 'local',
  host: 'localhost',
  port: 5432,
  database: 'forge',
  user: 'postgres',
  password: 'secret',
  ssl: 'disable',
  readOnly: false,
}

async function setup() {
  const connections = new ConnectionService({
    store: new MemoryConnectionStore(),
    secrets: new MemorySecretStore(),
    createDriver: (_config: ConnectionConfig) => new HangingDriver(),
    logger,
  })
  await connections.initialize()
  const summary = await connections.create(DRAFT)
  await connections.connect(summary.id)
  const queries = new QueryService(connections, { logger, defaultMaxRows: 100 })
  const rollbackConsole = vi.fn<() => Promise<void>>(async () => undefined)
  const sessions = { rollbackConsole } as unknown as QuerySessionService
  const consoles = new ConsoleService({ connections, queries, sessions, logger })
  return { connections, queries, consoles, rollbackConsole, connectionId: summary.id }
}

describe('ConsoleService', () => {
  it('opens consoles per connection and lists them', async () => {
    const { consoles, connectionId } = await setup()
    const first = consoles.open(connectionId)
    const second = consoles.open(connectionId, 'analytics', 'Analytics')
    expect(first.database).toBe('forge')
    expect(second).toMatchObject({ connectionId, database: 'analytics', title: 'Analytics' })
    expect(consoles.list(connectionId)).toHaveLength(2)
    expect(consoles.openCount).toBe(2)
    expect(consoles.copy(first.id).title).toBe(`${first.title} copy`)
  })

  it('rejects unknown consoles and connections', async () => {
    const { consoles } = await setup()
    expect(() => consoles.open('missing')).toThrowError(DataForgeError)
    expect(() => consoles.require('missing')).toThrowError(/not open any more/)
  })

  it('cancels the console query and rolls back its transaction on close', async () => {
    const { consoles, queries, rollbackConsole, connectionId } = await setup()
    const console = consoles.open(connectionId)
    consoles.registerRun(console.id, 'req-hanging')
    const running = queries.execute('req-hanging', {
      connectionId,
      sql: 'select sleep(10)',
      maxRows: 10,
      consoleId: console.id,
    })
    await consoles.close(console.id)
    await expect(running).rejects.toMatchObject({ code: 'cancelled' })
    expect(rollbackConsole).toHaveBeenCalledWith(console.id)
    expect(queries.runningCount).toBe(0)
    expect(() => consoles.require(console.id)).toThrowError(/not open any more/)
  })

  it('keeps other consoles running when one closes', async () => {
    const { consoles, queries, connectionId } = await setup()
    const first = consoles.open(connectionId)
    const second = consoles.open(connectionId)
    consoles.registerRun(first.id, 'req-first')
    consoles.registerRun(second.id, 'req-second')
    const pendingFirst = queries.execute('req-first', {
      connectionId,
      sql: 'select sleep(10)',
      maxRows: 10,
      consoleId: first.id,
    })
    await consoles.close(first.id)
    await expect(pendingFirst).rejects.toMatchObject({ code: 'cancelled' })
    expect(queries.runningCount).toBe(0)
    await expect(
      queries.execute('req-second', { connectionId, sql: 'select 1', maxRows: 10, consoleId: second.id }),
    ).resolves.toMatchObject({ command: 'SELECT' })
  })
})
