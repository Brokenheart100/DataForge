import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionDraft } from '@shared/protocol'

import type { Logger } from '../ports'
import { ConnectionService } from '../connection-service'
import { DataEditorService } from '../data-editor-service'
import { SchemaService } from '../schema-service'
import { PostgresDriver } from '../../infrastructure/postgres/postgres-driver'
import { MemoryConnectionStore, MemorySecretStore } from '../../test/memory-stores'

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip

suite('DataEditorService against a live server', () => {
  const table = `dataforge_edit_${Math.random().toString(16).slice(2, 14)}`
  const view = `${table}_view`
  const connections = new ConnectionService({
    store: new MemoryConnectionStore(),
    secrets: new MemorySecretStore(),
    createDriver: (config) =>
      new PostgresDriver(config, {
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 5_000,
        onBackgroundError: (message) => logger.warn(message),
      }),
    logger,
  })
  const schemas = new SchemaService(connections, logger)
  const editor = new DataEditorService({ connections, schemas, logger })
  let connectionId = ''

  beforeAll(async () => {
    const target = new URL(url ?? 'postgres://postgres@127.0.0.1:5432/postgres')
    const draft: ConnectionDraft = {
      name: 'editing target',
      host: target.hostname,
      port: Number(target.port || 5432),
      database: target.pathname.slice(1) || 'postgres',
      user: decodeURIComponent(target.username) || 'postgres',
      password: decodeURIComponent(target.password),
      ssl: 'disable',
      readOnly: false,
    }
    await connections.initialize()
    const summary = await connections.create(draft)
    connectionId = summary.id
    await connections.connect(connectionId)

    const driver = connections.requireDriver(connectionId)
    await driver.query({ sql: `create table public."${table}" (id serial primary key, label text not null, note text)`, maxRows: 1 })
    await driver.query({ sql: `insert into public."${table}" (label) values ('one'), ('two'), ('three')`, maxRows: 1 })
    await driver.query({ sql: `create view public."${view}" as select * from public."${table}"`, maxRows: 1 })
  })

  afterAll(async () => {
    const driver = connections.requireDriver(connectionId)
    await driver.query({ sql: `drop view if exists public."${view}"`, maxRows: 1 })
    await driver.query({ sql: `drop table if exists public."${table}"`, maxRows: 1 })
    await connections.dispose()
  })

  function page(overrides: { offset?: number; orderBy?: { column: string; direction: 'asc' | 'desc' }[] } = {}) {
    return editor.loadPage({
      connectionId,
      schema: 'public',
      relation: table,
      limit: 10,
      offset: overrides.offset ?? 0,
      orderBy: overrides.orderBy ?? [{ column: 'id', direction: 'asc' }],
    })
  }

  it('loads a page with identity and version', async () => {
    const result = await page()

    expect(result).toMatchObject({ totalRows: 3, editable: true, primaryKey: ['id'] })
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'label', 'note'])
    expect(result.rows[0]).toMatchObject({ identity: { id: 1 }, values: [1, 'one', null] })
    expect(result.rows[0]?.version).toMatch(/^\d+$/)
  })

  it('filters pages and total counts on the server', async () => {
    const filtered = await editor.loadPage({
      connectionId,
      schema: 'public',
      relation: table,
      limit: 10,
      offset: 0,
      orderBy: [],
      filters: [{ column: 'label', operator: 'contains', value: 'tw' }],
    })
    expect(filtered.totalRows).toBe(1)
    expect(filtered.rows[0]?.values).toEqual([2, 'two', null])

    const none = await editor.loadPage({
      connectionId,
      schema: 'public',
      relation: table,
      limit: 10,
      offset: 0,
      orderBy: [],
      filters: [{ column: 'note', operator: 'is null' }],
    })
    expect(none.totalRows).toBe(3)
  })

  it('marks a view read-only', async () => {
    const result = await editor.loadPage({ connectionId, schema: 'public', relation: view, limit: 10, offset: 0, orderBy: [] })

    expect(result.editable).toBe(false)
    expect(result.readOnlyReason).toContain('cannot be edited')
  })

  it('inserts, updates and deletes through a single commit', async () => {
    const before = await page()
    const first = before.rows[0]
    if (!first) throw new Error('Expected a seeded row')

    const committed = await editor.commit({
      connectionId,
      schema: 'public',
      relation: table,
      rows: [
        { rowId: 'new', version: null, change: { kind: 'insert', values: { label: 'four' } } },
        { rowId: 'r1', version: first.version, change: { kind: 'update', identity: first.identity, values: { label: 'one-edited' } } },
        { rowId: 'r3', version: before.rows[2]?.version ?? null, change: { kind: 'delete', identity: { id: 3 } } },
      ],
    })

    expect(committed).toMatchObject({ inserted: 1, updated: 1, deleted: 1 })
    expect(committed.returnedKeys[0]?.[0]).toEqual(expect.any(Number))

    const after = await page()
    expect(after.totalRows).toBe(3)
    expect(after.rows.map((row) => row.values[1])).toEqual(['one-edited', 'two', 'four'])
  })

  it('rejects a stale version without writing anything', async () => {
    const before = await page()
    const first = before.rows[0]
    if (!first) throw new Error('Expected a seeded row')

    await expect(
      editor.commit({
        connectionId,
        schema: 'public',
        relation: table,
        rows: [
          { rowId: 'new', version: null, change: { kind: 'insert', values: { label: 'rollback-me' } } },
          { rowId: 'r1', version: '0', change: { kind: 'update', identity: first.identity, values: { label: 'stale' } } },
        ],
      }),
    ).rejects.toMatchObject({ code: 'conflict', keys: ['id=1'] })

    const after = await page()
    expect(after.rows.map((row) => row.values[1])).toEqual(['one-edited', 'two', 'four'])
  })
})
