import type { CellValue, ExplainInput, ExplainResultDto, QueryInput, QueryResultDto } from '@shared/protocol'

import type { DriverQueryResult } from '../domain/driver'
import { DataForgeError, wrapError } from '../domain/errors'
import type { ConnectionService } from './connection-service'
import type { HistoryRecorder } from './history-service'
import type { Logger } from './ports'

const MAX_ROWS_LIMIT = 10_000

/** Leading keywords that never modify data; everything else is treated as a write. */
const READ_ONLY_KEYWORDS = new Set(['select', 'with', 'show', 'explain', 'table', 'values', 'describe'])

/**
 * Conservative read-only check for connections marked read-only.
 *
 * It strips comments and string literals before looking at the first keyword and
 * refuses multi-statement buffers, because `select 1; delete from t` must not
 * pass as a read. Real protection is the database role's privileges; this guard
 * only stops accidental writes.
 */
export function isReadOnlyStatement(sql: string): boolean {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')

  const statements = withoutComments
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (statements.length !== 1) return false

  const firstWord = /^[a-z]+/i.exec(statements[0] ?? '')?.[0]?.toLowerCase()
  if (!firstWord || !READ_ONLY_KEYWORDS.has(firstWord)) return false

  // A writable CTE can hide behind a leading WITH.
  if (firstWord === 'with' && /\b(insert|update|delete|merge)\b/i.test(statements[0] ?? '')) return false
  return true
}

export interface QueryExecutionInfo {
  readonly connectionId: string
  readonly connectionName: string
  readonly sql: string
  readonly durationMs: number
  readonly success: boolean
  readonly rowCount: number | null
}

export interface QueryServiceOptions {
  readonly logger: Logger
  readonly defaultMaxRows: number
  readonly history?: HistoryRecorder
  /** Called after every statement so the host can update the status bar. */
  readonly onExecuted?: (info: QueryExecutionInfo) => void
}

export class QueryService {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly connections: ConnectionService,
    private readonly options: QueryServiceOptions,
  ) {}

  async execute(requestId: string, input: QueryInput): Promise<QueryResultDto> {
    if (this.running.has(requestId)) {
      throw new DataForgeError('invalid_request', 'A query with this request id is already running.')
    }

    const summary = this.connections.get(input.connectionId)
    // Register before any await: a console may be closed while the pool is
    // still being acquired, and close() can only cancel a known request id.
    const controller = new AbortController()
    this.running.set(requestId, controller)
    const startedAt = Date.now()
    try {
      const driver = await this.connections.requireScopedDriver(input.connectionId, input.database)
      const maxRows = clampMaxRows(input.maxRows, this.options.defaultMaxRows)

      // Browsing another database of the same connection is read-only until the
      // user switches the connection to it: write state lives with the pool.
      const secondary = input.database !== undefined && input.database !== summary.database
      if ((summary.readOnly || secondary) && !isReadOnlyStatement(input.sql)) {
        throw new DataForgeError(
          'invalid_request',
          secondary
            ? `Database "${input.database}" is opened read-only. Switch the connection to it to run writes.`
            : `Connection "${summary.name}" is read-only. Only SELECT-style statements can run.`,
        )
      }

      const result = await driver.query({ sql: input.sql, maxRows, signal: controller.signal })
      this.report({
        connectionId: input.connectionId,
        connectionName: summary.name,
        sql: input.sql,
        durationMs: result.durationMs,
        success: true,
        rowCount: result.rows.length,
      })
      return toQueryResultDto(result)
    } catch (error) {
      this.report({
        connectionId: input.connectionId,
        connectionName: summary.name,
        sql: input.sql,
        durationMs: Date.now() - startedAt,
        success: false,
        rowCount: null,
      })
      throw wrapError('query_failed', 'Query failed', error)
    } finally {
      this.running.delete(requestId)
    }
  }

  private report(info: QueryExecutionInfo): void {
    void this.options.history?.record({ ...info, executedAt: Date.now() })
    try {
      this.options.onExecuted?.(info)
    } catch (error) {
      this.options.logger.warn(`Query timing hook failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Runs `EXPLAIN (FORMAT JSON)` on a single read-only statement.
   *
   * The plan is returned as text: rendering PostgreSQL's JSON plan tree is a UI
   * concern the webview does not need (and the JSON is the stable contract).
   */
  async explain(requestId: string, input: ExplainInput): Promise<ExplainResultDto> {
    if (this.running.has(requestId)) {
      throw new DataForgeError('invalid_request', 'A query with this request id is already running.')
    }
    if (!isReadOnlyStatement(input.sql)) {
      throw new DataForgeError('invalid_request', 'EXPLAIN here accepts one read-only statement. Run EXPLAIN ANALYZE in the SQL editor for writes.')
    }

    const driver = await this.connections.requireScopedDriver(input.connectionId, input.database)
    const controller = new AbortController()
    this.running.set(requestId, controller)
    const startedAt = Date.now()
    try {
      const result = await driver.query({
        sql: `explain (format json) ${input.sql}`,
        maxRows: 1,
        signal: controller.signal,
      })
      return { plan: prettyPlan(result.rows[0]?.[0]), durationMs: Date.now() - startedAt }
    } catch (error) {
      throw wrapError('query_failed', 'EXPLAIN failed', error)
    } finally {
      this.running.delete(requestId)
    }
  }

  /** Aborts a running request; the driver stops it server-side. */
  cancel(targetRequestId: string): void {
    const controller = this.running.get(targetRequestId)
    if (!controller) throw new DataForgeError('not_found', 'That query is not running any more.')
    this.options.logger.info(`Cancelling query ${targetRequestId}`)
    controller.abort()
  }

  get runningCount(): number {
    return this.running.size
  }

  dispose(): void {
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }
}

export function clampMaxRows(requested: unknown, fallback: number): number {
  const value = typeof requested === 'number' && Number.isFinite(requested) ? Math.trunc(requested) : fallback
  if (value < 1) return 1
  return Math.min(value, MAX_ROWS_LIMIT)
}

/** EXPLAIN output arrives as parsed JSON; render it as readable text. */
function prettyPlan(value: CellValue | undefined): string {
  if (value === undefined || value === null) return '[]'
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return JSON.stringify(value, null, 2)
}

/** Maps a driver result to the wire DTO shared with the webview. */
export function toQueryResultDto(result: DriverQueryResult): QueryResultDto {
  return {
    columns: [...result.columns],
    rows: result.rows.map((row) => [...row]),
    rowCount: result.rows.length,
    command: result.command,
    durationMs: result.durationMs,
    truncated: result.truncated,
    affectedRows: result.affectedRows,
    notices: [],
  }
}
