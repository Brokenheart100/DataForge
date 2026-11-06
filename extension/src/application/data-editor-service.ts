import type { CellValue } from '@shared/protocol'

import { assertEditable, primaryKeyColumns } from '../domain/data-edit'
import type { PendingChange } from '../domain/data-edit'
import { DataForgeError, wrapError } from '../domain/errors'
import { isDataEditingDriver } from './connection-service'
import type {
  ColumnInfo,
  DataEditingDriver,
  DataRow,
  MutationField,
  MutationResult,
  RelationInfo,
  RowIdentity,
  RowMutation,
  SortSpec,
} from '../domain/driver'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'
import type { SchemaService } from './schema-service'

export interface DataPageRequest {
  readonly connectionId: string
  /** A secondary database of the same connection; omitted means its own database. */
  readonly database?: string
  readonly schema: string
  readonly relation: string
  readonly limit: number
  readonly offset: number
  readonly orderBy?: readonly SortSpec[]
}

export interface DataPage {
  readonly columns: readonly ColumnInfo[]
  readonly primaryKey: readonly string[]
  readonly rows: readonly DataRow[]
  readonly totalRows: number
  readonly limit: number
  readonly offset: number
  /** False for views, foreign tables and tables without a primary key. */
  readonly editable: boolean
  readonly readOnlyReason?: string
}

/** One pending change plus the `xmin` the grid loaded it with. */
export interface CommitRow {
  readonly rowId: string
  readonly version: string | null
  readonly change: PendingChange
}

export interface CommitRequest {
  readonly connectionId: string
  /** A secondary database of the same connection; omitted means its own database. */
  readonly database?: string
  readonly schema: string
  readonly relation: string
  readonly rows: readonly CommitRow[]
  /** Envelope request id; registered so `cancel` can abort this commit. */
  readonly requestId?: string
}

export interface ChangeIssue {
  readonly rowId: string
  readonly column: string
  readonly message: string
}

export interface CommitResult {
  readonly inserted: number
  readonly updated: number
  readonly deleted: number
  /** Primary keys returned by INSERT … RETURNING, in insert order. */
  readonly returnedKeys: readonly (readonly CellValue[] | null)[]
}

const MIN_LIMIT = 1
const MAX_LIMIT = 1_000
const PAGE_DEFAULT = 200

const INTEGER_TYPES = new Set(['smallint', 'integer', 'bigint', 'int2', 'int4', 'int8', 'smallserial', 'serial', 'bigserial'])
const NUMERIC_TYPES = new Set(['numeric', 'decimal', 'real', 'double precision', 'money'])
const BOOLEAN_TYPES = new Set(['boolean', 'bool'])
const TEXT_TYPES = new Set(['character varying', 'character', 'bpchar', 'text', 'name', 'citext'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BOOLEAN_LITERALS = new Set(['true', 'false', 't', 'f', '1', '0', 'yes', 'no'])

export interface DataEditorDeps {
  readonly connections: ConnectionService
  readonly schemas: SchemaService
  readonly logger: Logger
}

/**
 * Browsing and writing rows of a single relation.
 *
 * All SQL is built by the driver from {@link RowMutation} data; this service
 * only decides *what* changes, validates them against the column metadata and
 * turns a conflict into a precise domain error.
 */
export class DataEditorService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly deps: DataEditorDeps) {}

  /** Aborts a running commit by request id; `false` when it already finished. */
  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async loadPage(request: DataPageRequest): Promise<DataPage> {
    const { connections, schemas, logger } = this.deps
    const profile = connections.get(request.connectionId)
    const secondary = request.database !== undefined && request.database !== profile.database
    const driver = secondary
      ? await this.scopedEditingDriver(request.connectionId, request.database)
      : connections.requireEditingDriver(request.connectionId)
    const relation = await this.relationInfo(request.connectionId, request.schema, request.relation, request.database)
    const columns = await schemas.listColumns(request.connectionId, request.schema, request.relation, request.database)
    const primaryKey = primaryKeyColumns(columns).map((column) => column.name)
    // Writes stay with the connection's own database; another one is browsable only.
    const readOnlyReason = secondary
      ? `Switch the connection to database "${request.database}" to edit this relation.`
      : this.readOnlyReason(relation, columns)
    const limit = clamp(request.limit, MIN_LIMIT, MAX_LIMIT, PAGE_DEFAULT)
    const offset = Math.max(0, Math.trunc(request.offset))

    try {
      const page = await driver.selectPage({
        schema: request.schema,
        relation: request.relation,
        columns: columns.map((column) => column.name),
        identityColumns: primaryKey,
        withVersion: readOnlyReason === undefined,
        orderBy: request.orderBy ?? [],
        limit,
        offset,
      })
      return {
        columns,
        primaryKey,
        rows: page.rows,
        totalRows: page.totalRows,
        limit,
        offset,
        editable: readOnlyReason === undefined,
        ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
      }
    } catch (error) {
      logger.warn(`Loading page of ${request.schema}.${request.relation} failed: ${String(error)}`)
      throw wrapError('query_failed', 'Loading the page', error)
    }
  }

  validateChanges(columns: readonly ColumnInfo[], rows: readonly CommitRow[]): readonly ChangeIssue[] {
    const issues: ChangeIssue[] = []
    const byName = new Map(columns.map((column) => [column.name, column]))
    const primaryKey = primaryKeyColumns(columns).map((column) => column.name)

    for (const row of rows) {
      const { change } = row
      if (change.kind === 'insert') {
        for (const column of columns) {
          if (column.nullable || column.defaultValue !== null) continue
          if (change.values[column.name] !== undefined) continue
          issues.push({ rowId: row.rowId, column: column.name, message: `Column "${column.name}" is required.` })
        }
      } else {
        for (const name of primaryKey) {
          const value = change.identity[name]
          if (value === undefined || value === null) {
            issues.push({ rowId: row.rowId, column: name, message: `The row identity is missing the primary key "${name}".` })
          }
        }
        if (change.kind === 'update' && Object.keys(change.values).length === 0) {
          issues.push({ rowId: row.rowId, column: '*', message: 'The change has no values to write.' })
        }
      }

      for (const [name, value] of Object.entries(change.kind === 'delete' ? {} : change.values)) {
        const column = byName.get(name)
        if (!column) {
          issues.push({ rowId: row.rowId, column: name, message: `Column "${name}" does not exist on this relation.` })
          continue
        }
        const message = checkValue(column, value)
        if (message !== undefined) issues.push({ rowId: row.rowId, column: name, message })
      }
    }

    return issues
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    const { connections, schemas } = this.deps
    const profile = connections.get(request.connectionId)
    if (profile?.readOnly) throw new DataForgeError('invalid_request', 'This connection is read-only, so nothing was saved.')
    if (request.database !== undefined && request.database !== profile.database) {
      throw new DataForgeError(
        'invalid_request',
        `Switch the connection to database "${request.database}" before saving changes.`,
      )
    }

    const driver = connections.requireEditingDriver(request.connectionId)
    const relation = await this.relationInfo(request.connectionId, request.schema, request.relation)
    const columns = await schemas.listColumns(request.connectionId, request.schema, request.relation)
    assertEditable(relation, columns)

    const issues = this.validateChanges(columns, request.rows)
    if (issues.length > 0) {
      const preview = issues
        .slice(0, 5)
        .map((issue) => `${issue.column}: ${issue.message}`)
        .join(' ')
      const suffix = issues.length > 5 ? ` (+${issues.length - 5} more)` : ''
      throw new DataForgeError('invalid_request', `${preview}${suffix}`)
    }

    if (request.rows.length === 0) return { inserted: 0, updated: 0, deleted: 0, returnedKeys: [] }

    const primaryKey = primaryKeyColumns(columns).map((column) => column.name)
    const mutations = request.rows.map((row) => toMutation(row, primaryKey))
    const controller = request.requestId === undefined ? undefined : new AbortController()
    if (request.requestId !== undefined && controller) this.controllers.set(request.requestId, controller)
    let results: readonly MutationResult[]
    try {
      results = await driver.applyMutations({
        schema: request.schema,
        relation: request.relation,
        mutations,
        signal: controller?.signal,
      })
    } catch (error) {
      throw wrapError('query_failed', 'Saving changes', error)
    } finally {
      if (request.requestId !== undefined) this.controllers.delete(request.requestId)
    }

    let inserted = 0
    let updated = 0
    let deleted = 0
    const returnedKeys: (readonly CellValue[] | null)[] = []
    results.forEach((result, index) => {
      const mutation = mutations[index]
      if (!mutation) return
      if (mutation.kind === 'insert') {
        inserted += 1
        returnedKeys.push(result.returned)
      } else if (mutation.kind === 'update') {
        updated += result.rowCount
      } else {
        deleted += result.rowCount
      }
    })

    this.deps.logger.info(
      `Saved ${inserted} insert(s), ${updated} update(s) and ${deleted} delete(s) on ${request.schema}.${request.relation}`,
    )
    return { inserted, updated, deleted, returnedKeys }
  }

  private async scopedEditingDriver(connectionId: string, database: string | undefined): Promise<DataEditingDriver> {
    const driver = await this.deps.connections.requireScopedDriver(connectionId, database)
    if (!isDataEditingDriver(driver)) {
      throw new DataForgeError('internal', 'This connection does not support data editing yet.')
    }
    return driver
  }

  private readOnlyReason(relation: RelationInfo, columns: readonly ColumnInfo[]): string | undefined {
    try {
      assertEditable(relation, columns)
      return undefined
    } catch (error) {
      return error instanceof DataForgeError ? error.message : String(error)
    }
  }

  private async relationInfo(
    connectionId: string,
    schema: string,
    relation: string,
    database?: string,
  ): Promise<RelationInfo> {
    const relations = await this.deps.schemas.listRelations(connectionId, schema, database)
    const match = relations.find((entry) => entry.name === relation)
    if (!match) throw new DataForgeError('not_found', `Relation "${schema}.${relation}" no longer exists.`)
    return match
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(parsed, min), max)
}

function toMutation(row: CommitRow, primaryKey: readonly string[]): RowMutation {
  const { change } = row
  if (change.kind === 'insert') {
    return { kind: 'insert', values: toFields(change.values), identity: [], version: null, returning: primaryKey }
  }
  if (change.kind === 'update') {
    return { kind: 'update', values: toFields(change.values), identity: toFields(change.identity), version: row.version, returning: [] }
  }
  return { kind: 'delete', values: [], identity: toFields(change.identity), version: row.version, returning: [] }
}

function toFields(values: RowIdentity): MutationField[] {
  return Object.entries(values).map(([column, value]) => ({ column, value }))
}

function checkValue(column: ColumnInfo, value: CellValue): string | undefined {
  if (value === null) return column.nullable ? undefined : `Column "${column.name}" does not allow NULL.`

  const dataType = column.dataType.toLowerCase()
  const baseType = dataType.replace(/\(.*\)/, '').trim()
  const text = String(value)
  const label = `Column "${column.name}"`

  if (TEXT_TYPES.has(baseType)) {
    const limit = declaredLength(dataType)
    if (limit !== undefined && text.length > limit) return `${label} accepts at most ${limit} characters.`
    return undefined
  }
  if (INTEGER_TYPES.has(baseType)) {
    const numeric = typeof value === 'number' ? value : Number(text)
    if (!Number.isInteger(numeric)) return `${label} expects a whole number.`
    return undefined
  }
  if (NUMERIC_TYPES.has(baseType)) {
    if (text.trim() === '' || !Number.isFinite(Number(text))) return `${label} expects a number.`
    return undefined
  }
  if (BOOLEAN_TYPES.has(baseType)) {
    if (typeof value === 'boolean') return undefined
    return BOOLEAN_LITERALS.has(text.toLowerCase()) ? undefined : `${label} expects true or false.`
  }
  if (baseType === 'uuid') {
    return UUID_PATTERN.test(text) ? undefined : `${label} expects a UUID.`
  }
  if (baseType === 'json' || baseType === 'jsonb') {
    try {
      JSON.parse(text)
      return undefined
    } catch {
      return `${label} expects valid JSON.`
    }
  }
  if (baseType.startsWith('date') || baseType.startsWith('timestamp') || baseType.startsWith('time')) {
    return Number.isNaN(Date.parse(text)) ? `${label} expects a valid date or time.` : undefined
  }
  return undefined
}

function declaredLength(dataType: string): number | undefined {
  const match = /\((\d+)(?:\s*,\s*\d+)?\)/.exec(dataType)
  const digits = match?.[1]
  if (!digits) return undefined
  const parsed = Number(digits)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
