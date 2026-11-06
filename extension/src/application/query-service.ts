import type { QueryInput, QueryResultDto } from '@shared/protocol'

import type { DriverQueryResult } from '../domain/driver'
import { DataForgeError, wrapError } from '../domain/errors'
import type { ConnectionService } from './connection-service'
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

export interface QueryServiceOptions {
  readonly logger: Logger
  readonly defaultMaxRows: number
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

    const driver = this.connections.requireDriver(input.connectionId)
    const maxRows = clampMaxRows(input.maxRows, this.options.defaultMaxRows)

    const summary = this.connections.get(input.connectionId)
    if (summary.readOnly && !isReadOnlyStatement(input.sql)) {
      throw new DataForgeError(
        'invalid_request',
        `Connection "${summary.name}" is read-only. Only SELECT-style statements can run.`,
      )
    }

    const controller = new AbortController()
    this.running.set(requestId, controller)
    try {
      const result = await driver.query({ sql: input.sql, maxRows, signal: controller.signal })
      return toDto(result)
    } catch (error) {
      throw wrapError('query_failed', 'Query failed', error)
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

function toDto(result: DriverQueryResult): QueryResultDto {
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
