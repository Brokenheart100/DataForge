import { performance } from 'node:perf_hooks'

import { createPool } from 'mysql2/promise'
import type { FieldPacket, Pool, PoolConnection } from 'mysql2/promise'

import type { ColumnDto, SslMode } from '@shared/protocol'
import type { ConnectionConfig } from '../../domain/connection'
import type {
  ColumnInfo,
  DatabaseDriver,
  DriverCapabilities,
  DriverQueryInput,
  DriverQueryResult,
  ObjectCatalogDriver,
  ObjectStats,
  RelationInfo,
  ServerInfo,
  ServerSessionInfo,
  SessionDriver,
} from '../../domain/driver'
import { DataForgeError } from '../../domain/errors'
import { toCellValue } from '../cells'

export interface MySqlSettings {
  readonly connectTimeoutMs: number
  readonly statementTimeoutMs: number
}

/** Common MySQL column types, used to label result columns. */
const TYPE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'decimal'], [1, 'tinyint'], [2, 'smallint'], [3, 'int'], [4, 'float'], [5, 'double'],
  [7, 'timestamp'], [8, 'bigint'], [9, 'mediumint'], [10, 'date'], [11, 'time'], [12, 'datetime'],
  [13, 'year'], [15, 'varchar'], [16, 'bit'], [245, 'json'], [246, 'decimal'], [247, 'enum'],
  [248, 'set'], [249, 'tinyblob'], [250, 'mediumblob'], [251, 'longblob'], [252, 'blob'],
  [253, 'varchar'], [254, 'char'], [255, 'geometry'],
])

const SERVER_INFO_SQL = 'select version() as version, database() as db, current_user() as user'

const PROCESSLIST_SQL = `
  select id, user, host, db, command, time, state, info
  from information_schema.processlist
  where id <> connection_id()
  order by time desc, id asc`

const OBJECT_SEARCH_SQL = `
  select table_schema, table_name, table_type
  from information_schema.tables
  where table_schema = database() and table_name like ?
  order by table_name
  limit ?`

const OBJECT_STATS_SQL = `
  select data_length, index_length, table_rows
  from information_schema.tables
  where table_schema = database() and table_name = ?`

const OBJECT_INDEX_SQL = `
  select index_name, min(non_unique) as non_unique
  from information_schema.statistics
  where table_schema = database() and table_name = ?
  group by index_name
  order by index_name`

const SCHEMA_SQL = `
  select schema_name as name
  from information_schema.schemata
  where schema_name not in ('mysql', 'information_schema', 'performance_schema', 'sys')
  order by schema_name`

const RELATION_SQL = `
  select table_name as name, table_type as kind
  from information_schema.tables
  where table_schema = ?
  order by table_name`

const COLUMN_SQL = `
  select
    c.column_name as name,
    c.column_type as data_type,
    c.is_nullable = 'YES' as nullable,
    c.column_default as default_value,
    c.ordinal_position as ordinal,
    c.extra like '%GENERATED%' as is_generated,
    exists (
      select 1
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_schema = tc.constraint_schema
       and kcu.constraint_name = tc.constraint_name
       and kcu.table_schema = tc.table_schema
       and kcu.table_name = tc.table_name
      where tc.constraint_type = 'PRIMARY KEY'
        and tc.table_schema = c.table_schema
        and tc.table_name = c.table_name
        and kcu.column_name = c.column_name
    ) as is_pk
  from information_schema.columns c
  where c.table_schema = ? and c.table_name = ?
  order by c.ordinal_position`

/** MySQL error codes worth reporting as a connection problem rather than a SQL problem. */
const CONNECTION_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_HOST_NOT_PRIVILEGED', 'ER_CON_COUNT_ERROR',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'PROTOCOL_CONNECTION_LOST',
  'HANDSHAKE_SSL_ERROR',
])

/** Killed statements surface as interrupted queries, not as protocol errors. */
const CANCELLED_CODES = new Set(['ER_QUERY_INTERRUPTED', 'ER_SERVER_SHUTDOWN', 'ER_QUERY_TIMEOUT'])

interface MySqlError extends Error {
  readonly code?: string
  readonly errno?: number
  readonly sqlState?: string
  readonly sqlMessage?: string
  readonly cause?: unknown
}

export function mapMySqlError(error: unknown): DataForgeError {
  if (error instanceof DataForgeError) return error
  const cause = error as MySqlError
  const code = cause.code ?? `errno:${cause.errno ?? 'unknown'}`
  const message = cause.sqlMessage ?? cause.message ?? 'Unknown MySQL error'

  if (CANCELLED_CODES.has(code) || cause.errno === 1317) return new DataForgeError('cancelled', 'Query was cancelled.', { cause: error })
  const errorCode = CONNECTION_CODES.has(code) ? 'connection_failed' : 'query_failed'
  return new DataForgeError(errorCode, `[${code}] ${message}`, { cause: error })
}

function sslOptions(mode: SslMode): { rejectUnauthorized: boolean } | undefined {
  if (mode === 'disable') return undefined
  return { rejectUnauthorized: mode === 'verify-full' }
}

function toColumns(fields: readonly FieldPacket[]): ColumnDto[] {
  return fields.map((field) => ({
    name: field.name,
    dataType: TYPE_NAMES.get(field.type ?? -1) ?? `type:${field.type ?? 'unknown'}`,
  }))
}

function relationKind(tableType: string): RelationInfo['kind'] {
  if (tableType === 'BASE TABLE') return 'table'
  if (tableType === 'SYSTEM VIEW') return 'view'
  return 'view'
}

function quoteMySqlIdentifier(name: string): string {
  if (name.length === 0 || name.includes(String.fromCharCode(0))) {
    throw new DataForgeError('invalid_request', 'A relation name cannot be empty.')
  }
  const escaped = name.split('`').join('``')
  return '`' + escaped + '`'
}

function toBytes(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function commandOf(sql: string): string {
  const keyword = /^\s*([a-zA-Z]+)/.exec(sql)?.[1]
  return keyword ? keyword.toUpperCase() : 'OK'
}

export class MySqlDriver implements DatabaseDriver, ObjectCatalogDriver, SessionDriver {
  readonly kind = 'mysql'
  readonly capabilities: DriverCapabilities = { transactions: true, returning: false, identifierQuote: '`' }

  private readonly pool: Pool
  private readonly initialized = new WeakSet<PoolConnection>()

  constructor(config: ConnectionConfig, private readonly settings: MySqlSettings) {
    const { profile, credentials } = config
    this.pool = createPool({
      host: profile.host,
      port: profile.port > 0 ? profile.port : 3306,
      user: profile.user,
      password: credentials.password,
      database: profile.database,
      ssl: sslOptions(profile.ssl),
      connectTimeout: settings.connectTimeoutMs,
      waitForConnections: true,
      connectionLimit: 4,
      maxIdle: 4,
      idleTimeout: 30_000,
      enableKeepAlive: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    })

  }

  async testConnection(): Promise<ServerInfo> {
    const result = await this.query({ sql: SERVER_INFO_SQL, maxRows: 1 })
    const [version = '', database = '', user = ''] = result.rows[0] ?? []
    return { serverVersion: `MySQL ${String(version)}`, database: String(database ?? ''), user: String(user ?? '') }
  }

  async query(input: DriverQueryInput): Promise<DriverQueryResult> {
    const started = performance.now()
    const connection = await this.acquire()
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      void this.killQuery(connection.threadId)
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      if (input.signal?.aborted) throw new DataForgeError('cancelled', 'Query was cancelled.')
      const [raw, fields] = (await connection.query({ sql: input.sql, rowsAsArray: true })) as unknown as [unknown, FieldPacket[] | undefined]
      // KILL QUERY can make a statement return partial rows instead of an error (SLEEP reports 1), so abort wins.
      if (input.signal?.aborted) throw new DataForgeError('cancelled', 'Query was cancelled.')
      return this.toResult(raw, fields ?? [], input, performance.now() - started)
    } catch (error) {
      throw mapMySqlError(error)
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      if (aborted) connection.destroy()
      else connection.release()
    }
  }

  async listDatabases(): Promise<string[]> {
    // MySQL exposes databases as schemas of the same server.
    return this.listSchemas()
  }

  async searchObjects(query: string, limit: number): Promise<RelationInfo[]> {
    const rows = await this.queryValues(OBJECT_SEARCH_SQL, [`%${query}%`, Math.max(1, Math.trunc(limit))], limit)
    return rows.map((row) => ({
      schema: String(row[0] ?? ''),
      name: String(row[1] ?? ''),
      kind: relationKind(String(row[2] ?? '')),
    }))
  }

  /** MySQL exposes the original statement directly, so no reconstruction. */
  async objectDdl(relation: RelationInfo): Promise<string> {
    const qualified = `${quoteMySqlIdentifier(relation.schema)}.${quoteMySqlIdentifier(relation.name)}`
    const keyword = relation.kind === 'view' ? 'view' : 'table'
    const result = await this.query({ sql: `show create ${keyword} ${qualified}`, maxRows: 1 })
    const ddl = result.rows[0]?.[1]
    if (typeof ddl !== 'string') {
      throw new DataForgeError('not_found', `Relation "${relation.schema}.${relation.name}" no longer exists.`)
    }
    return ddl.endsWith(';') ? ddl : `${ddl};`
  }

  async objectStats(relation: RelationInfo): Promise<ObjectStats> {
    const stats = await this.queryValues(OBJECT_STATS_SQL, [relation.name], 1)
    const row = stats[0]
    const indexes = await this.queryValues(OBJECT_INDEX_SQL, [relation.name], 500)
    const mapped = indexes.map((index) => ({
      name: String(index[0] ?? ''),
      bytes: null,
      unique: Number(index[1] ?? 1) === 0,
      definition: null,
    }))
    return {
      totalBytes: toBytes(row?.[0]) === null && toBytes(row?.[1]) === null
        ? null
        : (toBytes(row?.[0]) ?? 0) + (toBytes(row?.[1]) ?? 0),
      rowEstimate: toBytes(row?.[2]),
      indexBytes: toBytes(row?.[1]),
      indexes: mapped,
    }
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.query({ sql: SCHEMA_SQL, maxRows: 1_000 })
    return result.rows.map((row) => String(row[0] ?? '')).filter((name) => name.length > 0)
  }

  async listRelations(schema: string): Promise<RelationInfo[]> {
    const result = await this.queryValues(RELATION_SQL, [schema], 5_000)
    return result.map((row) => ({
      schema,
      name: String(row[0] ?? ''),
      kind: relationKind(String(row[1] ?? '')),
    }))
  }

  async listColumns(schema: string, relation: string): Promise<ColumnInfo[]> {
    const result = await this.queryValues(COLUMN_SQL, [schema, relation], 5_000)
    return result.map((row) => ({
      name: String(row[0] ?? ''),
      dataType: String(row[1] ?? ''),
      nullable: Number(row[2] ?? 0) === 1,
      defaultValue: row[3] === null || row[3] === undefined ? null : String(row[3]),
      ordinal: Number(row[4] ?? 0),
      generated: Number(row[5] ?? 0) === 1,
      isPrimaryKey: Number(row[6] ?? 0) === 1,
    }))
  }

  async listSessions(): Promise<readonly ServerSessionInfo[]> {
    const rows = await this.queryValues(PROCESSLIST_SQL, [], 500)
    const sessions: ServerSessionInfo[] = []
    for (const row of rows) {
      const id = row[0] === null || row[0] === undefined ? '' : String(row[0])
      if (id === '') continue
      const session: { -readonly [K in keyof ServerSessionInfo]: ServerSessionInfo[K] } = { id }
      if (row[1] !== null && row[1] !== undefined) session.user = String(row[1])
      if (row[2] !== null && row[2] !== undefined) session.client = String(row[2])
      if (row[3] !== null && row[3] !== undefined) session.database = String(row[3])
      const state = row[6] !== null && row[6] !== undefined && row[6] !== '' ? row[6] : row[4]
      if (state !== null && state !== undefined) session.state = String(state)
      if (row[5] !== null && row[5] !== undefined) session.durationMs = Number(row[5]) * 1000
      if (row[7] !== null && row[7] !== undefined) session.query = String(row[7])
      sessions.push(session)
    }
    return sessions
  }

  async terminateSession(sessionId: string): Promise<void> {
    const id = Number(sessionId)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new DataForgeError('invalid_request', 'Session id must be a positive integer.')
    }
    try {
      // KILL is a text-protocol statement; MySQL rejects it inside a prepared statement.
      await this.pool.query(`kill connection ${id}`)
    } catch (error) {
      const code = (error as MySqlError).code
      if (code === 'ER_NO_SUCH_THREAD') {
        throw new DataForgeError('not_found', 'That MySQL session is no longer running.')
      }
      throw mapMySqlError(error)
    }
  }

  async currentUser(): Promise<string | undefined> {
    const rows = await this.queryValues("select substring_index(current_user(), '@', 1) as name", [], 1)
    const name = rows[0]?.[0]
    return name === null || name === undefined ? undefined : String(name)
  }

  async dispose(): Promise<void> {
    await this.pool.end()
  }

  private async queryValues(sql: string, values: readonly unknown[], maxRows: number): Promise<unknown[][]> {
    const connection = await this.acquire()
    try {
      const [rows] = (await connection.execute({ sql, values: [...values], rowsAsArray: true })) as unknown as [unknown[][], FieldPacket[]]
      return rows.slice(0, maxRows)
    } catch (error) {
      throw mapMySqlError(error)
    } finally {
      connection.release()
    }
  }

  private async acquire(): Promise<PoolConnection> {
    let connection: PoolConnection
    try {
      connection = await this.pool.getConnection()
    } catch (error) {
      throw mapMySqlError(error)
    }

    if (this.settings.statementTimeoutMs > 0 && !this.initialized.has(connection)) {
      try {
        // max_execution_time bounds SELECT statements only; writes stay bounded by the pool timeout.
        await connection.query(`set session max_execution_time = ${Math.trunc(this.settings.statementTimeoutMs)}`)
        this.initialized.add(connection)
      } catch (error) {
        connection.destroy()
        throw mapMySqlError(error)
      }
    }
    return connection
  }

  /** Runs `KILL QUERY` on a separate connection; the server refuses to kill the caller's own query. */
  private async killQuery(threadId: number): Promise<void> {
    try {
      const killer = await this.pool.getConnection()
      try {
        await killer.query(`kill query ${Math.trunc(threadId)}`)
      } finally {
        killer.release()
      }
    } catch {
      // The statement may have finished in the meantime; the query itself reports the outcome.
    }
  }

  private toResult(raw: unknown, fields: readonly FieldPacket[], input: DriverQueryInput, durationMs: number): DriverQueryResult {
    const maxRows = input.maxRows
    if (Array.isArray(raw)) {
      const allRows = raw as unknown[][]
      const truncated = allRows.length > maxRows
      const rows = (truncated ? allRows.slice(0, maxRows) : allRows).map((row) => row.map((value) => toCellValue(value)))
      return {
        columns: toColumns(fields),
        rows,
        command: commandOf(input.sql),
        durationMs: Math.round(durationMs),
        truncated,
        affectedRows: null,
      }
    }

    const header = raw as { affectedRows?: number; info?: string }
    return {
      columns: [],
      rows: [],
      command: commandOf(input.sql),
      durationMs: Math.round(durationMs),
      truncated: false,
      affectedRows: header.affectedRows ?? 0,
    }
  }
}
