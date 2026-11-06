import { describe, expect, it } from 'vitest'

import type { DdlPlanDto } from '@shared/protocol'

import { buildDdlStatements, renderDefault } from '../ddl-sql'

function createTable(): Extract<DdlPlanDto, { kind: 'create table' }> {
  return {
    kind: 'create table',
    connectionId: 'c1',
    schema: 'public',
    table: 'order items',
    columns: [
      { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
      { name: 'label', dataType: 'character varying(120)', nullable: false, defaultValue: "'draft'" },
      { name: 'created_at', dataType: 'timestamptz', nullable: false, defaultValue: 'now()' },
    ],
  }
}

describe('renderDefault', () => {
  it('renders literals, functions and falls back to quoting', () => {
    expect(renderDefault('42')).toBe('42')
    expect(renderDefault('TRUE')).toBe('true')
    expect(renderDefault("'draft'")).toBe("'draft'")
    expect(renderDefault('now()')).toBe('now()')
    expect(renderDefault('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP')
    expect(renderDefault("it's")).toBe("'it''s'")
  })
})

describe('buildDdlStatements', () => {
  it('builds a quoted create table', () => {
    const [statement] = buildDdlStatements(createTable())
    expect(statement?.risk).toBe('safe')
    expect(statement?.sql).toBe(
      [
        'create table "public"."order items" (',
        '  "id" integer not null primary key,',
        '  "label" character varying(120) not null default \'draft\',',
        '  "created_at" timestamptz not null default now()',
        ');',
      ].join('\n'),
    )
  })

  it('adds if not exists when asked', () => {
    const [statement] = buildDdlStatements({ ...createTable(), ifNotExists: true })
    expect(statement?.sql.startsWith('create table if not exists "public"."order items"')).toBe(true)
  })

  it('marks NOT NULL add column without default as dangerous', () => {
    const [statement] = buildDdlStatements({
      kind: 'add column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'total', dataType: 'numeric(10,2)', nullable: false },
    })
    expect(statement?.risk).toBe('dangerous')
    expect(statement?.sql).toBe(
      'alter table "public"."orders" add column "total" numeric(10,2) not null;',
    )
  })

  it('marks a nullable add column as caution', () => {
    const [statement] = buildDdlStatements({
      kind: 'add column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'note', dataType: 'text', nullable: true },
    })
    expect(statement?.risk).toBe('caution')
    expect(statement?.sql).toContain('"note" text;')
  })

  it('builds drop table with if exists', () => {
    const [statement] = buildDdlStatements({
      kind: 'drop table',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      ifExists: true,
    })
    expect(statement?.risk).toBe('dangerous')
    expect(statement?.sql).toBe('drop table if exists "public"."orders";')
  })

  it('builds a unique index with a default name', () => {
    const [statement] = buildDdlStatements({
      kind: 'create index',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      index: { columns: ['tenant', 'number'], unique: true },
    })
    expect(statement?.risk).toBe('caution')
    expect(statement?.sql).toBe(
      'create unique index "orders_tenant_number_idx" on "public"."orders" ("tenant", "number");',
    )
  })

  it('escapes quotes in identifiers and index names', () => {
    const [statement] = buildDdlStatements({
      kind: 'create index',
      connectionId: 'c1',
      schema: 'pub"lic',
      table: 'order"items',
      index: { name: 'weird"name', columns: ['a"b'] },
    })
    expect(statement?.sql).toBe(
      'create index "weird""name" on "pub""lic"."order""items" ("a""b");',
    )
  })

  it('builds alter column statements in type, default, nullability order', () => {
    const statements = buildDdlStatements({
      kind: 'alter column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'total', dataType: 'numeric(12,2)', defaultValue: '0', nullable: false },
    })
    expect(statements.map((statement) => statement.sql)).toEqual([
      'alter table "public"."orders" alter column "total" type numeric(12,2);',
      'alter table "public"."orders" alter column "total" set default 0;',
      'alter table "public"."orders" alter column "total" set not null;',
    ])
    expect(statements.map((statement) => statement.risk)).toEqual(['dangerous', 'caution', 'dangerous'])
  })

  it('renders dropping a default and nullability', () => {
    const statements = buildDdlStatements({
      kind: 'alter column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'note', defaultValue: null, nullable: true },
    })
    expect(statements.map((statement) => statement.sql)).toEqual([
      'alter table "public"."orders" alter column "note" drop default;',
      'alter table "public"."orders" alter column "note" drop not null;',
    ])
    expect(statements.every((statement) => statement.risk === 'caution')).toBe(true)
  })
})
