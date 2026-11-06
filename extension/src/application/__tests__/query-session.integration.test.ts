import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionConfig } from '../../domain/connection'
import { DataForgeError } from '../../domain/errors'
import { PostgresDriver } from '../../infrastructure/postgres/postgres-driver'
import { QuerySessionService } from '../query-session-service'

const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip

function configFor(target: URL): ConnectionConfig {
  return {
    profile: {
      id: 'live-session',
      name: 'live session',
      host: target.hostname,
      port: target.port ? Number(target.port) : 5432,
      database: target.pathname.replace(/^\//, '') || 'postgres',
      user: decodeURIComponent(target.username) || 'postgres',
      ssl: 'disable',
      readOnly: false,
      createdAt: Date.now(),
    },
    credentials: { password: decodeURIComponent(target.password) },
  }
}

suite('QuerySessionService (live PostgreSQL)', () => {
  const table = `dataforge_tx_${Math.random().toString(16).slice(2, 14)}`
  let driver: PostgresDriver
  let service: QuerySessionService

  beforeAll(async () => {
    if (!url) return
    driver = new PostgresDriver(configFor(new URL(url)), { connectTimeoutMs: 5_000, statementTimeoutMs: 5_000 })
    await driver.testConnection()
    await driver.query({ sql: `create table public.${table} (id integer primary key)`, maxRows: 1 })
    service = new QuerySessionService({
      connections: {
        requireDriver: () => driver,
        list: () => [{ id: 'c1', name: 'live session' }],
      } as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
  }, 20_000)

  afterAll(async () => {
    if (!url) return
    await driver.query({ sql: `drop table if exists public.${table}`, maxRows: 1 })
    await driver.dispose()
  })

  it('keeps uncommitted rows invisible to pool queries until commit', async () => {
    await service.begin('c1')
    await service.run('c1', `insert into public.${table} values (1)`, 10)

    const before = await driver.query({ sql: `select count(*)::int as n from public.${table} where id = 1`, maxRows: 1 })
    expect(before.rows[0]).toEqual([0])

    await service.commit('c1')
    expect(service.isOpen('c1')).toBe(false)

    const after = await driver.query({ sql: `select count(*)::int as n from public.${table} where id = 1`, maxRows: 1 })
    expect(after.rows[0]).toEqual([1])
  })

  it('discards the work on rollback', async () => {
    await service.begin('c1')
    await service.run('c1', `insert into public.${table} values (2)`, 10)
    await service.rollback('c1')

    const after = await driver.query({ sql: `select count(*)::int as n from public.${table} where id = 2`, maxRows: 1 })
    expect(after.rows[0]).toEqual([0])
  })

  it('rolls back a session left open by the workbench', async () => {
    await service.begin('c1')
    await service.run('c1', `insert into public.${table} values (3)`, 10)
    await service.rollbackAll()

    const after = await driver.query({ sql: `select count(*)::int as n from public.${table} where id = 3`, maxRows: 1 })
    expect(after.rows[0]).toEqual([0])
  })

  it('refuses a second transaction on the same connection', async () => {
    await service.begin('c1')
    await expect(service.begin('c1')).rejects.toBeInstanceOf(DataForgeError)
    await service.rollback('c1')
  })

  it('returns a JSON plan from EXPLAIN', async () => {
    const result = await driver.query({ sql: 'explain (format json) select 1', maxRows: 1 })
    expect(String(result.rows[0]?.[0] ?? '')).toContain('Plan')
  })
})
