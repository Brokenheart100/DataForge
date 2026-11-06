import type * as vscode from 'vscode'

import type { Logger } from '../application/ports'
import type { QueryExecutionInfo } from '../application/query-service'

export interface QueryDiagnosticsOptions {
  readonly statusBar: vscode.StatusBarItem
  readonly logger: Logger
  readonly slowQueryMs: () => number
}

/**
 * Renders the outcome of the last query in the status bar and logs failures and
 * slow statements. Kept free of query execution so it stays testable.
 */
export function createQueryDiagnostics(options: QueryDiagnosticsOptions): (info: QueryExecutionInfo) => void {
  const { statusBar, logger } = options
  return (info) => {
    const threshold = options.slowQueryMs()
    const slow = info.success && threshold > 0 && info.durationMs >= threshold
    statusBar.text = info.success ? `$(watch) ${info.durationMs} ms` : '$(warning) query failed'
    statusBar.tooltip = [
      info.connectionName,
      info.success ? `${info.rowCount ?? 0} row(s)` : 'failed',
      `${info.durationMs} ms`,
      ...(slow ? ['slow query'] : []),
    ].join(' · ')
    statusBar.show()
    if (!info.success) {
      logger.warn(`Query failed on ${info.connectionName} after ${info.durationMs} ms`)
    } else if (slow) {
      logger.warn(`Slow query on ${info.connectionName} took ${info.durationMs} ms: ${info.sql.slice(0, 200)}`)
    }
  }
}
