import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionDraft, DdlPlanDto } from '@shared/protocol'

import { ConnectionService } from '../connection-service'
import { DdlService } from '../ddl-service'
import { QuerySessionService } from '../query-session-service'
import { SchemaService } from '../schema-service'
import type { ConnectionConfig } from '../../domain/connection'
import type { RelationInfo } from '../../domain/driver'
import { PostgresDriver } from '../../infrastructure/postgres/postgres-driver'
import { buildDdlStatements } from '../../infrastructure/postgres/ddl-sql'
import { MemoryConnectionStore, MemorySecretStore } from '../../test/memory-stores'

const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
const table = `dataforge_ddl_${randomBytes(6).toString('hex')}`

function draftFrom(target: URL): ConnectionDraft {
  return {
    kind: 'postgresql',
    name: `ddl ${target.host}`,
    host: target.hostname,
    port: Number(target.port || 5432),
    database: target.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(target.username) || 'postgres',
    password: decodeURIComponent(target.password),
    ssl: 'disable',
    readOnly: false,
  }
}

suite('DDL apply', () => {
  const target = url ? new URL(url) : undefined
  let connections: ConnectionService
  let schemas: SchemaService
  let ddl: DdlService
  let connectionId = ''

  function plan(overrides: Partial<DdlPlanDto> = {}): DdlPlanDto {
    return {
      kind: 'create table',
      connectionId,
      schema: 'public',
      table,
      columns: [
        { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
        { name: 'label', dataType: 'text', nullable: true },
      ],
      ...overrides,
    } as DdlPlanDto
  }

  async function relations(): Promise<RelationInfo[]> {
    return schemas.listRelations(connectionId, 'public')
  }

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
    connectionId = (await connections.create(draftFrom(target))).id
    await connections.connect(connectionId)
    schemas = new SchemaService(connections, logger)
    const sessions = new QuerySessionService({ connections, logger, defaultMaxRows: 100 })
    ddl = new DdlService({
      connections,
      sessions,
      schemas,
      planner: buildDdlStatements,
      logger,
    })
  })

  afterAll(async () => {
    if (!target) return
    try {
      const driver = connections ? await connections.requireDriver(connectionId) : undefined
      await driver?.query({ sql: `drop table if exists public.${table}`, maxRows: 1 })
    } catch {
      // The table may already be gone.
    }
    await connections?.dispose()
  })

  it('creates a table, adds a column, indexes it and drops it', async () => {
    await ddl.apply({ plan: plan() })

    let seen = await relations()
    expect(seen.some((relation) => relation.name === table && relation.kind === 'table')).toBe(true)

    await ddl.apply({
      plan: plan({
        kind: 'add column',
        column: { name: 'created_at', dataType: 'timestamptz', nullable: false, defaultValue: 'now()' },
      } as DdlPlanDto),
    })
    const columns = await schemas.listColumns(connectionId, 'public', table)
    expect(columns.map((column) => column.name)).toEqual(['id', 'label', 'created_at'])
    expect(columns[2]?.nullable).toBe(false)

    await ddl.apply({
      plan: plan({
        kind: 'create index',
        index: { name: `${table}_label_idx`, columns: ['label'] },
      } as DdlPlanDto),
    })
    const driver = await connections.requireDriver(connectionId)
    const indexes = await driver.query({
      sql: `select indexname from pg_indexes where schemaname = 'public' and tablename = '${table}'`,
      maxRows: 10,
    })
    expect(indexes.rows.map((row) => String(row[0]))).toContain(`${table}_label_idx`)

    await ddl.apply({ plan: plan({ kind: 'drop table' } as DdlPlanDto), confirm: table })
    seen = await relations()
    expect(seen.some((relation) => relation.name === table)).toBe(false)
  })

  it('alters a column default and nullability', async () => {
    const name = `${table}_alter`
    await ddl.apply({
      plan: {
        kind: 'create table',
        connectionId,
        schema: 'public',
        table: name,
        columns: [
          { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
          { name: 'amount', dataType: 'numeric(10,2)', nullable: true },
        ],
      },
    })
    const driver = await connections.requireDriver(connectionId)
    await driver.query({ sql: `insert into public.${name} (id) values (1)`, maxRows: 1 })

    await expect(
      ddl.apply({
        plan: {
          kind: 'alter column',
          connectionId,
          schema: 'public',
          table: name,
          column: { name: 'amount', nullable: false },
        },
        confirm: 'CONFIRM',
      }),
    ).rejects.toMatchObject({ code: 'query_failed' })

    await driver.query({ sql: `update public.${name} set amount = 0`, maxRows: 1 })
    await ddl.apply({
      plan: {
        kind: 'alter column',
        connectionId,
        schema: 'public',
        table: name,
        column: { name: 'amount', nullable: false },
      },
      confirm: 'CONFIRM',
    })
    let columns = await schemas.listColumns(connectionId, 'public', name)
    expect(columns.find((column) => column.name === 'amount')?.nullable).toBe(false)

    await ddl.apply({
      plan: {
        kind: 'alter column',
        connectionId,
        schema: 'public',
        table: name,
        column: { name: 'amount', defaultValue: '0' },
      },
    })
    columns = await schemas.listColumns(connectionId, 'public', name)
    expect(columns.find((column) => column.name === 'amount')?.defaultValue).toContain('0')

    await ddl.apply({
      plan: {
        kind: 'alter column',
        connectionId,
        schema: 'public',
        table: name,
        column: { name: 'amount', defaultValue: null },
      },
    })
    columns = await schemas.listColumns(connectionId, 'public', name)
    expect(columns.find((column) => column.name === 'amount')?.defaultValue).toBeNull()

    await ddl.apply({
      plan: { kind: 'drop table', connectionId, schema: 'public', table: name },
      confirm: name,
    })
  })

  it('refuses a NOT NULL column without a default on a table with rows', async () => {
    const name = `${table}_guarded`
    await ddl.apply({
      plan: {
        kind: 'create table',
        connectionId,
        schema: 'public',
        table: name,
        columns: [{ name: 'id', dataType: 'integer', nullable: false, primaryKey: true }],
      },
    })
    const driver = await connections.requireDriver(connectionId)
    await driver.query({ sql: `insert into public.${name} (id) values (1)`, maxRows: 1 })

    await expect(
      ddl.apply({
        plan: {
          kind: 'add column',
          connectionId,
          schema: 'public',
          table: name,
          column: { name: 'note', dataType: 'text', nullable: false },
        },
        confirm: 'CONFIRM',
      }),
    ).rejects.toMatchObject({ code: 'query_failed' })

    const columns = await schemas.listColumns(connectionId, 'public', name)
    expect(columns.map((column) => column.name)).toEqual(['id'])

    await ddl.apply({
      plan: { kind: 'drop table', connectionId, schema: 'public', table: name },
      confirm: name,
    })
  })
})
