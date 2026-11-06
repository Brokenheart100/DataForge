import type { CellValue } from '@shared/protocol'
import type { DriverFilter, DriverFilterOperator, SortSpec } from '../../domain/driver'
import { DataForgeError } from '../../domain/errors'

/** One statement and the values bound to its `$n` placeholders. */
export interface BuiltStatement {
  readonly text: string
  readonly values: readonly unknown[]
}

export interface ColumnValue {
  readonly column: string
  readonly value: unknown
}

/** PostgreSQL silently truncates identifiers longer than NAMEDATALEN - 1. */
const MAX_IDENTIFIER_LENGTH = 63

export function quoteIdentifier(name: string): string {
  if (name.length === 0) throw new DataForgeError('invalid_request', 'An empty identifier cannot be used.')
  if (name.includes('\0')) throw new DataForgeError('invalid_request', 'An identifier cannot contain NUL characters.')
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    const head = name.slice(0, 24)
    throw new DataForgeError('invalid_request', `Identifier "${head}…" is longer than ${MAX_IDENTIFIER_LENGTH} characters.`)
  }
  return `"${name.replaceAll('"', '""')}"`
}

export function quoteQualified(schema: string, relation: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(relation)}`
}

export function buildCountQuery(
  schema: string,
  relation: string,
  filters: readonly DriverFilter[] = [],
): BuiltStatement {
  const where = buildFilters(filters, filters.map((filter) => filter.column))
  const tail = where.text ? ` where ${where.text}` : ''
  return {
    text: `select count(*)::bigint as total from ${quoteQualified(schema, relation)}${tail}`,
    values: where.values,
  }
}

const OPERATOR_SQL: Record<DriverFilterOperator, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  contains: 'ilike',
  'is null': 'is null',
  'is not null': 'is not null',
}

/**
 * Builds a parameterised `where` clause. Column names are whitelisted against
 * the selected columns, and every comparison value becomes a bound parameter.
 */
export function buildFilters(
  filters: readonly DriverFilter[],
  allowedColumns: readonly string[],
  parameterOffset = 0,
): { text: string; values: CellValue[] } {
  const allowed = new Set(allowedColumns)
  const values: CellValue[] = []
  const parts: string[] = []
  for (const filter of filters) {
    if (!allowed.has(filter.column)) {
      throw new DataForgeError('invalid_request', `Cannot filter by unknown column "${filter.column}".`)
    }
    const operator = OPERATOR_SQL[filter.operator]
    if (!operator) {
      throw new DataForgeError('invalid_request', `Unsupported filter operator "${filter.operator}".`)
    }
    const column = quoteIdentifier(filter.column)
    if (filter.operator === 'is null' || filter.operator === 'is not null') {
      if (filter.value !== undefined) {
        throw new DataForgeError('invalid_request', `Filter on "${filter.column}" does not take a value.`)
      }
      parts.push(`${column} ${operator}`)
      continue
    }
    if (filter.value === undefined) {
      throw new DataForgeError('invalid_request', `Filter on "${filter.column}" needs a value.`)
    }
    if (filter.value === null && filter.operator !== 'eq' && filter.operator !== 'neq') {
      throw new DataForgeError('invalid_request', `Filter on "${filter.column}" cannot compare null.`)
    }
    if (filter.operator === 'contains') {
      values.push(`%${String(filter.value)}%`)
    } else {
      values.push(filter.value)
    }
    parts.push(`${column} ${operator} $${parameterOffset + values.length}`)
  }
  return { text: parts.join(' and '), values }
}

export interface PageQueryInput {
  readonly schema: string
  readonly relation: string
  readonly columns: readonly string[]
  readonly orderBy: readonly SortSpec[]
  readonly filters?: readonly DriverFilter[]
  readonly limit: number
  readonly offset: number
  /** Appends `xmin` for optimistic locking; views and foreign tables have none. */
  readonly withVersion?: boolean
}

/**
 * Page query for the data grid.
 *
 * `xmin` is appended after the requested columns when `withVersion` is set, so
 * every editable row carries the version used for optimistic locking; callers
 * read it as the trailing value. `limit` and `offset` are bound parameters, not
 * interpolated numbers.
 */
export function buildPageQuery(input: PageQueryInput): BuiltStatement {
  if (input.columns.length === 0) throw new DataForgeError('invalid_request', 'A page needs at least one selected column.')
  const projection = input.columns.map(quoteIdentifier).join(', ')
  const version = input.withVersion === true ? ', xmin::text' : ''
  const order = buildOrderBy(input.orderBy, input.columns)
  const filter = buildFilters(input.filters ?? [], input.columns)
  const limit = clampNonNegative(input.limit)
  const offset = clampNonNegative(input.offset)
  const table = quoteQualified(input.schema, input.relation)
  const where = filter.text ? ` where ${filter.text}` : ''
  const tail = order ? ` ${order}` : ''
  const limitIndex = filter.values.length + 1
  return {
    text: `select ${projection}${version} from ${table}${where}${tail} limit $${limitIndex} offset $${limitIndex + 1}`,
    values: [...filter.values, limit, offset],
  }
}

/** Ordering is restricted to selected columns so hidden columns stay hidden. */
export function buildOrderBy(orderBy: readonly SortSpec[], allowedColumns: readonly string[]): string {
  const allowed = new Set(allowedColumns)
  const parts = orderBy.map((sort) => {
    if (!allowed.has(sort.column)) {
      throw new DataForgeError('invalid_request', `Cannot sort by unknown column "${sort.column}".`)
    }
    const direction = sort.direction === 'desc' ? 'desc' : 'asc'
    return `${quoteIdentifier(sort.column)} ${direction}`
  })
  return parts.length === 0 ? '' : `order by ${parts.join(', ')}`
}

export function buildInsert(
  schema: string,
  relation: string,
  values: readonly ColumnValue[],
  returning: readonly string[] = [],
): BuiltStatement {
  if (values.length === 0) throw new DataForgeError('invalid_request', 'An insert needs at least one column.')
  const columns = values.map((entry) => quoteIdentifier(entry.column)).join(', ')
  const placeholders = values.map((_entry, index) => `$${index + 1}`).join(', ')
  return {
    text: `insert into ${quoteQualified(schema, relation)} (${columns}) values (${placeholders})${returningClause(returning)}`,
    values: values.map((entry) => entry.value),
  }
}

export function buildUpdate(
  schema: string,
  relation: string,
  changes: readonly ColumnValue[],
  identity: readonly ColumnValue[],
  version: string | null,
  returning: readonly string[] = [],
): BuiltStatement {
  if (changes.length === 0) throw new DataForgeError('invalid_request', 'An update needs at least one changed column.')
  const assignments = changes.map((entry, index) => `${quoteIdentifier(entry.column)} = $${index + 1}`).join(', ')
  const where = buildWhere(identity, version, changes.length)
  return {
    text: `update ${quoteQualified(schema, relation)} set ${assignments} where ${where.clause}${returningClause(returning)}`,
    values: [...changes.map((entry) => entry.value), ...where.values],
  }
}

export function buildDelete(
  schema: string,
  relation: string,
  identity: readonly ColumnValue[],
  version: string | null,
  returning: readonly string[] = [],
): BuiltStatement {
  const where = buildWhere(identity, version)
  return {
    text: `delete from ${quoteQualified(schema, relation)} where ${where.clause}${returningClause(returning)}`,
    values: where.values,
  }
}

/**
 * Primary-key predicate plus, when known, the `xmin` version.
 *
 * A version mismatch makes the statement affect zero rows, which the editor
 * treats as a conflict instead of overwriting someone else's change.
 */
export function buildWhere(
  identity: readonly ColumnValue[],
  version: string | null,
  parameterOffset = 0,
): { clause: string; values: unknown[] } {
  if (identity.length === 0) throw new DataForgeError('invalid_request', 'A row cannot be addressed without a primary key.')
  const values: unknown[] = []
  const parts = identity.map((entry) => {
    values.push(entry.value)
    return `${quoteIdentifier(entry.column)} = $${parameterOffset + values.length}`
  })
  if (version !== null) {
    values.push(version)
    parts.push(`xmin::text = $${parameterOffset + values.length}`)
  }
  return { clause: parts.join(' and '), values }
}

function returningClause(columns: readonly string[]): string {
  return columns.length === 0 ? '' : ` returning ${columns.map(quoteIdentifier).join(', ')}`
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}
