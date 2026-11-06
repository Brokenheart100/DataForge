import type { ColumnInfo, RelationInfo } from '../domain/driver'
import { scopeKey, scopeOf } from '../domain/scope'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'

/**
 * Lazy, per-scope metadata cache.
 *
 * The tree view expands nodes on demand and this service promises de-duplicate
 * concurrent loads of the same node. Keys carry `(connection, database)` so two
 * databases of one connection never share entries. Cached promises are evicted
 * on failure so a retry can succeed, and a connection's entries are dropped when
 * it disconnects or the user hits refresh.
 */
export class SchemaService {
  private readonly schemas = new Map<string, Promise<string[]>>()
  private readonly relations = new Map<string, Promise<RelationInfo[]>>()
  private readonly columns = new Map<string, Promise<ColumnInfo[]>>()

  constructor(
    private readonly connections: ConnectionService,
    private readonly logger: Logger,
  ) {}

  listSchemas(connectionId: string, database?: string): Promise<string[]> {
    const scope = this.scopeKeyOf(connectionId, database)
    return this.cached(this.schemas, scope, async () =>
      (await this.connections.requireScopedDriver(connectionId, database)).listSchemas(),
    )
  }

  listRelations(connectionId: string, schema: string, database?: string): Promise<RelationInfo[]> {
    const scope = this.scopeKeyOf(connectionId, database)
    return this.cached(this.relations, `${scope}\u0000${schema}`, async () =>
      (await this.connections.requireScopedDriver(connectionId, database)).listRelations(schema),
    )
  }

  listColumns(connectionId: string, schema: string, relation: string, database?: string): Promise<ColumnInfo[]> {
    const scope = this.scopeKeyOf(connectionId, database)
    return this.cached(this.columns, `${scope}\u0000${schema}\u0000${relation}`, async () =>
      (await this.connections.requireScopedDriver(connectionId, database)).listColumns(schema, relation),
    )
  }

  /** Drops cached metadata for one connection (all its databases), or for all. */
  invalidate(connectionId?: string): void {
    for (const [key, bucket] of [
      ['schemas', this.schemas],
      ['relations', this.relations],
      ['columns', this.columns],
    ] as const) {
      for (const entry of bucket.keys()) {
        if (connectionId === undefined || entry.startsWith(`${connectionId}\u0000`)) {
          bucket.delete(entry)
        }
      }
      this.logger.info(`Schema cache cleared (${key}, ${connectionId ?? 'all'})`)
    }
  }

  /**
   * Cache-only lookups for callers that must not trigger I/O, such as SQL
   * completion. `undefined` means "not loaded yet, nothing to offer".
   */
  cachedSchemas(connectionId: string, database?: string): Promise<string[]> | undefined {
    return this.schemas.get(this.scopeKeyOf(connectionId, database))
  }

  cachedRelations(connectionId: string, schema: string, database?: string): Promise<RelationInfo[]> | undefined {
    return this.relations.get(`${this.scopeKeyOf(connectionId, database)}\u0000${schema}`)
  }

  cachedColumns(
    connectionId: string,
    schema: string,
    relation: string,
    database?: string,
  ): Promise<ColumnInfo[]> | undefined {
    return this.columns.get(`${this.scopeKeyOf(connectionId, database)}\u0000${schema}\u0000${relation}`)
  }

  /**
   * Normalises "no database given" to the connection's own database, so callers
   * that omit it (completion, the editor) share cache entries with the tree.
   */
  private scopeKeyOf(connectionId: string, database?: string): string {
    const target = database ?? this.connections.get(connectionId).database
    return scopeKey(scopeOf(connectionId, target))
  }

  private cached<T>(bucket: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const existing = bucket.get(key)
    if (existing) return existing

    const pending = load().catch((error: unknown) => {
      bucket.delete(key)
      throw error
    })
    bucket.set(key, pending)
    return pending
  }
}
