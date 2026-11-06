import { performance } from 'node:perf_hooks'

import { Client, Pool } from 'pg'
import type { PoolClient, QueryResult } from 'pg'
import Cursor from 'pg-cursor'

import type { CellValue, ColumnDto, SslMode } from '@shared/protocol'
import type { ConnectionConfig } from '../../domain/connection'
import type {
  ColumnInfo,
  DataEditingDriver,
  DdlDriver,
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
  ObjectCatalogDriver,
  ObjectIndex,
  ObjectStats,
  RelationInfo,
  RelationKind,
  RowMutation,
  ServerInfo,
  ServerSessionInfo,
  SessionDriver,
  StreamResult,
  TableExportDriver,
  DriverStreamInput,
  TransactionalDriver,
} from '../../domain/driver'
import { DataConflictError, DataForgeError, redactSecrets } from '../../domain/errors'
import { toCellValue } from '../cells'
import {
  buildCountQuery,
  buildDelete,
  buildInsert,
  buildPageQuery,
  buildUpdate,
  quoteIdentifier,
  quoteQualified,
} from './sql-builder'
import type { BuiltStatement, ColumnValue } from './sql-builder'

type IndexRow = {
  readonly name: string
  readonly definition: string
  readonly unique_index: boolean
  readonly primary_index: boolean
  readonly bytes: string | null
}

function toBytes(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

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

const DATABASE_SQL = `
  select datname
  from pg_catalog.pg_database
  where not datistemplate and datallowconn
  order by datname`

const RELATION_SQL = `
  select c.relname as name, c.relkind as kind
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relkind = any ($2::char[])
  order by c.relname`

const OBJECT_SEARCH_SQL = `
  select n.nspname as schema, c.relname as name, c.relkind as kind
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind = any ($3::char[])
    and (c.relname ilike $1 or n.nspname ilike $1 or (n.nspname || '.' || c.relname) ilike $1)
  order by n.nspname, c.relname
  limit $2`

const VIEW_DEF_SQL = `
  select pg_catalog.pg_get_viewdef(c.oid) as definition
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relname = $2`

const PRIMARY_KEY_SQL = `
  select con.conname as name, pg_catalog.pg_get_constraintdef(con.oid) as definition
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class c on c.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relname = $2 and con.contype = 'p'`

const INDEX_SQL = `
  select
    ic.relname as name,
    pg_catalog.pg_get_indexdef(i.indexrelid) as definition,
    i.indisunique as unique_index,
    i.indisprimary as primary_index,
    pg_catalog.pg_relation_size(i.indexrelid) as bytes
  from pg_catalog.pg_index i
  join pg_catalog.pg_class ic on ic.oid = i.indexrelid
  join pg_catalog.pg_class tc on tc.oid = i.indrelid
  join pg_catalog.pg_namespace n on n.oid = tc.relnamespace
  where n.nspname = $1 and tc.relname = $2
  order by ic.relname`

const OBJECT_STATS_SQL = `
  select
    pg_catalog.pg_total_relation_size(c.oid) as total_bytes,
    pg_catalog.pg_relation_size(c.oid) as heap_bytes,
    c.reltuples::bigint as row_estimate
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relname = $2`

const PARTITION_KEY_SQL = `
  select pg_catalog.pg_get_partkeydef(c.oid) as definition
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1 and c.relname = $2`

const COLUMN_SQL = `
  select
    a.attname as name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
    not a.attnotnull as nullable,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_value,
    a.attnum as ordinal,
    a.attgenerated <> '' as generated,
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

/**
 * Other client backends, newest activity last. `activity_start` is when the
 * current statement (or transaction) began, falling back to the login time so
 * an idle session still reports a sensible age.
 */
const SESSIONS_SQL = `
select pid::text as id,
       usename as "user",
       datname as database,
       application_name as application,
       host(client_addr) as client,
       state,
       backend_start as started_at,
       coalesce(query_start, xact_start, backend_start) as activity_start,
       greatest(0, floor(extract(epoch from (now() - coalesce(query_start, xact_start, backend_start))) * 1000))::bigint as duration_ms,
       left(coalesce(query, ''), 500) as query,
       nullif(concat_ws(':', wait_event_type, wait_event), '') as wait_event
from pg_stat_activity
where pid <> pg_backend_pid()
  and backend_type = 'client backend'
order by activity_start asc`

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

export class PostgresDriver
  implements
    DataEditingDriver,
    TableExportDriver,
    TransactionalDriver,
    ObjectCatalogDriver,
    DdlDriver,
    SessionDriver
{
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

  async listDatabases(): Promise<string[]> {
    const result = await this.runScalarQuery<{ datname: string }>(DATABASE_SQL)
    return result.map((row) => row.datname)
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
      generated: boolean
    }>(COLUMN_SQL, [schema, relation])

    return result.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      nullable: row.nullable,
      defaultValue: row.default_value,
      isPrimaryKey: row.is_primary_key,
      ordinal: row.ordinal,
      generated: row.generated,
    }))
  }

  async searchObjects(query: string, limit: number): Promise<RelationInfo[]> {
    const rows = await this.runScalarQuery<{ schema: string; name: string; kind: string }>(
      OBJECT_SEARCH_SQL,
      [`%${query}%`, Math.max(1, Math.trunc(limit)), RELATION_KIND_CODES],
    )
    return rows.map((row) => ({ schema: row.schema, name: row.name, kind: RELATION_KINDS[row.kind] ?? 'table' }))
  }

  /**
   * PostgreSQL has no "show create" for tables, so the statement is rebuilt
   * from the catalog the way pg_dump does. Views reuse `pg_get_viewdef`, and
   * index definitions come verbatim from `pg_get_indexdef`.
   */
  async objectDdl(relation: RelationInfo): Promise<string> {
    if (relation.kind === 'view' || relation.kind === 'materialized view') {
      const def = await this.runScalarQuery<{ definition: string }>(VIEW_DEF_SQL, [relation.schema, relation.name])
      const keyword = relation.kind === 'view' ? 'view' : 'materialized view'
      const body = (def[0]?.definition ?? 'select 1').trim().replace(/;$/, '')
      return `create ${keyword} ${quoteQualified(relation.schema, relation.name)} as
${body};`
    }
    if (relation.kind === 'foreign table') {
      throw new DataForgeError('invalid_request', 'DDL for foreign tables is not supported yet.')
    }

    const columns = await this.listColumns(relation.schema, relation.name)
    if (columns.length === 0) {
      throw new DataForgeError('not_found', `Relation "${relation.schema}.${relation.name}" no longer exists.`)
    }
    const primary = await this.runScalarQuery<{ name: string; definition: string }>(PRIMARY_KEY_SQL, [
      relation.schema,
      relation.name,
    ])
    const indexes = await this.runScalarQuery<IndexRow>(INDEX_SQL, [relation.schema, relation.name])
    const partition =
      relation.kind === 'partitioned table'
        ? await this.runScalarQuery<{ definition: string }>(PARTITION_KEY_SQL, [relation.schema, relation.name])
        : []

    const lines = columns.map((column) => {
      const parts = [quoteIdentifier(column.name), column.dataType]
      if (!column.nullable) parts.push('not null')
      if (column.defaultValue !== null) parts.push(`default ${column.defaultValue}`)
      return `  ${parts.join(' ')}`
    })
    const key = primary[0]
    if (key) lines.push(`  constraint ${quoteIdentifier(key.name)} ${key.definition}`)

    const suffix = partition[0]?.definition ? `
partition by ${partition[0].definition}` : ''
    const body = lines.join(`,
`)
    const statements = [`create table ${quoteQualified(relation.schema, relation.name)} (
${body}
)${suffix};`]
    for (const index of indexes) {
      if (index.primary_index) continue
      statements.push(`${index.definition.trim().replace(/;$/, '')};`)
    }
    if (relation.kind === 'partitioned table') {
      statements.push('-- Partitions are not reproduced; create them with "create table … partition of".')
    }
    return statements.join('\n\n')
  }

  async objectStats(relation: RelationInfo): Promise<ObjectStats> {
    const rows = await this.runScalarQuery<{
      total_bytes: string | null
      heap_bytes: string | null
      row_estimate: string | null
    }>(OBJECT_STATS_SQL, [relation.schema, relation.name])
    const row = rows[0]
    const indexes = await this.runScalarQuery<IndexRow>(INDEX_SQL, [relation.schema, relation.name])
    const secondary = indexes.filter((index) => !index.primary_index)
    const indexBytes = secondary.reduce((total, index) => total + (toBytes(index.bytes) ?? 0), 0)
    const estimate = row?.row_estimate === null || row?.row_estimate === undefined ? null : Number(row.row_estimate)
    return {
      totalBytes: toBytes(row?.total_bytes),
      rowEstimate: estimate === null || !Number.isFinite(estimate) || estimate < 0 ? null : estimate,
      indexBytes: secondary.length === 0 ? null : indexBytes,
      indexes: secondary.map(
        (index): ObjectIndex => ({
          name: index.name,
          bytes: toBytes(index.bytes),
          unique: index.unique_index,
          definition: index.definition,
        }),
      ),
    }
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
      const count = buildCountQuery(input.schema, input.relation, input.filters ?? [])
      const total = await client.query<{ total: string }>({ text: count.text, values: [...count.values] })
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
  /**
   * Runs structural statements in one transaction.
   *
   * PostgreSQL DDL is transactional, so a failing `alter`/`create` rolls back
   * everything before it. The caller has already validated the plan.
   */
  async applyDdl(statements: readonly string[]): Promise<number> {
    if (statements.length === 0) return 0
    const client = await this.acquire()
    let destroyClient = false
    try {
      await client.query('begin')
      for (const statement of statements) await client.query(statement)
      await client.query('commit')
      return statements.length
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

  async listSessions(): Promise<readonly ServerSessionInfo[]> {
    const rows = await this.runScalarQuery<{
      id: string
      user: string | null
      database: string | null
      application: string | null
      client: string | null
      state: string | null
      started_at: Date | string | null
      duration_ms: string | number | null
      query: string | null
      wait_event: string | null
    }>(SESSIONS_SQL)
    return rows.map((row) => {
      const session: { -readonly [K in keyof ServerSessionInfo]: ServerSessionInfo[K] } = { id: row.id }
      if (row.user !== null) session.user = row.user
      if (row.database !== null) session.database = row.database
      if (row.application) session.application = row.application
      if (row.client !== null) session.client = row.client
      if (row.state !== null) session.state = row.state
      if (row.started_at !== null) session.startedAt = toIsoString(row.started_at)
      if (row.duration_ms !== null) session.durationMs = Number(row.duration_ms)
      if (row.query) session.query = row.query
      if (row.wait_event !== null) session.waitEvent = row.wait_event
      return session
    })
  }

  async terminateSession(sessionId: string): Promise<void> {
    const pid = Number(sessionId)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new DataForgeError('invalid_request', 'Session id must be a positive integer.')
    }
    const rows = await this.runScalarQuery<{ terminated: boolean | null }>(
      'select pg_terminate_backend($1) as terminated',
      [pid],
    )
    if (!rows[0]?.terminated) {
      throw new DataForgeError('not_found', 'That PostgreSQL session is no longer running.')
    }
  }

  async currentUser(): Promise<string | undefined> {
    const rows = await this.runScalarQuery<{ name: string }>('select current_user as name')
    return rows[0]?.name
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
