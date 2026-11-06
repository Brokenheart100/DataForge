import type { CellValue } from '@shared/protocol'

/**
 * The (connection, database) pair every metadata and query operation is scoped
 * to. PostgreSQL cannot query across databases, so "browse another database"
 * means "use another pool", never a qualified table name.
 */
export interface DataSourceScope {
  readonly connectionId: string
  readonly database: string
}

/** `\u0000` cannot appear in an identifier, so it is a safe cache-key separator. */
const SEPARATOR = '\u0000'

export function scopeOf(connectionId: string, database: string): DataSourceScope {
  return { connectionId, database }
}

/** Stable cache key for a scope; used by schema caches and pool maps. */
export function scopeKey(scope: DataSourceScope): string {
  return `${scope.connectionId}${SEPARATOR}${scope.database}`
}

export function parsedScope(key: string): DataSourceScope {
  const index = key.indexOf(SEPARATOR)
  if (index < 0) return { connectionId: key, database: '' }
  return { connectionId: key.slice(0, index), database: key.slice(index + 1) }
}

/** True when two scopes point at the same connection *and* database. */
export function sameScope(a: DataSourceScope, b: DataSourceScope): boolean {
  return a.connectionId === b.connectionId && a.database === b.database
}

/** Human label for logs and tooltips: `forge@conn-1` reads better than two ids. */
export function scopeLabel(scope: DataSourceScope): string {
  return `${scope.database}@${scope.connectionId}`
}

/**
 * Rows are addressed by their primary key inside one scope. The type alias keeps
 * the "same database" assumption explicit wherever identities travel.
 */
export type ScopedIdentity = Readonly<Record<string, CellValue>>
