import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionDraft } from '@shared/protocol'

import { ConnectionService } from '../connection-service'
import { ObjectService } from '../object-service'
import type { ConnectionConfig } from '../../domain/connection'
import { PostgresDriver } from '../../infrastructure/postgres/postgres-driver'
import { MemoryConnectionStore, MemorySecretStore } from '../../test/memory-stores'

const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

function draftFrom(target: URL): ConnectionDraft {
  return {
    kind: 'postgresql',
    name: `objects ${target.host}`,
    host: target.hostname,
    port: Number(target.port || 5432),
    database: target.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(target.username) || 'postgres',
    password: decodeURIComponent(target.password),
    ssl: 'disable',
    readOnly: false,
  }
}

suite('object browsing against PostgreSQL', () => {
  const target = url ? new URL(url) : undefined
  const table = `dataforge_obj_${randomBytes(6).toString('hex')}`
  const view = `${table}_view`
  let connections: ConnectionService
  let objects: ObjectService
  let connectionId: string

  beforeAll(async () => {
    if (!target) return
    connections = new ConnectionService({
      store: new MemoryConnectionStore(),
      secrets: new MemorySecretStore(),
      createDriver: (config: ConnectionConfig) =>
        new PostgresDriver(config, { connectTimeoutMs: 5_000, statementTimeoutMs: 5_000 }),
      logger,
    })
    await connections.initialize()
    const summary = await connections.create(draftFrom(target))
    connectionId = summary.id
    await connections.connect(connectionId)
    const driver = await connections.requireDriver(connectionId)
    await driver.query({
      sql: `create table public.${table} (id integer primary key, label text not null, flag boolean default false)`,
      maxRows: 1,
    })
    await driver.query({ sql: `create index ${table}_label_idx on public.${table} (label)`, maxRows: 1 })
    await driver.query({ sql: `create view public.${view} as select id, label from public.${table}`, maxRows: 1 })
    objects = new ObjectService({ connections, logger })
  })

  afterAll(async () => {
    if (!target) return
    if (connectionId) {
      const driver = (() => {
        try {
          return connections.requireDriver(connectionId)
        } catch {
          return undefined
        }
      })()
      await driver
        ?.query({ sql: `drop view if exists public.${view}; drop table if exists public.${table}`, maxRows: 1 })
        .catch(() => undefined)
      await connections.disconnect(connectionId).catch(() => undefined)
    }
    await connections?.dispose()
  })

  it('searches tables and views by name', async () => {
    const result = await objects.search({ connectionId, query: table })
    const names = result.objects.map((object) => object.name)
    expect(names).toContain(table)
    expect(names).toContain(view)
    expect(result.objects.find((object) => object.name === view)?.kind).toBe('view')
  })

  it('rebuilds a table DDL with its primary key and indexes', async () => {
    const ddl = await objects.ddl({ connectionId, schema: 'public', name: table, kind: 'table' })
    expect(ddl.cached).toBe(false)
    expect(ddl.ddl.toLowerCase()).toContain('create table')
    expect(ddl.ddl.toUpperCase()).toContain('PRIMARY KEY')
    expect(ddl.ddl).toContain(`${table}_label_idx`)

    const again = await objects.ddl({ connectionId, schema: 'public', name: table, kind: 'table' })
    expect(again.cached).toBe(true)
  })

  it('reads the original view definition', async () => {
    const ddl = await objects.ddl({ connectionId, schema: 'public', name: view, kind: 'view' })
    expect(ddl.ddl.toUpperCase()).toContain('SELECT')
  })

  it('reports sizes and index metadata', async () => {
    const stats = await objects.stats({ connectionId, schema: 'public', name: table, kind: 'table' })
    expect(stats.totalBytes).toBeGreaterThan(0)
    expect(stats.indexes.map((index) => index.name)).toEqual(expect.arrayContaining([`${table}_label_idx`]))
    expect(stats.indexes.find((index) => index.name === `${table}_label_idx`)?.unique).toBe(false)
  })

  it('rejects a missing relation with not_found', async () => {
    await expect(
      objects.ddl({ connectionId, schema: 'public', name: `${table}_missing`, kind: 'table' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})
