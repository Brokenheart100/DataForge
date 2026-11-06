import { describe, expect, it } from 'vitest'

import type { DdlPlanDto, SchemaDiffInput } from '@shared/protocol'

import { DdlService } from '../ddl-service'
import type { ConnectionService } from '../connection-service'
import type { QuerySessionService } from '../query-session-service'
import type { SchemaService } from '../schema-service'
import type { DatabaseDriver, RelationInfo } from '../../domain/driver'
import { buildDdlStatements } from '../../infrastructure/postgres/ddl-sql'

const createTable = (overrides: Partial<Extract<DdlPlanDto, { kind: 'create table' }>> = {}): DdlPlanDto => ({
  kind: 'create table',
  connectionId: 'c1',
  schema: 'public',
  table: 'orders',
  columns: [
    { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
    { name: 'total', dataType: 'numeric(10,2)', nullable: true },
  ],
  ...overrides,
})

interface Harness {
  service: DdlService
  statements: string[]
  invalidations: string[]
}

function setup(options: {
  kind?: 'postgresql' | 'mysql'
  readOnly?: boolean
  transactionOpen?: boolean
  relations?: Record<string, RelationInfo[]>
} = {}): Harness {
  const summary = {
    id: 'c1',
    kind: options.kind ?? 'postgresql',
    readOnly: options.readOnly ?? false,
    database: 'forge',
    name: 'local',
  }
  const statements: string[] = []
  const invalidations: string[] = []
  const driver = {
    applyDdl: async (list: readonly string[]): Promise<number> => {
      statements.push(...list)
      return list.length
    },
  } as unknown as DatabaseDriver
  const connections = {
    get: () => summary,
    requireDriver: async () => driver,
  } as unknown as ConnectionService
  const sessions = {
    isOpen: () => options.transactionOpen ?? false,
    hasOpenTransaction: () => options.transactionOpen ?? false,
  } as unknown as QuerySessionService
  const schemas = {
    invalidate: (connectionId?: string) => {
      if (connectionId) invalidations.push(connectionId)
    },
    listRelations: async (_connectionId: string, schema: string): Promise<RelationInfo[]> =>
      options.relations?.[schema] ?? [],
  } as unknown as SchemaService

  return {
    service: new DdlService({
      connections,
      sessions,
      schemas,
      planner: buildDdlStatements,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }),
    statements,
    invalidations,
  }
}

describe('DdlService preview', () => {
  it('builds statements for a new table', () => {
    const { service } = setup()
    const preview = service.preview(createTable())

    expect(preview.statements).toHaveLength(1)
    expect(preview.statements[0]?.sql).toContain('create table "public"."orders"')
    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.expectedConfirmation).toBeNull()
    expect(preview.warnings).toEqual([])
  })

  it('requires CONFIRM for a NOT NULL column without default', () => {
    const { service } = setup()
    const preview = service.preview({
      kind: 'add column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'note', dataType: 'text', nullable: false },
    })

    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.expectedConfirmation).toBe('CONFIRM')
    expect(preview.warnings[0]).toContain('NOT NULL without a default')
  })

  it('expects the table name for a drop', () => {
    const { service } = setup()
    const preview = service.preview({
      kind: 'drop table',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
    })

    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.expectedConfirmation).toBe('orders')
    expect(preview.statements[0]?.risk).toBe('dangerous')
  })

  it('rejects unsupported engines', () => {
    const { service } = setup({ kind: 'mysql' })
    expect(() => service.preview(createTable())).toThrow(/not available for mysql/)
  })

  it('rejects invalid plans', () => {
    const { service } = setup()
    expect(() =>
      service.preview(
        createTable({
          columns: [
            { name: 'id', dataType: 'integer', primaryKey: true },
            { name: 'ID', dataType: 'integer' },
          ],
        }),
      ),
    ).toThrow(/defined twice/)
    expect(() =>
      service.preview(createTable({ columns: [{ name: 'id', dataType: 'int; drop' }] })),
    ).toThrow(/unsupported type/)
  })
})

describe('DdlService apply', () => {
  it('runs statements and invalidates metadata', async () => {
    const { service, statements, invalidations } = setup()
    const result = await service.apply({ plan: createTable() })

    expect(result.statements).toBe(1)
    expect(statements[0]).toContain('create table "public"."orders"')
    expect(invalidations).toEqual(['c1'])
  })

  it('refuses a read-only connection', async () => {
    const { service, statements } = setup({ readOnly: true })
    await expect(service.apply({ plan: createTable() })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('read-only'),
    })
    expect(statements).toEqual([])
  })

  it('refuses while a transaction is open', async () => {
    const { service, statements } = setup({ transactionOpen: true })
    await expect(service.apply({ plan: createTable() })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('open transaction'),
    })
    expect(statements).toEqual([])
  })

  it('requires the typed confirmation for dangerous plans', async () => {
    const { service, statements } = setup()
    const plan: DdlPlanDto = {
      kind: 'drop table',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
    }

    await expect(service.apply({ plan })).rejects.toThrow(/Type "orders"/)
    await expect(service.apply({ plan, confirm: 'nope' })).rejects.toThrow(/Type "orders"/)
    expect(statements).toEqual([])

    await service.apply({ plan, confirm: 'orders' })
    expect(statements).toEqual(['drop table "public"."orders";'])
  })
})

describe('DdlService diff', () => {
  it('reports added, removed and changed objects between scopes', async () => {
    const relations: Record<string, RelationInfo[]> = {
      public: [
        { schema: 'public', name: 'orders', kind: 'table' },
        { schema: 'public', name: 'customers', kind: 'table' },
        { schema: 'public', name: 'old_view', kind: 'view' },
      ],
      archive: [
        { schema: 'archive', name: 'orders', kind: 'table' },
        { schema: 'archive', name: 'customers', kind: 'view' },
        { schema: 'archive', name: 'invoices', kind: 'table' },
      ],
    }
    const { service } = setup({ relations })
    const input: SchemaDiffInput = {
      connectionId: 'c1',
      left: { schema: 'public' },
      right: { schema: 'archive' },
    }

    const diff = await service.diff(input)
    expect(diff.added).toEqual([{ schema: 'archive', name: 'invoices', kind: 'table' }])
    expect(diff.removed).toEqual([{ schema: 'public', name: 'old_view', kind: 'view' }])
    expect(diff.changed).toEqual([{ name: 'customers', leftKind: 'table', rightKind: 'view' }])
  })
})
