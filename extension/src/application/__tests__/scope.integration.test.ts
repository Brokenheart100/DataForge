import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionDraft } from '@shared/protocol'

import { DataEditorService } from '../data-editor-service'
import { QueryService } from '../query-service'
import { SchemaService } from '../schema-service'
import { ConnectionService } from '../connection-service'
import { PostgresDriver } from '../../infrastructure/postgres/postgres-driver'
import type { ConnectionConfig } from '../../domain/connection'
import { DataForgeError } from '../../domain/errors'
import { MemoryConnectionStore, MemorySecretStore } from '../../test/memory-stores'

const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

function draftFrom(target: URL): ConnectionDraft {
  return {
    kind: 'postgresql',
    name: `scope ${target.host}`,
    host: target.hostname,
    port: Number(target.port || 5432),
    database: target.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(target.username) || 'postgres',
    password: decodeURIComponent(target.password),
    ssl: 'disable',
    readOnly: false,
  }
}

suite('database scopes', () => {
  const target = url ? new URL(url) : undefined
  const secondary = `dataforge_scope_${randomBytes(6).toString('hex')}`
  let connections: ConnectionService
  let queries: QueryService
  let schemas: SchemaService
  let editor: DataEditorService
  let connectionId: string

  beforeAll(async () => {
    if (!target) return
    const store = new MemoryConnectionStore()
    const secrets = new MemorySecretStore()
    connections = new ConnectionService({
      store,
      secrets,
      createDriver: (config: ConnectionConfig) =>
        new PostgresDriver(config, { connectTimeoutMs: 5_000, statementTimeoutMs: 5_000 }),
      logger,
    })
    await connections.initialize()
    connectionId = (await connections.create(draftFrom(target))).id
    await connections.connect(connectionId)

    schemas = new SchemaService(connections, logger)
    queries = new QueryService(connections, { logger, defaultMaxRows: 100 })
    editor = new DataEditorService({ connections, schemas, logger })

    const admin = await connections.requireDriver(connectionId)
    await admin.query({ sql: `create database ${quote(secondary)}`, maxRows: 1 })
    const scoped = await connections.requireScopedDriver(connectionId, secondary)
    await scoped.query({
      sql: 'create table public.items (id integer primary key, label text not null)',
      maxRows: 1,
    })
    await scoped.query({ sql: "insert into public.items values (1, 'one')", maxRows: 1 })
  })

  afterAll(async () => {
    if (!target) return
    try {
      const admin = await connections.requireDriver(connectionId)
      await admin.query({ sql: `drop database if exists ${quote(secondary)} with (force)`, maxRows: 1 })
    } finally {
      await connections.dispose()
    }
  })

  it('lists databases and reads metadata from a secondary scope', async () => {
    if (!target) return
    expect(await connections.listDatabases(connectionId)).toContain(secondary)
    const names = await schemas.listSchemas(connectionId, secondary)
    expect(names).toContain('public')
    const relations = await schemas.listRelations(connectionId, 'public', secondary)
    expect(relations.map((relation) => relation.name)).toContain('items')
    const columns = await schemas.listColumns(connectionId, 'public', 'items', secondary)
    expect(columns.map((column) => column.name)).toEqual(['id', 'label'])
  })

  it('runs read-only queries in the secondary scope and refuses writes there', async () => {
    if (!target) return
    const result = await queries.execute('scope-read', {
      connectionId,
      database: secondary,
      sql: 'select label from public.items',
      maxRows: 10,
    })
    expect(result.rows).toEqual([['one']])

    await expect(
      queries.execute('scope-write', {
        connectionId,
        database: secondary,
        sql: "insert into public.items values (2, 'two')",
        maxRows: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('pages a secondary relation as read-only and rejects commits there', async () => {
    if (!target) return
    const page = await editor.loadPage({
      connectionId,
      database: secondary,
      schema: 'public',
      relation: 'items',
      limit: 10,
      offset: 0,
    })
    expect(page.editable).toBe(false)
    expect(page.readOnlyReason).toContain('Switch the connection')
    expect(page.rows[0]?.values).toEqual([1, 'one'])

    await expect(
      editor.commit({
        connectionId,
        database: secondary,
        schema: 'public',
        relation: 'items',
        rows: [
          {
            rowId: 'row-1',
            version: null,
            change: { kind: 'insert', values: { id: 2, label: 'two' } },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(DataForgeError)
  })
})

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}
