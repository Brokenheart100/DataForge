import type {
  DdlColumnPlanDto,
  DdlIndexPlanDto,
  DdlPlanDto,
  DdlStatementDto,
} from '@shared/protocol'

import { quoteIdentifier } from './sql-builder'

/**
 * PostgreSQL dialect for structural changes. Statements are built from the
 * validated plan; nothing here accepts raw SQL from the webview.
 */

const DEFAULT_FUNCTION =
  /^(?:now\(\)|current_timestamp|current_date|current_time|localtimestamp|gen_random_uuid\(\)|uuid_generate_v4\(\)|nextval\('(?:[^']|'')*'(?:::regclass)?\))$/i

export function renderDefault(value: string): string {
  const text = value.trim()
  if (/^(?:null|true|false)$/i.test(text)) return text.toLowerCase()
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text
  if (/^'(?:[^']|'')*'$/.test(text)) return text
  if (DEFAULT_FUNCTION.test(text)) return text
  return `'${text.replaceAll("'", "''")}'`
}

export function buildColumnDefinition(column: DdlColumnPlanDto): string {
  const parts = [quoteIdentifier(column.name), column.dataType.trim()]
  if (column.nullable !== true) parts.push('not null')
  if (column.defaultValue !== undefined && column.defaultValue !== null) {
    parts.push(`default ${renderDefault(String(column.defaultValue))}`)
  }
  if (column.primaryKey === true) parts.push('primary key')
  if (column.unique === true) parts.push('unique')
  return parts.join(' ')
}

function qualified(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
}

function defaultIndexName(table: string, index: DdlIndexPlanDto): string {
  return `${table}_${index.columns.join('_')}_idx`.slice(0, 63)
}

function createTable(plan: Extract<DdlPlanDto, { kind: 'create table' }>): DdlStatementDto[] {
  const columns = plan.columns.map((column) => `  ${buildColumnDefinition(column)}`).join(',\n')
  const clause = plan.ifNotExists === true ? 'if not exists ' : ''
  return [
    {
      sql: `create table ${clause}${qualified(plan.schema, plan.table)} (\n${columns}\n);`,
      risk: 'safe',
    },
  ]
}

function addColumn(plan: Extract<DdlPlanDto, { kind: 'add column' }>): DdlStatementDto[] {
  const withoutDefault = plan.column.nullable !== true && (plan.column.defaultValue ?? null) === null
  const clause = plan.ifNotExists === true ? 'if not exists ' : ''
  return [
    {
      sql: `alter table ${qualified(plan.schema, plan.table)} add column ${clause}${buildColumnDefinition(plan.column)};`,
      risk: withoutDefault ? 'dangerous' : 'caution',
      note: withoutDefault
        ? 'A NOT NULL column without a default cannot be filled for existing rows.'
        : 'Existing rows get the default (or NULL); the table is briefly locked.',
    },
  ]
}

function dropTable(plan: Extract<DdlPlanDto, { kind: 'drop table' }>): DdlStatementDto[] {
  const clause = plan.ifExists === true ? 'if exists ' : ''
  return [
    {
      sql: `drop table ${clause}${qualified(plan.schema, plan.table)};`,
      risk: 'dangerous',
      note: 'Dropping a table deletes its rows; dependent views and foreign keys must be handled first.',
    },
  ]
}

function createIndex(plan: Extract<DdlPlanDto, { kind: 'create index' }>): DdlStatementDto[] {
  const index = plan.index
  const name = index.name !== undefined && index.name.trim().length > 0
    ? index.name
    : defaultIndexName(plan.table, index)
  const columns = index.columns.map(quoteIdentifier).join(', ')
  const unique = index.unique === true ? 'unique ' : ''
  const clause = plan.ifNotExists === true ? 'if not exists ' : ''
  return [
    {
      sql: `create ${unique}index ${clause}${quoteIdentifier(name)} on ${qualified(plan.schema, plan.table)} (${columns});`,
      risk: 'caution',
      note: 'Index creation takes a share lock while it builds; on a large table it can slow writes.',
    },
  ]
}

function alterColumn(plan: Extract<DdlPlanDto, { kind: 'alter column' }>): DdlStatementDto[] {
  const target = `${qualified(plan.schema, plan.table)} alter column ${quoteIdentifier(plan.column.name)}`
  const statements: DdlStatementDto[] = []
  const type = plan.column.dataType?.trim()
  if (type !== undefined && type.length > 0) {
    statements.push({
      sql: `alter table ${target} type ${type};`,
      risk: 'dangerous',
      note: 'Changing the type rewrites the table and locks it while the rows are converted.',
    })
  }
  if (plan.column.defaultValue !== undefined) {
    const sql =
      plan.column.defaultValue === null
        ? `alter table ${target} drop default;`
        : `alter table ${target} set default ${renderDefault(String(plan.column.defaultValue))};`
    statements.push({
      sql,
      risk: 'caution',
      note: 'The default only applies to rows written after this change.',
    })
  }
  if (plan.column.nullable !== undefined) {
    statements.push(
      plan.column.nullable
        ? {
            sql: `alter table ${target} drop not null;`,
            risk: 'caution',
            note: 'Existing rows are not touched; the table is briefly locked.',
          }
        : {
            sql: `alter table ${target} set not null;`,
            risk: 'dangerous',
            note: 'Fails when existing rows contain null; the whole table is scanned.',
          },
    )
  }
  return statements
}

export function buildDdlStatements(plan: DdlPlanDto): DdlStatementDto[] {
  switch (plan.kind) {
    case 'create table':
      return createTable(plan)
    case 'add column':
      return addColumn(plan)
    case 'drop table':
      return dropTable(plan)
    case 'create index':
      return createIndex(plan)
    case 'alter column':
      return alterColumn(plan)
  }
}
