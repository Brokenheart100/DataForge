import { describe, expect, it } from 'vitest'

import type { ConnectionDraft, DataCommitResult, DataPageDto } from '@shared/protocol'

import type { ConnectionCredentials, ConnectionProfile } from '../../domain/connection'
import { DataConflictError } from '../../domain/errors'
import type {
  ColumnInfo,
  DataEditingDriver,
  DataRow,
  DriverCapabilities,
  DriverPageInput,
  DriverPageResult,
  DriverQueryInput,
  DriverQueryResult,
  MutationBatch,
  MutationResult,
  RelationInfo,
  ServerInfo,
} from '../../domain/driver'
import { ConnectionService } from '../connection-service'
import { DataEditorService } from '../data-editor-service'
import { ExportService } from '../export-service'
import type { CommitRow } from '../data-editor-service'
import type { ConnectionStore, Logger, SecretStore } from '../ports'
import { QueryService } from '../query-service'
import { SchemaService } from '../schema-service'
import { MessageRouter } from '../../presentation/message-router'

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

const ordersColumns: ColumnInfo[] = [
  { name: 'id', dataType: 'integer', nullable: false, defaultValue: "nextval('orders_id_seq'::regclass)", isPrimaryKey: true, ordinal: 1 },
  { name: 'name', dataType: 'character varying(10)', nullable: false, defaultValue: null, isPrimaryKey: false, ordinal: 2 },
  { name: 'price', dataType: 'numeric(10,2)', nullable: true, defaultValue: null, isPrimaryKey: false, ordinal: 3 },
]

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

class FakeEditingDriver implements DataEditingDriver {
  readonly kind = 'postgresql'
  readonly capabilities: DriverCapabilities = { transactions: true, returning: true, identifierQuote: '"' }
  readonly mutationBatches: MutationBatch[] = []
  readonly pageRequests: DriverPageInput[] = []
  relations: RelationInfo[] = [{ schema: 'public', name: 'orders', kind: 'table' }]
  columns: ColumnInfo[] = ordersColumns
  rows: DataRow[] = [{ values: [1, 'one', null], identity: { id: 1 }, version: '42' }]
  conflict: string[] | undefined
  disposed = false

  async testConnection(): Promise<ServerInfo> {
    return { serverVersion: 'PostgreSQL 17.0', database: 'forge', user: 'postgres' }
  }

  async query(_input: DriverQueryInput): Promise<DriverQueryResult> {
    return { columns: [], rows: [], command: 'SELECT', durationMs: 1, truncated: false, affectedRows: null }
  }

  async listSchemas(): Promise<string[]> {
    return ['public']
  }

  async listRelations(_schema: string): Promise<RelationInfo[]> {
    return [...this.relations]
  }

  async listColumns(_schema: string, _relation: string): Promise<ColumnInfo[]> {
    return [...this.columns]
  }

  async selectPage(input: DriverPageInput): Promise<DriverPageResult> {
    this.pageRequests.push(input)
    return { rows: this.rows, totalRows: 12 }
  }

  async countRows(): Promise<number> {
    return 12
  }

  async applyMutations(batch: MutationBatch): Promise<readonly MutationResult[]> {
    this.mutationBatches.push(batch)
    if (this.conflict) throw new DataConflictError(this.conflict)
    return batch.mutations.map((mutation) => ({
      rowCount: 1,
      returned: mutation.kind === 'insert' ? [99] : null,
    }))
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

async function setup(options: { readOnly?: boolean; driver?: FakeEditingDriver } = {}) {
  const driver = options.driver ?? new FakeEditingDriver()
  const connections = new ConnectionService({
    store: new MemoryStore(),
    secrets: new MemorySecrets(),
    createDriver: () => driver,
    logger,
  })
  await connections.initialize()
  const profile = await connections.create({ ...draft, readOnly: options.readOnly ?? false })
  await connections.connect(profile.id)
  const schemas = new SchemaService(connections, logger)
  const editor = new DataEditorService({ connections, schemas, logger })
  return { driver, connections, editor, connectionId: profile.id }
}

function insertRow(values: Record<string, string | number | boolean | null>): CommitRow {
  return { rowId: 'new', version: null, change: { kind: 'insert', values } }
}

describe('DataEditorService.loadPage', () => {
  it('loads a page with primary-key identity and the total count', async () => {
    const { editor, driver, connectionId } = await setup()
    const page = await editor.loadPage({
      connectionId,
      schema: 'public',
      relation: 'orders',
      limit: 50,
      offset: 100,
      orderBy: [{ column: 'id', direction: 'desc' }],
    })

    expect(page.editable).toBe(true)
    expect(page.primaryKey).toEqual(['id'])
    expect(page.rows[0]?.version).toBe('42')
    expect(page.totalRows).toBe(12)
    expect(driver.pageRequests[0]).toMatchObject({
      columns: ['id', 'name', 'price'],
      identityColumns: ['id'],
      limit: 50,
      offset: 100,
      orderBy: [{ column: 'id', direction: 'desc' }],
    })
  })

  it('passes server-side filters to the driver', async () => {
    const { editor, driver, connectionId } = await setup()
    await editor.loadPage({
      connectionId,
      schema: 'public',
      relation: 'orders',
      limit: 20,
      offset: 0,
      filters: [{ column: 'name', operator: 'contains', value: 'acme' }],
    })
    expect(driver.pageRequests[0]?.filters).toEqual([{ column: 'name', operator: 'contains', value: 'acme' }])
  })

  it('marks a view as read-only but still returns its rows', async () => {
    const { editor, driver, connectionId } = await setup()
    driver.relations = [{ schema: 'public', name: 'orders', kind: 'view' }]

    const page = await editor.loadPage({ connectionId, schema: 'public', relation: 'orders', limit: 20, offset: 0 })
    expect(page.editable).toBe(false)
    expect(page.readOnlyReason).toContain('cannot be edited')
    expect(page.rows).toHaveLength(1)
  })

  it('marks a table without a primary key as read-only', async () => {
    const { editor, driver, connectionId } = await setup()
    driver.columns = ordersColumns.filter((column) => !column.isPrimaryKey)

    const page = await editor.loadPage({ connectionId, schema: 'public', relation: 'orders', limit: 20, offset: 0 })
    expect(page.editable).toBe(false)
    expect(page.readOnlyReason).toContain('no primary key')
  })

  it('rejects an unknown relation', async () => {
    const { editor, connectionId } = await setup()
    await expect(
      editor.loadPage({ connectionId, schema: 'public', relation: 'gone', limit: 20, offset: 0 }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('DataEditorService.validateChanges', () => {
  it('accepts a complete insert', async () => {
    const { editor } = await setup()
    expect(editor.validateChanges(ordersColumns, [insertRow({ name: 'four' })])).toEqual([])
  })

  it('requires a value for a NOT NULL column without a default', async () => {
    const { editor } = await setup()
    const issues = editor.validateChanges(ordersColumns, [insertRow({ price: 3 })])
    expect(issues).toContainEqual({ rowId: 'new', column: 'name', message: 'Column "name" is required.' })
  })

  it('rejects NULL, over-long text, bad numbers, booleans, UUIDs and JSON', async () => {
    const { editor } = await setup()
    const columns: ColumnInfo[] = [
      ...ordersColumns,
      { name: 'flag', dataType: 'boolean', nullable: true, defaultValue: null, isPrimaryKey: false, ordinal: 4 },
      { name: 'key', dataType: 'uuid', nullable: true, defaultValue: null, isPrimaryKey: false, ordinal: 5 },
      { name: 'payload', dataType: 'jsonb', nullable: true, defaultValue: null, isPrimaryKey: false, ordinal: 6 },
    ]
    const issues = editor.validateChanges(columns, [
      insertRow({
        name: 'x'.repeat(11),
        price: 'abc',
        flag: 'maybe',
        key: 'not-a-uuid',
        payload: '{broken',
      }),
    ])

    expect(issues.map((issue) => issue.column).sort()).toEqual(['flag', 'key', 'name', 'payload', 'price'])
    expect(issues.find((issue) => issue.column === 'name')?.message).toContain('at most 10 characters')
  })

  it('rejects a NULL in a NOT NULL column and an unknown column', async () => {
    const { editor } = await setup()
    const issues = editor.validateChanges(ordersColumns, [insertRow({ name: null, unknown: 1 })])
    expect(issues.some((issue) => issue.column === 'name' && issue.message.includes('does not allow NULL'))).toBe(true)
    expect(issues.some((issue) => issue.column === 'unknown' && issue.message.includes('does not exist'))).toBe(true)
  })

  it('rejects an update without a full primary key or without values', async () => {
    const { editor } = await setup()
    const rows: CommitRow[] = [
      { rowId: 'a', version: '1', change: { kind: 'update', identity: {}, values: { name: 'x' } } },
      { rowId: 'b', version: '2', change: { kind: 'update', identity: { id: 2 }, values: {} } },
    ]
    const issues = editor.validateChanges(ordersColumns, rows)
    expect(issues.some((issue) => issue.rowId === 'a' && issue.message.includes('missing the primary key'))).toBe(true)
    expect(issues.some((issue) => issue.rowId === 'b' && issue.message.includes('no values'))).toBe(true)
  })
})

describe('DataEditorService.commit', () => {
  it('applies inserts, updates and deletes as one mutation batch', async () => {
    const { editor, driver, connectionId } = await setup()
    const rows: CommitRow[] = [
      insertRow({ name: 'four' }),
      { rowId: 'r1', version: '42', change: { kind: 'update', identity: { id: 1 }, values: { name: 'one-edited' } } },
      { rowId: 'r2', version: '43', change: { kind: 'delete', identity: { id: 2 } } },
    ]

    const result = await editor.commit({ connectionId, schema: 'public', relation: 'orders', rows })
    expect(result).toEqual({ inserted: 1, updated: 1, deleted: 1, returnedKeys: [[99]] })

    const batch = driver.mutationBatches[0]
    expect(batch?.mutations).toHaveLength(3)
    expect(batch?.mutations[0]).toMatchObject({ kind: 'insert', returning: ['id'], version: null })
    expect(batch?.mutations[1]).toMatchObject({
      kind: 'update',
      version: '42',
      identity: [{ column: 'id', value: 1 }],
      values: [{ column: 'name', value: 'one-edited' }],
    })
    expect(batch?.mutations[2]).toMatchObject({ kind: 'delete', version: '43', identity: [{ column: 'id', value: 2 }] })
  })

  it('rejects a read-only connection before touching the driver', async () => {
    const { editor, driver, connectionId } = await setup({ readOnly: true })
    await expect(
      editor.commit({ connectionId, schema: 'public', relation: 'orders', rows: [insertRow({ name: 'x' })] }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(driver.mutationBatches).toHaveLength(0)
  })

  it('rejects invalid changes before touching the driver', async () => {
    const { editor, driver, connectionId } = await setup()
    await expect(
      editor.commit({ connectionId, schema: 'public', relation: 'orders', rows: [insertRow({ name: 'x'.repeat(11) })] }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(driver.mutationBatches).toHaveLength(0)
  })

  it('refuses to commit to a view', async () => {
    const { editor, driver, connectionId } = await setup()
    driver.relations = [{ schema: 'public', name: 'orders', kind: 'view' }]
    await expect(
      editor.commit({ connectionId, schema: 'public', relation: 'orders', rows: [insertRow({ name: 'x' })] }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('passes a conflict through untouched', async () => {
    const { editor, driver, connectionId } = await setup()
    driver.conflict = ['id=9']
    await expect(
      editor.commit({
        connectionId,
        schema: 'public',
        relation: 'orders',
        rows: [{ rowId: 'r9', version: '7', change: { kind: 'delete', identity: { id: 9 } } }],
      }),
    ).rejects.toMatchObject({ code: 'conflict', keys: ['id=9'] })
  })
})

describe('MessageRouter data requests', () => {
  async function routerFor(options: { pickExportPath?: (name: string) => Promise<string | undefined>; exporter?: ExportService } = {}) {
    const { editor, connections, connectionId, driver } = await setup()
    const queries = new QueryService(connections, { logger, defaultMaxRows: 500 })
    const schemas = new SchemaService(connections, logger)
    const exporter = options.exporter ?? new ExportService({ connections, schemas, logger })
    const router = new MessageRouter({
      connections,
      queries,
      dataEditor: editor,
      exporter,
      pickExportPath: options.pickExportPath ?? (async () => undefined),
      logger,
    })
    return { router, connectionId, driver }
  }

  function request(type: string, id: string, payload: unknown) {
    return { kind: 'request', id, type, payload }
  }

  it('answers data.page with plain DTOs', async () => {
    const { router, connectionId } = await routerFor()
    const response = await router.handle(
      request('data.page', 'req-1', { connectionId, schema: 'public', relation: 'orders', limit: 20, offset: 0, orderBy: [] }),
    )
    if (!response || !('ok' in response) || !response.ok) throw new Error('Expected a successful response')

    const page = response.data as DataPageDto
    expect(page).toMatchObject({ totalRows: 12, primaryKey: ['id'], editable: true })
    expect(page.rows[0]).toMatchObject({ identity: { id: 1 }, version: '42' })
    expect(page.columns[0]?.name).toBe('id')
  })

  it('rejects a page size above the protocol limit', async () => {
    const { router, connectionId } = await routerFor()
    const response = await router.handle(
      request('data.page', 'req-2', { connectionId, schema: 'public', relation: 'orders', limit: 5_000, offset: 0, orderBy: [] }),
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  })

  it('answers data.commit with counts and returned keys', async () => {
    const { router, connectionId } = await routerFor()
    const response = await router.handle(
      request('data.commit', 'req-3', {
        connectionId,
        schema: 'public',
        relation: 'orders',
        changes: [{ rowId: 'new', version: null, change: { kind: 'insert', values: { name: 'four' } } }],
      }),
    )
    if (!response || !('ok' in response) || !response.ok) throw new Error('Expected a successful response')

    const result = response.data as DataCommitResult
    expect(result).toEqual({ inserted: 1, updated: 0, deleted: 0, returnedKeys: [[99]] })
  })

  it('reports conflicting keys on a stale commit', async () => {
    const { router, connectionId, driver } = await routerFor()
    driver.conflict = ['id=9']
    const response = await router.handle(
      request('data.commit', 'req-4', {
        connectionId,
        schema: 'public',
        relation: 'orders',
        changes: [{ rowId: 'r9', version: '7', change: { kind: 'delete', identity: { id: 9 } } }],
      }),
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'conflict', conflictingKeys: ['id=9'] } })
  })

  it('answers data.export with the saved path', async () => {
    const picked: string[] = []
    const exporter = {
      exportTable: async () => ({ path: '/tmp/orders.csv', rowCount: 24, bytes: 512 }),
    } as unknown as ExportService
    const { router, connectionId } = await routerFor({
      exporter,
      pickExportPath: async (name) => {
        picked.push(name)
        return '/tmp/orders.csv'
      },
    })

    const response = await router.handle(request('data.export', 'req-5', { connectionId, schema: 'public', relation: 'orders' }))
    if (!response || !('ok' in response) || !response.ok) throw new Error('Expected a successful response')

    expect(picked).toEqual(['orders.csv'])
    expect(response.data).toEqual({ saved: true, path: '/tmp/orders.csv', rowCount: 24 })
  })

  it('reports a dismissed export dialog without touching the driver', async () => {
    const exporter = {
      exportTable: async () => {
        throw new Error('The exporter must not run when the dialog is dismissed.')
      },
    } as unknown as ExportService
    const { router, connectionId } = await routerFor({ exporter, pickExportPath: async () => undefined })

    const response = await router.handle(request('data.export', 'req-6', { connectionId, schema: 'public', relation: 'orders' }))
    if (!response || !('ok' in response) || !response.ok) throw new Error('Expected a successful response')

    expect(response.data).toEqual({ saved: false })
  })
})
