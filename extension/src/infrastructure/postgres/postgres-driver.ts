import { performance } from 'node:perf_hooks'

import { Client, Pool } from 'pg'
import type { PoolClient, QueryResult } from 'pg'
import Cursor from 'pg-cursor'

import type { CellValue, ColumnDto, SslMode } from '@shared/protocol'
import type { ConnectionConfig } from '../../domain/connection'
import type {
  ColumnInfo,
  DataEditingDriver,
  DataRow,
  DriverCapabilities,
  DriverPageInput,
  DriverPageResult,
  DriverQueryInput,
  DriverQueryResult,
  DriverSession,
  MutationBatch,
  MutationField,
  MutationResult,
  RelationInfo,
  RelationKind,
  RowMutation,
  ServerInfo,
  StreamResult,
  TableExportDriver,
  DriverStreamInput,
  TransactionalDriver,
} from '../../domain/driver'
import { DataConflictError, DataForgeError, redactSecrets } from '../../domain/errors'
import { toCellValue } from '../cells'
import { buildCountQuery, buildDelete, buildInsert, buildPageQuery, buildUpdate, quoteQualified } from './sql-builder'
import type { BuiltStatement, ColumnValue } from './sql-builder'

export interface PostgresSettings {
  readonly connectTimeoutMs: number
  readonly statementTimeoutMs: number
  /** Receives background pool errors (idle clients dropped by the server). */
  readonly onBackgroundError?: (message: string) => void
}

/** Common PostgreSQL type OIDs, used to label result columns. */
const TYPE_NAMES: ReadonlyMap<number, string> = new Map([
  [16, 'bool'], [17, 'bytea'], [18, 'char'], [19, 'name'], [20, 'int8'], [21, 'int2'], [23, 'int4'],
  [25, 'text'], [26, 'oid'], [114, 'json'], [700, 'float4'], [701, 'float8'], [869, 'inet'],
  [1042, 'bpchar'], [1043, 'varchar'], [1082, 'date'], [1083, 'time'], [1114, 'timestamp'],
  [1184, 'timestamptz'], [1186, 'interval'], [1700, 'numeric'], [2950, 'uuid'], [3802, 'jsonb'],
])

const RELATION_KINDS: Readonly<Record<string, RelationKind>> = {
  r: 'table',
  p: 'partitioned table',
  v: 'view',
  m: 'materialized view',
  f: 'foreign table',
}

const RELATION_KIND_CODES = ['r', 'p', 'v', 'm', 'f']

const SCHEMA_SQL = `
  select nspname
  from pg_catalog.pg_namespace
  where nspname not like 'pg\\_%' and nspname <> 'information_schema'
  order by nspname`

const RELATION_SQL = `
  select c.relname as name, c.relkind as kind
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relkind = any ($2::char[])
  order by c.relname`

const COLUMN_SQL = `
  select
    a.attname as name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
    not a.attnotnull as nullable,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_value,
    a.attnum as ordinal,
    exists (
      select 1 from pg_catalog.pg_index i
      where i.indrelid = c.oid and i.indisprimary and a.attnum = any (i.indkey)
    ) as is_primary_key
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
  order by a.attnum`

const SERVER_INFO_SQL =
  "select current_setting('server_version') as version, current_database() as database, current_user as user"

function sslOptions(mode: SslMode): false | { rejectUnauthorized: boolean } {
  if (mode === 'disable') return false
  // `require` mirrors libpq: TLS without CA verification. `verify-full` verifies
  // the chain and the hostname through Node's default CA store.
  return { rejectUnauthorized: mode === 'verify-full' }
}

function toColumns(fields: readonly { name: string; dataTypeID: number }[]): ColumnDto[] {
  return fields.map((field) => ({
    name: field.name,
    dataType: TYPE_NAMES.get(field.dataTypeID) ?? `oid:${field.dataTypeID}`,
  }))
}

function toDataRow(row: readonly unknown[], input: DriverPageInput): DataRow {
  const values = row.slice(0, input.columns.length).map(toCellValue)
  const identity: Record<string, CellValue> = {}
  for (const name of input.identityColumns) {
    const index = input.columns.indexOf(name)
    identity[name] = index === -1 ? null : (values[index] ?? null)
  }
  const version = input.withVersion === true ? row[input.columns.length] : null
  return { values, identity, version: version === null || version === undefined ? null : String(version) }
}

function toCount(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function toColumnValues(fields: readonly MutationField[]): ColumnValue[] {
  return fields.map((field) => ({ column: field.column, value: field.value }))
}

function buildMutation(batch: MutationBatch, mutation: RowMutation): BuiltStatement {
  const { schema, relation } = batch
  switch (mutation.kind) {
    case 'insert':
      return buildInsert(schema, relation, toColumnValues(mutation.values), mutation.returning)
    case 'update':
      return buildUpdate(
        schema,
        relation,
        toColumnValues(mutation.values),
        toColumnValues(mutation.identity),
        mutation.version,
        mutation.returning,
      )
    case 'delete':
      return buildDelete(schema, relation, toColumnValues(mutation.identity), mutation.version, mutation.returning)
  }
}

/** `id=42, tenant=acme` — readable in logs and in the conflict toast. */
function describeIdentity(mutation: RowMutation): string {
  const parts = mutation.identity.map((field) => `${field.column}=${field.value === null ? 'null' : String(field.value)}`)
  return parts.length > 0 ? parts.join(', ') : '(no key)'
}

interface PgErrorLike {
  readonly code?: unknown
  readonly message?: unknown
  readonly detail?: unknown
  readonly hint?: unknown
  readonly position?: unknown
}

function isPgError(value: unknown): value is PgErrorLike {
  return typeof value === 'object' && value !== null && typeof (value as PgErrorLike).code === 'string'
}

/** Cancellation SQLSTATEs: query_canceled, admin_shutdown, crash_shutdown. */
const CANCEL_CODES = new Set(['57014', '57P01', '57P02'])

export function mapPgError(error: unknown): DataForgeError {
  if (error instanceof DataForgeError) return error
  if (!isPgError(error)) {
    const message = error instanceof Error ? error.message : String(error)
    return new DataForgeError('internal', redactSecrets(message))
  }

  const code = String(error.code)
  const message = redactSecrets(String(error.message ?? 'PostgreSQL error'))
  if (CANCEL_CODES.has(code)) {
    return new DataForgeError('cancelled', 'Query was cancelled.')
  }

  const parts = [message]
  if (typeof error.detail === 'string') parts.push(`Detail: ${redactSecrets(error.detail)}`)
  if (typeof error.hint === 'string') parts.push(`Hint: ${redactSecrets(error.hint)}`)
  if (typeof error.position === 'string') parts.push(`Position: ${error.position}`)
  const kind = code.startsWith('08') || code.startsWith('28') ? 'connection_failed' : 'query_failed'
  return new DataForgeError(kind, `[${code}] ${parts.join('\n')}`)
}

export class PostgresDriver implements DataEditingDriver, TableExportDriver, TransactionalDriver {
  readonly kind = 'postgresql'
  readonly capabilities: DriverCapabilities = { transactions: true, returning: true, identifierQuote: '"' }

  private readonly pool: Pool
  private disposed = false

  constructor(
    private readonly config: ConnectionConfig,
    private readonly settings: PostgresSettings,
  ) {
    const { profile, credentials } = config
    this.pool = new Pool({
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password: credentials.password,
      application_name: 'DataForge',
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: settings.connectTimeoutMs,
      ssl: sslOptions(profile.ssl),
      onConnect: async (client) => {
        if (settings.statementTimeoutMs > 0) {
          // The value is a validated integer, never user SQL.
          await client.query(`set statement_timeout = ${Math.trunc(settings.statementTimeoutMs)}`)
        }
      },
    })
    this.pool.on('error', (error: Error) => {
      settings.onBackgroundError?.(redactSecrets(error.message))
    })
  }

  /** Opens a throw-away connection so a draft can be validated before saving. */
  static async probe(config: ConnectionConfig, settings: PostgresSettings): Promise<ServerInfo> {
    const driver = new PostgresDriver(config, { ...settings, statementTimeoutMs: 0 })
    try {
      return await driver.testConnection()
    } finally {
      await driver.dispose()
    }
  }

  async testConnection(): Promise<ServerInfo> {
    const client = await this.acquire()
    try {
      return await this.readServerInfo(client)
    } finally {
      client.release()
    }
  }

  async query({ sql, maxRows, signal }: DriverQueryInput): Promise<DriverQueryResult> {
    if (!sql.trim()) throw new DataForgeError('invalid_request', 'Nothing to execute: the SQL buffer is empty.')
    const client = await this.acquire()
    const started = performance.now()
    let destroyClient = false

    try {
      const pid = await this.backendPid(client)
      const onAbort = (): void => {
        void this.terminateBackend(pid)
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        if (signal?.aborted) throw new DataForgeError('cancelled', 'Query was cancelled before it started.')
        const raw = await client.query<unknown[]>({ text: sql, rowMode: 'array' })
        return this.toResult(raw, maxRows, performance.now() - started)
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    } catch (error) {
      // A terminated backend cannot be reused; destroying it keeps the pool clean.
      destroyClient = signal?.aborted === true
      throw mapPgError(error)
    } finally {
      client.release(destroyClient)
    }
  }

  async openSession(): Promise<DriverSession> {
    const client = await this.acquire()
    try {
      await client.query('begin')
    } catch (error) {
      client.release(true)
      throw mapPgError(error)
    }

    let closed = false
    const release = (destroy: boolean): void => {
      if (closed) return
      closed = true
      client.release(destroy)
    }

    return {
      query: async (input: DriverQueryInput): Promise<DriverQueryResult> => {
        if (closed) throw new DataForgeError('invalid_request', 'This transaction is no longer open.')
        if (!input.sql.trim()) throw new DataForgeError('invalid_request', 'Nothing to execute: the SQL buffer is empty.')
        const started = performance.now()
        try {
          const raw = await client.query<unknown[]>({ text: input.sql, rowMode: 'array' })
          return this.toResult(raw, input.maxRows, performance.now() - started)
        } catch (error) {
          throw mapPgError(error)
        }
      },
      commit: async (): Promise<void> => {
        if (closed) return
        try {
          await client.query('commit')
        } catch (error) {
          release(true)
          throw mapPgError(error)
        }
        release(false)
      },
      rollback: async (): Promise<void> => {
        if (closed) return
        try {
          await client.query('rollback')
        } catch (error) {
          release(true)
          throw mapPgError(error)
        }
        release(false)
      },
      close: async (): Promise<void> => {
        if (closed) return
        try {
          await client.query('rollback')
        } catch {
          release(true)
          return
        }
        release(false)
      },
    }
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.runScalarQuery<{ nspname: string }>(SCHEMA_SQL)
    return result.map((row) => row.nspname)
  }

  async listRelations(schema: string): Promise<RelationInfo[]> {
    const result = await this.runScalarQuery<{ name: string; kind: string }>(RELATION_SQL, [
      schema,
      RELATION_KIND_CODES,
    ])
    return result.map((row) => ({
      schema,
      name: row.name,
      kind: RELATION_KINDS[row.kind] ?? 'table',
    }))
  }

  async listColumns(schema: string, relation: string): Promise<ColumnInfo[]> {
    const result = await this.runScalarQuery<{
      name: string
      data_type: string
      nullable: boolean
      default_value: string | null
      ordinal: number
      is_primary_key: boolean
    }>(COLUMN_SQL, [schema, relation])

    return result.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      nullable: row.nullable,
      defaultValue: row.default_value,
      isPrimaryKey: row.is_primary_key,
      ordinal: row.ordinal,
    }))
  }

  async selectPage(input: DriverPageInput): Promise<DriverPageResult> {
    if (input.columns.length === 0) throw new DataForgeError('invalid_request', 'A page needs at least one selected column.')
    const client = await this.acquire()
    try {
      const page = buildPageQuery(input)
      const result = await client.query<unknown[]>({
        text: page.text,
        values: [...page.values],
        rowMode: 'array',
      })
      const rows = result.rows.map((row) => toDataRow(row, input))
      const total = await client.query<{ total: string }>(buildCountQuery(input.schema, input.relation).text)
      return { rows, totalRows: toCount(total.rows[0]?.total) }
    } catch (error) {
      throw mapPgError(error)
    } finally {
      client.release()
    }
  }

  async countRows(schema: string, relation: string): Promise<number> {
    const rows = await this.runScalarQuery<{ total: string }>(buildCountQuery(schema, relation).text)
    return toCount(rows[0]?.total)
  }

  /**
   * Runs every mutation on one exclusive client.
   *
   * A failed statement rolls the whole batch back, so a conflict detected
   * halfway never leaves a partially updated table behind. Update and delete
   * statements must match exactly one row: zero affected rows means the row
   * moved on (`xmin` changed) or was deleted, which aborts the transaction
   * with a {@link DataConflictError} listing the identities.
   */
  async applyMutations(batch: MutationBatch): Promise<readonly MutationResult[]> {
    if (batch.mutations.length === 0) return []
    const client = await this.acquire()
    let destroyClient = false
    try {
      await client.query('begin')
      const results: MutationResult[] = []
      const conflicts: string[] = []
      for (const mutation of batch.mutations) {
        if (batch.signal?.aborted) throw new DataForgeError('cancelled', 'The commit was cancelled.')
        const statement = buildMutation(batch, mutation)
        const raw = await client.query<unknown[]>({
          text: statement.text,
          values: [...statement.values],
          rowMode: 'array',
        })
        const first = raw.rows[0]
        const affected = raw.rowCount ?? 0
        if (mutation.kind !== 'insert' && affected === 0) {
          conflicts.push(describeIdentity(mutation))
        }
        results.push({ rowCount: affected, returned: first ? first.map(toCellValue) : null })
      }
      if (conflicts.length > 0) throw new DataConflictError(conflicts)
      await client.query('commit')
      return results
    } catch (error) {
      try {
        await client.query('rollback')
      } catch {
        destroyClient = true
      }
      throw mapPgError(error)
    } finally {
      client.release(destroyClient)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.pool.end()
  }

  private async runScalarQuery<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    const client = await this.acquire()
    try {
      const result = await client.query<T>(sql, values as unknown[])
      return result.rows
    } catch (error) {
      throw mapPgError(error)
    } finally {
      client.release()
    }
  }

  /**
   * Streams every row of a relation through a server-side cursor.
   *
   * `statement_timeout` is disabled for this session because a large export
   * legitimately outlives the interactive timeout; it is restored before the
   * client returns to the pool so the next query is protected again.
   */
  async exportTable(
    { schema, relation, batchSize, signal }: DriverStreamInput,
    onBatch: (rows: readonly (readonly CellValue[])[]) => void | Promise<void>,
  ): Promise<StreamResult> {
    const client = await this.acquire()
    const timeout = Math.trunc(this.settings.statementTimeoutMs)
    let cursor: Cursor | undefined
    let destroyClient = false

    try {
      await client.query(`set statement_timeout = 0`)
      cursor = new Cursor(`select * from ${quoteQualified(schema, relation)}`, undefined, { rowMode: 'array' })
      // `pg` accepts a query object exposing `submit`, which is what a Cursor is.
      client.query(cursor as never)

      let rowCount = 0
      for (;;) {
        if (signal?.aborted) throw new DataForgeError('cancelled', 'The export was cancelled.')
        const rows = await cursor.read(Math.max(1, Math.trunc(batchSize)))
        if (rows.length === 0) break
        rowCount += rows.length
        await onBatch(rows.map((row) => row.map((value) => toCellValue(value))))
      }
      return { rowCount }
    } catch (error) {
      throw mapPgError(error)
    } finally {
      if (cursor) {
        try {
          await cursor.close()
        } catch {
          destroyClient = true
        }
      }
      try {
        await client.query(`set statement_timeout = ${timeout}`)
      } catch {
        destroyClient = true
      }
      client.release(destroyClient)
    }
  }

  private async acquire(): Promise<PoolClient> {
    if (this.disposed) throw new DataForgeError('connection_failed', 'This connection is closed.')
    try {
      return await this.pool.connect()
    } catch (error) {
      throw mapPgError(error)
    }
  }

  private async readServerInfo(client: PoolClient): Promise<ServerInfo> {
    const result = await client.query<{ version: string; database: string; user: string }>(SERVER_INFO_SQL)
    const row = result.rows[0]
    if (!row) throw new DataForgeError('connection_failed', 'The server returned no identity information.')
    return { serverVersion: `PostgreSQL ${row.version}`, database: row.database, user: row.user }
  }

  private async backendPid(client: PoolClient): Promise<number> {
    const result = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
    const pid = result.rows[0]?.pid
    if (typeof pid !== 'number') throw new DataForgeError('internal', 'Could not read the backend process id.')
    return pid
  }

  /**
   * Cancels execution out-of-band: a dedicated client terminates the backend
   * that runs the query. `pg_terminate_backend` on your own backend needs no
   * superuser, unlike `pg_cancel_backend` on another role's session.
   */
  private async terminateBackend(pid: number): Promise<void> {
    const { profile, credentials } = this.config
    const client = new Client({
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password: credentials.password,
      ssl: sslOptions(profile.ssl),
      application_name: 'DataForge (cancel)',
      connectionTimeoutMillis: this.settings.connectTimeoutMs,
    })
    try {
      await client.connect()
      await client.query('select pg_terminate_backend($1)', [pid])
    } catch (error) {
      this.settings.onBackgroundError?.(`Cancel request failed: ${mapPgError(error).message}`)
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  private toResult(raw: QueryResult<unknown[]> | QueryResult<unknown[]>[], maxRows: number, durationMs: number): DriverQueryResult {
    const results = Array.isArray(raw) ? raw : [raw]
    const last = results[results.length - 1]
    if (!last) throw new DataForgeError('query_failed', 'The statement produced no result.')

    const allRows = last.rows ?? []
    const truncated = allRows.length > maxRows
    const visible = truncated ? allRows.slice(0, maxRows) : allRows
    const rows = visible.map((row) => row.map(toCellValue))

    return {
      columns: toColumns(last.fields ?? []),
      rows,
      command: last.command || 'UNKNOWN',
      durationMs: Math.round(durationMs),
      truncated,
      affectedRows: last.command === 'SELECT' ? null : last.rowCount,
    }
  }
}
