import { describe, expect, it } from 'vitest'

import type { ConnectionDraft } from '@shared/protocol'

import type { ConnectionCredentials, ConnectionProfile } from '../../domain/connection'
import type { ColumnInfo, DatabaseDriver, DriverQueryInput, DriverQueryResult, RelationInfo, ServerInfo } from '../../domain/driver'
import { DataForgeError } from '../../domain/errors'
import { MessageRouter } from '../../presentation/message-router'
import { ConnectionService } from '../connection-service'
import type { ConnectionStore, DriverFactory, Logger, SecretStore } from '../ports'
import { QueryService } from '../query-service'

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const draft: ConnectionDraft = {
  name: 'local forge',
  host: 'localhost',
  port: 5432,
  database: 'forge',
  user: 'postgres',
  password: 's3cret',
  ssl: 'disable',
  readOnly: false,
}

class MemoryStore implements ConnectionStore {
  saved: ConnectionProfile[] = []
  async load(): Promise<ConnectionProfile[]> {
    return this.saved.map((profile) => ({ ...profile }))
  }
  async save(profiles: readonly ConnectionProfile[]): Promise<void> {
    this.saved = profiles.map((profile) => ({ ...profile }))
  }
}

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, ConnectionCredentials>()
  async read(connectionId: string): Promise<ConnectionCredentials | undefined> {
    return this.values.get(connectionId)
  }
  async write(connectionId: string, credentials: ConnectionCredentials): Promise<void> {
    this.values.set(connectionId, credentials)
  }
  async delete(connectionId: string): Promise<void> {
    this.values.delete(connectionId)
  }
}

class FakeDriver implements DatabaseDriver {
  readonly kind = 'postgresql'
  readonly queries: string[] = []
  disposed = false
  maxRowsSeen: number | undefined

  async testConnection(): Promise<ServerInfo> {
    return { serverVersion: 'PostgreSQL 17.0', database: 'forge', user: 'postgres' }
  }

  async query(input: DriverQueryInput): Promise<DriverQueryResult> {
    this.queries.push(input.sql)
    this.maxRowsSeen = input.maxRows
    if (input.sql.includes('pg_sleep')) {
      return new Promise<DriverQueryResult>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new DataForgeError('cancelled', 'Query was cancelled.')))
      })
    }
    return {
      columns: [{ name: 'answer', dataType: 'int4' }],
      rows: [[42]],
      command: 'SELECT',
      durationMs: 3,
      truncated: false,
      affectedRows: null,
    }
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
    this.disposed = true
  }
}

function createService(options: { readOnly?: boolean } = {}) {
  const store = new MemoryStore()
  const secrets = new MemorySecrets()
  const drivers: FakeDriver[] = []
  const configs: string[] = []
  const createDriver: DriverFactory = (config) => {
    configs.push(`${config.profile.user}@${config.profile.host}:${config.profile.port}/${config.profile.database}`)
    const driver = new FakeDriver()
    drivers.push(driver)
    return driver
  }
  const connections = new ConnectionService({ store, secrets, createDriver, logger })
  const queries = new QueryService(connections, { logger, defaultMaxRows: 500 })
  const router = new MessageRouter({ connections, queries, logger })
  return { store, secrets, drivers, configs, connections, queries, router, readOnly: options.readOnly }
}

async function connectedService(readOnly = false) {
  const harness = createService()
  await harness.connections.initialize()
  const summary = await harness.connections.create({ ...draft, readOnly })
  await harness.connections.connect(summary.id)
  return { ...harness, id: summary.id }
}

describe('ConnectionService', () => {
  it('persists the profile but keeps the password in the secret store only', async () => {
    const harness = createService()
    await harness.connections.initialize()

    const summary = await harness.connections.create({ ...draft, name: 'Analytics' })

    expect(summary.state).toBe('disconnected')
    expect(summary).not.toHaveProperty('password')
    expect(harness.store.saved[0]).not.toHaveProperty('password')
    expect(harness.secrets.values.get(summary.id)).toEqual({ password: 's3cret' })
  })

  it('refuses duplicate names case-insensitively', async () => {
    const harness = createService()
    await harness.connections.initialize()
    await harness.connections.create(draft)

    await expect(harness.connections.create({ ...draft, name: '  LOCAL FORGE ' })).rejects.toMatchObject({
      code: 'invalid_request',
    })
  })

  it('drops the saved password when the connection is deleted', async () => {
    const harness = createService()
    await harness.connections.initialize()
    const summary = await harness.connections.create(draft)

    await harness.connections.delete(summary.id)

    expect(await harness.connections.list()).toEqual([])
    expect(harness.secrets.values.size).toBe(0)
  })

  it('disposes the pool when the connection is updated', async () => {
    const harness = await connectedService()
    const driver = harness.drivers[0]
    expect(driver?.disposed).toBe(false)

    const updated = await harness.connections.update(harness.id, { host: 'db.internal' })

    expect(driver?.disposed).toBe(true)
    expect(updated.state).toBe('disconnected')
    expect(updated.host).toBe('db.internal')
  })
})

describe('QueryService', () => {
  it('returns rows through the connection driver', async () => {
    const harness = await connectedService()

    const result = await harness.queries.execute('req-1', { connectionId: harness.id, sql: 'select 42', maxRows: 10 })

    expect(result).toMatchObject({ rowCount: 1, command: 'SELECT', truncated: false })
    expect(result.rows[0]).toEqual([42])
    expect(harness.drivers[0]?.queries).toEqual(['select 42'])
  })

  it('caps the requested row count', async () => {
    const harness = await connectedService()

    await harness.queries.execute('req-1', { connectionId: harness.id, sql: 'select 1', maxRows: 99_999 })

    expect(harness.drivers[0]?.maxRowsSeen).toBe(10_000)
  })

  it('blocks writes on read-only connections before they reach PostgreSQL', async () => {
    const harness = await connectedService(true)

    await expect(
      harness.queries.execute('req-1', { connectionId: harness.id, sql: 'delete from public.customers', maxRows: 10 }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(harness.drivers[0]?.queries).toEqual([])
  })

  it('cancels a running statement and reports it as cancelled', async () => {
    const harness = await connectedService()

    const running = harness.queries.execute('req-cancel', { connectionId: harness.id, sql: 'select pg_sleep(10)', maxRows: 10 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await harness.queries.cancel('req-cancel')

    await expect(running).rejects.toMatchObject({ code: 'cancelled' })
    expect(harness.queries.runningCount).toBe(0)
  })
})

describe('MessageRouter', () => {
  function failureOf(response: Awaited<ReturnType<MessageRouter['handle']>>): { code: string; message: string } {
    if (!response || !('error' in response)) throw new Error('expected an error response')
    return response.error
  }

  it('answers a well-formed request', async () => {
    const harness = createService()
    await harness.connections.initialize()

    const response = await harness.router.handle({ kind: 'request', id: 'r1', type: 'connection.list', payload: null })

    expect(response).toMatchObject({ kind: 'response', id: 'r1', ok: true, data: [] })
  })

  it('rejects a payload that fails schema validation', async () => {
    const harness = createService()
    await harness.connections.initialize()

    const response = await harness.router.handle({ kind: 'request', id: 'r2', type: 'connection.list', payload: { extra: true } })

    expect(response).toMatchObject({ kind: 'response', id: 'r2', ok: false })
    const error = failureOf(response)
    expect(error.code).toBe('invalid_request')
    expect(error.message).toContain('payload')
  })

  it('rejects unknown request types without crashing', async () => {
    const harness = createService()
    await harness.connections.initialize()

    const response = await harness.router.handle({ kind: 'request', id: 'r3', type: 'db.drop_everything', payload: null })

    expect(response).toMatchObject({ kind: 'response', id: 'r3', ok: false })
  })

  it('fails a query against a missing connection with a domain error', async () => {
    const harness = createService()
    await harness.connections.initialize()

    const response = await harness.router.handle({
      kind: 'request',
      id: 'r4',
      type: 'query.execute',
      payload: { connectionId: 'nope', sql: 'select 1', maxRows: 10 },
    })

    expect(response).toMatchObject({ kind: 'response', id: 'r4', ok: false })
    expect(failureOf(response).code).toBe('not_found')
  })
})
