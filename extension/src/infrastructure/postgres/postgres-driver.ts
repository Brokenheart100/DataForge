import { performance } from 'node:perf_hooks'

import { Client, Pool } from 'pg'
import type { PoolClient, QueryResult } from 'pg'

import type { CellValue, ColumnDto, SslMode } from '@shared/protocol'
import type { ConnectionConfig } from '../../domain/connection'
import type {
  ColumnInfo,
  DatabaseDriver,
  DriverQueryInput,
  DriverQueryResult,
  RelationInfo,
  RelationKind,
  ServerInfo,
} from '../../domain/driver'
import { DataForgeError, redactSecrets } from '../../domain/errors'

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

function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) {
    const head = value.subarray(0, 32).toString('hex')
    return `\\x${head}${value.length > 32 ? '…' : ''}`
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function toColumns(fields: readonly { name: string; dataTypeID: number }[]): ColumnDto[] {
  return fields.map((field) => ({
    name: field.name,
    dataType: TYPE_NAMES.get(field.dataTypeID) ?? `oid:${field.dataTypeID}`,
  }))
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

export class PostgresDriver implements DatabaseDriver {
  readonly kind = 'postgresql'

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
