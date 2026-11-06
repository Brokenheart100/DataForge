import type { ColumnInfo, RelationInfo } from '../domain/driver'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'

/**
 * Lazy, per-connection metadata cache.
 *
 * The tree view is the only Phase 1 consumer: it expands nodes on demand and
 * this service promises de-duplicate concurrent loads of the same node. Cached
 * promises are evicted on failure so a retry can succeed, and the whole cache of
 * a connection is dropped when it disconnects or the user hits refresh.
 */
export class SchemaService {
  private readonly schemas = new Map<string, Promise<string[]>>()
  private readonly relations = new Map<string, Promise<RelationInfo[]>>()
  private readonly columns = new Map<string, Promise<ColumnInfo[]>>()

  constructor(
    private readonly connections: ConnectionService,
    private readonly logger: Logger,
  ) {}

  listSchemas(connectionId: string): Promise<string[]> {
    return this.cached(this.schemas, connectionId, async () =>
      this.connections.requireDriver(connectionId).listSchemas(),
    )
  }

  listRelations(connectionId: string, schema: string): Promise<RelationInfo[]> {
    return this.cached(this.relations, `${connectionId}\u0000${schema}`, async () =>
      this.connections.requireDriver(connectionId).listRelations(schema),
    )
  }

  listColumns(connectionId: string, schema: string, relation: string): Promise<ColumnInfo[]> {
    return this.cached(this.columns, `${connectionId}\u0000${schema}\u0000${relation}`, async () =>
      this.connections.requireDriver(connectionId).listColumns(schema, relation),
    )
  }

  /** Drops cached metadata for one connection, or for all connections. */
  invalidate(connectionId?: string): void {    for (const [key, bucket] of [
      ['schemas', this.schemas],
      ['relations', this.relations],
      ['columns', this.columns],
    ] as const) {
      for (const entry of bucket.keys()) {
        if (connectionId === undefined || entry === connectionId || entry.startsWith(`${connectionId}\u0000`)) {
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
  cachedSchemas(connectionId: string): Promise<string[]> | undefined {
    return this.schemas.get(connectionId)
  }

  cachedRelations(connectionId: string, schema: string): Promise<RelationInfo[]> | undefined {
    return this.relations.get(`${connectionId}\u0000${schema}`)
  }

  cachedColumns(connectionId: string, schema: string, relation: string): Promise<ColumnInfo[]> | undefined {
    return this.columns.get(`${connectionId}\u0000${schema}\u0000${relation}`)
  }

  private cached<T>(
    bucket: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
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
