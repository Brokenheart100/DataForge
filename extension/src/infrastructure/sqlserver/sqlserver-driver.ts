import { performance } from 'node:perf_hooks'

import { Connection, Request, TYPES } from 'tedious'
import type { ConnectionConfiguration } from 'tedious'
import type { ColumnMetadata } from 'tedious/lib/token/colmetadata-token-parser'

import type { CellValue, ColumnDto } from '@shared/protocol'
import type { ConnectionConfig } from '../../domain/connection'
import type {
  ColumnInfo,
  DatabaseDriver,
  DriverQueryInput,
  DriverQueryResult,
  RelationInfo,
  ServerInfo,
} from '../../domain/driver'
import { DataForgeError, wrapError } from '../../domain/errors'
import { toCellValue } from '../cells'

export interface SqlServerSettings {
  readonly connectTimeoutMs: number
  readonly statementTimeoutMs: number
}

/** Columns requested from INFORMATION_SCHEMA; kept generous for wide tables. */
const METADATA_MAX_ROWS = 20_000

/** First keyword must be a read; the driver exposes no write capabilities. */
const READ_ONLY_STATEMENT = /^(select|with)\b/i
const WRITE_CLAUSE = /\binto\b/i

/** SQL Server is exposed read-only: only SELECT/CTE queries without INTO pass. */
export function isReadOnlySql(sql: string): boolean {
  const stripped = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()
  return READ_ONLY_STATEMENT.test(stripped) && !WRITE_CLAUSE.test(stripped)
}

/**
 * Read-only SQL Server adapter (tedious, pure JavaScript).
 *
 * There is deliberately no pooling: this driver reports capabilities rather
 * than editing support, so one short-lived connection per request is enough
 * and keeps cancellation (request.cancel) unambiguous.
 */
export class SqlServerDriver implements DatabaseDriver {
  readonly kind = 'sqlserver' as const

  constructor(
    private readonly config: ConnectionConfig,
    private readonly settings: SqlServerSettings,
  ) {}

  async testConnection(): Promise<ServerInfo> {
    const result = await this.run(
      "select @@version as version, db_name() as [database], suser_sname() as [user]",
      1,
      undefined,
      this.settings.connectTimeoutMs,
    )
    const [version, database, user] = result.rows[0] ?? []
    return {
      serverVersion: String(version ?? 'SQL Server'),
      database: String(database ?? this.config.profile.database),
      user: String(user ?? this.config.profile.user),
    }
  }

  async query(input: DriverQueryInput): Promise<DriverQueryResult> {
    this.assertReadOnly(input.sql)
    return this.run(input.sql, input.maxRows, input.signal, this.settings.statementTimeoutMs)
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.metadata(
      'select name from sys.databases where database_id > 4 and state_desc = \'ONLINE\' order by name',
    )
    return result.rows.map((row) => String(row[0]))
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.metadata(
      "select schema_name from information_schema.schemata where schema_name not in ('sys', 'INFORMATION_SCHEMA') order by schema_name",
    )
    return result.rows.map((row) => String(row[0]))
  }

  async listRelations(schema: string): Promise<RelationInfo[]> {
    const result = await this.metadata(
      `select table_name, table_type from information_schema.tables
       where table_schema = @schema and table_type in ('BASE TABLE', 'VIEW')
       order by table_name`,
      [['schema', TYPES.NVarChar, schema]],
    )
    return result.rows.map((row) => ({
      schema,
      name: String(row[0]),
      kind: String(row[1]) === 'VIEW' ? 'view' : 'table',
    }))
  }

  async listColumns(schema: string, relation: string): Promise<ColumnInfo[]> {
    const result = await this.metadata(
      `select c.column_name, c.data_type, c.character_maximum_length, c.numeric_precision,
              c.numeric_scale, c.is_nullable, c.column_default, c.ordinal_position,
              case when pk.column_name is null then 0 else 1 end as is_pk
       from information_schema.columns c
       left join (
         select kcu.table_schema, kcu.table_name, kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_schema = tc.constraint_schema
          and kcu.constraint_name = tc.constraint_name
         where tc.constraint_type = 'PRIMARY KEY'
       ) pk on pk.table_schema = c.table_schema and pk.table_name = c.table_name and pk.column_name = c.column_name
       where c.table_schema = @schema and c.table_name = @table
       order by c.ordinal_position`,
      [
        ['schema', TYPES.NVarChar, schema],
        ['table', TYPES.NVarChar, relation],
      ],
    )
    return result.rows.map((row) => ({
      name: String(row[0]),
      dataType: displayType(String(row[1]), row[2], row[3], row[4]),
      nullable: String(row[5]).toUpperCase() === 'YES',
      defaultValue: row[6] === null ? null : String(row[6]),
      isPrimaryKey: Number(row[8] ?? 0) === 1,
      ordinal: Number(row[7] ?? 0),
    }))
  }

  async dispose(): Promise<void> {
    // Each request owns its connection; there is nothing to release.
  }

  private assertReadOnly(sql: string): void {
    if (!isReadOnlySql(sql)) {
      throw new DataForgeError(
        'invalid_request',
        'The SQL Server connection is read-only. Run a SELECT statement.',
      )
    }
  }

  private async metadata(
    sql: string,
    parameters: readonly (readonly [string, unknown, unknown])[] = [],
  ): Promise<DriverQueryResult> {
    return this.run(sql, METADATA_MAX_ROWS, undefined, this.settings.statementTimeoutMs, parameters)
  }

  private connectionConfig(requestTimeoutMs: number): ConnectionConfiguration {
    const { profile, credentials } = this.config
    return {
      server: profile.host,
      authentication: {
        type: 'default',
        options: { userName: profile.user, password: credentials.password },
      },
      options: {
        port: profile.port,
        database: profile.database,
        encrypt: profile.ssl !== 'disable',
        trustServerCertificate: profile.ssl !== 'verify-full',
        connectTimeout: this.settings.connectTimeoutMs,
        requestTimeout: requestTimeoutMs,
        rowCollectionOnRequestCompletion: false,
        appName: 'DataForge',
      },
    }
  }

  private async run(
    sql: string,
    maxRows: number,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    parameters: readonly (readonly [string, unknown, unknown])[] = [],
  ): Promise<DriverQueryResult> {
    const connection = new Connection(this.connectionConfig(timeoutMs))
    // Tedious emits 'error' for background socket failures; every wait below
    // rejects through its own callback, so this listener only prevents a crash.
    connection.on('error', () => undefined)
    try {
      await this.open(connection)
      if (signal?.aborted) throw new DataForgeError('cancelled', 'Query was cancelled.')
      return await this.execute(connection, sql, maxRows, signal, parameters)
    } catch (error) {
      if (signal?.aborted) throw new DataForgeError('cancelled', 'Query was cancelled.', { cause: error })
      if (error instanceof DataForgeError) throw error
      throw wrapError('query_failed', 'SQL Server query failed', error)
    } finally {
      try {
        connection.close()
      } catch {
        // The socket may never have opened; that is exactly what close fixes.
      }
    }
  }

  private open(connection: Connection): Promise<void> {
    return new Promise((resolve, reject) => {
      connection.connect((error) => (error ? reject(error) : resolve()))
    })
  }

  private execute(
    connection: Connection,
    sql: string,
    maxRows: number,
    signal: AbortSignal | undefined,
    parameters: readonly (readonly [string, unknown, unknown])[],
  ): Promise<DriverQueryResult> {
    const started = performance.now()
    return new Promise((resolve, reject) => {
      const request = new Request(sql, (error, rowCount) => {
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          reject(error)
          return
        }
        const columns: ColumnDto[] = metadata.map((column) => ({
          name: column.colName,
          dataType: String(column.type?.name ?? 'unknown').toLowerCase(),
        }))
        resolve({
          columns,
          rows: collected,
          command: 'SQL Server',
          durationMs: Math.round(performance.now() - started),
          truncated: dropped > 0,
          affectedRows: columns.length === 0 && rowCount !== undefined ? rowCount : null,
        })
      })

      let metadata: ColumnMetadata[] = []
      const collected: CellValue[][] = []
      let dropped = 0
      request.on('columnMetadata', (columns) => {
        metadata = Array.isArray(columns) ? columns : Object.values(columns)
      })
      request.on('row', (cells: readonly { value: unknown }[]) => {
        if (collected.length >= maxRows) {
          dropped += 1
          return
        }
        collected.push(cells.map((cell) => toCellValue(cell.value)))
      })

      const onAbort = (): void => {
        try {
          request.cancel()
        } catch {
          // Already completed; the callback below settles the promise.
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      for (const [name, type, value] of parameters) {
        request.addParameter(name, type as never, value)
      }
      connection.execSql(request)
    })
  }
}

function displayType(
  dataType: string,
  length: unknown,
  precision: unknown,
  scale: unknown,
): string {
  if (length !== null && length !== undefined) return `${dataType}(${String(length)})`
  if (precision !== null && precision !== undefined) {
    return scale === null || scale === undefined
      ? `${dataType}(${String(precision)})`
      : `${dataType}(${String(precision)},${String(scale)})`
  }
  return dataType
}
