import { describe, expect, it } from 'vitest'

import type {
  ColumnInfo,
  DatabaseDriver,
  DriverQueryResult,
  DriverSession,
  RelationInfo,
  ServerInfo,
  TransactionalDriver,
} from '../../domain/driver'
import { QuerySessionService } from '../query-session-service'

const RESULT: DriverQueryResult = {
  columns: [{ name: 'answer', dataType: 'int4' }],
  rows: [[42]],
  command: 'SELECT',
  durationMs: 2,
  truncated: false,
  affectedRows: null,
}

class FakeSession implements DriverSession {
  readonly queries: string[] = []
  readonly calls: string[] = []

  async query(input: { sql: string }): Promise<DriverQueryResult> {
    this.queries.push(input.sql)
    return RESULT
  }

  async commit(): Promise<void> {
    this.calls.push('commit')
  }

  async rollback(): Promise<void> {
    this.calls.push('rollback')
  }

  async close(): Promise<void> {
    this.calls.push('close')
  }
}

class FakeDriver implements TransactionalDriver {
  readonly kind = 'postgresql'
  readonly session = new FakeSession()

  async openSession(): Promise<DriverSession> {
    return this.session
  }

  async testConnection(): Promise<ServerInfo> {
    return { serverVersion: 'PostgreSQL 17', database: 'forge', user: 'postgres' }
  }

  async query(): Promise<DriverQueryResult> {
    return RESULT
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

interface LoggerSpy {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string, error?: unknown) => void
  infos: string[]
  errors: string[]
}

function setup(driver: DatabaseDriver = new FakeDriver()) {
  const logger: LoggerSpy = {
    infos: [],
    errors: [],
    info: (message) => logger.infos.push(message),
    warn: () => undefined,
    error: (message) => logger.errors.push(message),
  }
  const connections = {
    requireDriver: () => driver,
    get: () => ({ id: 'c1', name: 'local', database: 'forge' }),
    list: () => [{ id: 'c1', name: 'local' }],
  }
  const service = new QuerySessionService({ connections: connections as never, logger })
  return { service, logger, driver }
}

describe('QuerySessionService', () => {
  it('opens one session per connection', async () => {
    const { service, logger } = setup()
    expect(service.isOpen('c1')).toBe(false)
    await service.begin('c1')
    expect(service.isOpen('c1')).toBe(true)
    expect(logger.infos[0]).toBe('Transaction opened on local')
  })

  it('rejects a second begin on the same connection', async () => {
    const { service } = setup()
    await service.begin('c1')
    await expect(service.begin('c1')).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('runs statements through the session client', async () => {
    const { service, driver } = setup()
    await service.begin('c1')
    const result = await service.run('c1', 'insert into t values (1)', 10)
    expect(result.rows[0]).toEqual([42])
    expect((driver as FakeDriver).session.queries).toEqual(['insert into t values (1)'])
  })

  it('rejects statements without an open session', async () => {
    const { service } = setup()
    await expect(service.run('c1', 'select 1', 10)).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.commit('c1')).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.rollback('c1')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('commits and forgets the session', async () => {
    const { service, driver } = setup()
    await service.begin('c1')
    await service.commit('c1')
    expect((driver as FakeDriver).session.calls).toEqual(['commit'])
    expect(service.isOpen('c1')).toBe(false)
  })

  it('rolls back on request', async () => {
    const { service, driver } = setup()
    await service.begin('c1')
    await service.rollback('c1')
    expect((driver as FakeDriver).session.calls).toEqual(['rollback'])
    expect(service.isOpen('c1')).toBe(false)
  })

  it('closes every leftover session when the workbench goes away', async () => {
    const { service, driver } = setup()
    await service.begin('c1')
    await service.rollbackAll()
    expect((driver as FakeDriver).session.calls).toEqual(['close'])
    expect(service.isOpen('c1')).toBe(false)
  })

  it('logs a rollback failure without throwing', async () => {
    const driver = new FakeDriver()
    driver.session.close = async () => {
      throw new Error('socket gone')
    }
    const { service, logger } = setup(driver)
    await service.begin('c1')
    await expect(service.rollbackAll()).resolves.toBeUndefined()
    expect(logger.errors[0]).toContain('Could not roll back')
  })

  it('rejects drivers without transaction support', async () => {
    const plain: DatabaseDriver = new FakeDriver()
    const { service } = setup({ ...plain, openSession: undefined } as unknown as DatabaseDriver)
    await expect(service.begin('c1')).rejects.toMatchObject({ code: 'internal' })
  })
})
