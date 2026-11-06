import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionConfig } from '../../domain/connection'
import { createProfile } from '../../domain/connection'
import { DataForgeError } from '../../domain/errors'
import { MySqlDriver } from '../mysql/mysql-driver'

const url = process.env.DATAFORGE_TEST_MYSQL
const suite = url ? describe : describe.skip

const table = `dataforge_it_${randomBytes(6).toString('hex')}`

function configFor(target: URL): ConnectionConfig {
  const profile = createProfile(
    'live-mysql',
    {
      kind: 'mysql',
      name: 'live mysql',
      host: target.hostname,
      port: Number(target.port || 3306),
      database: target.pathname.replace(/^\//, '') || 'forge',
      user: decodeURIComponent(target.username) || 'root',
      ssl: 'disable',
    },
    Date.now(),
  )
  return { profile, credentials: { password: decodeURIComponent(target.password) } }
}

suite('MySqlDriver against a live server', () => {
  const driver = new MySqlDriver(configFor(new URL(url ?? 'mysql://root@127.0.0.1:3306/forge')), {
    connectTimeoutMs: 10_000,
    statementTimeoutMs: 5_000,
  })

  beforeAll(async () => {
    await driver.query({ sql: `drop table if exists ${table}`, maxRows: 1 })
    await driver.query({ sql: `create table ${table} (id int auto_increment primary key, name varchar(64) not null, created_at datetime null)`, maxRows: 1 })
    await driver.query({ sql: `insert into ${table} (name, created_at) values ('one', '2026-01-02 03:04:05'), ('two', null)`, maxRows: 1 })
  })

  afterAll(async () => {
    await driver.query({ sql: `drop table if exists ${table}`, maxRows: 1 })
    await driver.dispose()
  })

  it('identifies the server', async () => {
    const info = await driver.testConnection()
    expect(info.serverVersion).toMatch(/^MySQL \d|^MySQL MariaDB/)
    expect(info.database.length).toBeGreaterThan(0)
  })

  it('lists schemas, relations and columns', async () => {
    const schemas = await driver.listSchemas()
    expect(schemas).toContain('forge')

    const relations = await driver.listRelations('forge')
    expect(relations).toContainEqual({ schema: 'forge', name: table, kind: 'table' })

    const columns = await driver.listColumns('forge', table)
    expect(columns.map((column) => column.name)).toEqual(['id', 'name', 'created_at'])
    expect(columns[0]).toMatchObject({ isPrimaryKey: true, nullable: false })
    expect(columns[1]).toMatchObject({ isPrimaryKey: false, nullable: false })
    expect(columns[2]).toMatchObject({ nullable: true })
    expect(columns[0]?.dataType).toContain('int')
  })

  it('returns rows as arrays with string dates', async () => {
    const result = await driver.query({ sql: `select id, name, created_at from ${table} order by id`, maxRows: 10 })
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'name', 'created_at'])
    expect(result.command).toBe('SELECT')
    expect(result.affectedRows).toBeNull()
    expect(result.rows[0]).toEqual([1, 'one', '2026-01-02 03:04:05'])
    expect(result.rows[1]?.[2]).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('reports affected rows for writes', async () => {
    const result = await driver.query({ sql: `update ${table} set name = 'one-edited' where id = 1`, maxRows: 10 })
    expect(result.affectedRows).toBe(1)
    expect(result.rows).toEqual([])
  })

  it('cancels a running statement and keeps the pool usable', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = driver.query({ sql: 'select sleep(10)', maxRows: 1, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(5_000)

    const followUp = await driver.query({ sql: 'select cast(41 + 1 as signed) as answer', maxRows: 1 })
    expect(followUp.rows).toEqual([['42']])
  })

  it('surfaces a failing statement as query_failed', async () => {
    await expect(driver.query({ sql: 'select * from missing_table_for_dataforge', maxRows: 1 })).rejects.toBeInstanceOf(DataForgeError)
  })
})
