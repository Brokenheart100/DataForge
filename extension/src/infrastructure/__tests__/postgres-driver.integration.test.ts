import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionConfig } from '../../domain/connection'
import { PostgresDriver } from '../postgres/postgres-driver'

/**
 * Real-server checks for the pg adapter. They only run when a throwaway
 * PostgreSQL is reachable, e.g.
 *
 *   docker run -d --rm -p 5433:5432 -e POSTGRES_PASSWORD=forge_test -e POSTGRES_DB=forge postgres:17-alpine
 *   DATAFORGE_TEST_PG=postgres://postgres:forge_test@127.0.0.1:5433/forge npm run test:unit -w extension
 *
 * Without that variable the suite is skipped, so a plain `npm test` stays green.
 */
const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip
const settings = { connectTimeoutMs: 5_000, statementTimeoutMs: 15_000 }

function configFor(target: URL): ConnectionConfig {
  return {
    profile: {
      id: randomUUID(),
      name: 'integration',
      host: target.hostname,
      port: Number(target.port || 5432),
      database: target.pathname.slice(1),
      user: decodeURIComponent(target.username),
      ssl: 'disable',
      readOnly: false,
      createdAt: Date.now(),
    },
    credentials: { password: decodeURIComponent(target.password) },
  }
}

suite('PostgresDriver against a live server', () => {
  const table = `dataforge_it_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const target = url ? new URL(url) : undefined
  let driver: PostgresDriver

  beforeAll(async () => {
    if (!target) return
    driver = new PostgresDriver(configFor(target), settings)
    await driver.query({ sql: `create table public.${table} (id serial primary key, name text not null)`, maxRows: 1 })
    await driver.query({ sql: `insert into public.${table} (name) values ('one'), ('two'), ('three')`, maxRows: 1 })
  })

  afterAll(async () => {
    if (!target) return
    await driver.query({ sql: `drop table if exists public.${table}`, maxRows: 1 }).catch(() => undefined)
    await driver.dispose()
  })

  it('reports the server identity', async () => {
    const info = await driver.testConnection()
    expect(info.serverVersion).toMatch(/^PostgreSQL \d+/)
    expect(info.database).toBe(target?.pathname.slice(1))
  })

  it('lists schemas, relations and columns with the primary key', async () => {
    expect(await driver.listSchemas()).toContain('public')

    const relations = await driver.listRelations('public')
    expect(relations).toContainEqual({ schema: 'public', name: table, kind: 'table' })

    const columns = await driver.listColumns('public', table)
    expect(columns.map((column) => column.name)).toEqual(['id', 'name'])
    expect(columns[0]).toMatchObject({ name: 'id', isPrimaryKey: true, nullable: false })
    expect(columns[1]).toMatchObject({ name: 'name', nullable: false })
  })

  it('maps rows, types and the command tag', async () => {
    const result = await driver.query({ sql: `select id, name from public.${table} order by id`, maxRows: 10 })
    expect(result.command).toBe('SELECT')
    expect(result.rows).toHaveLength(3)
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'name'])
    expect(result.affectedRows).toBeNull()
    expect(result.rows[0]).toEqual([1, 'one'])
  })

  it('reports affected rows for writes and flags truncation', async () => {
    const update = await driver.query({ sql: `update public.${table} set name = name where id > 1`, maxRows: 10 })
    expect(update.affectedRows).toBe(2)

    const limited = await driver.query({ sql: `select id from public.${table} order by id`, maxRows: 2 })
    expect(limited.rows).toHaveLength(2)
    expect(limited.truncated).toBe(true)
  })

  it('cancels a running statement through its own backend', async () => {
    const controller = new AbortController()
    const running = driver.query({ sql: 'select pg_sleep(15)', maxRows: 1, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    await expect(running).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('still answers queries after a cancellation', async () => {
    const result = await driver.query({ sql: 'select 41 + 1 as answer', maxRows: 1 })
    expect(result.rows[0]).toEqual([42])
  })
})
