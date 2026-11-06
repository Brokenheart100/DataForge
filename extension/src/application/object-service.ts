import type { ObjectDdlDto, ObjectKind, ObjectStatsDto, ObjectTargetInput } from '@shared/protocol'

import type { ObjectCatalogDriver, RelationInfo, RelationKind } from '../domain/driver'
import { DataForgeError, wrapError } from '../domain/errors'
import { scopeKey, scopeOf } from '../domain/scope'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'

const CACHE_TTL_MS = 60_000
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

export interface ObjectServiceDeps {
  readonly connections: ConnectionService
  readonly logger: Logger
}

export interface ObjectSearchRequest {
  readonly connectionId: string
  readonly database?: string
  readonly query: string
  readonly limit?: number
}

interface CacheEntry<T> {
  readonly value: Promise<T>
  readonly expiresAt: number
}

export function isObjectCatalogDriver(driver: unknown): driver is ObjectCatalogDriver {
  if (typeof driver !== 'object' || driver === null) return false
  const candidate = driver as Partial<ObjectCatalogDriver>
  return typeof candidate.objectDdl === 'function' && typeof candidate.objectStats === 'function'
}

/**
 * Owns object browsing: search, DDL and stats, plus a short-lived cache so
 * clicking the same table twice does not re-query the catalog. Rejected
 * promises are evicted immediately, so a failed load is retried next time.
 */
export class ObjectService {
  private readonly cache = new Map<string, CacheEntry<unknown>>()

  constructor(private readonly deps: ObjectServiceDeps) {}

  async search(request: ObjectSearchRequest): Promise<{ objects: RelationInfo[]; truncated: boolean }> {
    const driver = await this.driver(request.connectionId, request.database)
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(request.limit ?? DEFAULT_LIMIT)))
    const query = request.query.trim()
    if (query.length === 0) return { objects: [], truncated: false }

    try {
      const objects = driver.searchObjects
        ? await driver.searchObjects(query, limit + 1)
        : await this.fallbackSearch(driver, query, limit + 1)
      return { objects: objects.slice(0, limit), truncated: objects.length > limit }
    } catch (error) {
      throw wrapError('query_failed', 'Searching objects', error)
    }
  }

  async ddl(target: ObjectTargetInput): Promise<ObjectDdlDto> {
    const relation = relationOf(target)
    const key = cacheKey(this.scopeOf(target), relation, 'ddl')
    const cached = this.peek<string>(key)
    if (cached !== undefined) return { ddl: await cached, cached: true }
    const driver = await this.driver(target.connectionId, target.database)
    return { ddl: await this.remember(key, this.loadDdl(driver, relation)), cached: false }
  }

  async stats(target: ObjectTargetInput): Promise<ObjectStatsDto> {
    const relation = relationOf(target)
    const key = cacheKey(this.scopeOf(target), relation, 'stats')
    const cached = this.peek<ObjectStatsDto>(key)
    if (cached !== undefined) return cached
    const driver = await this.driver(target.connectionId, target.database)
    return this.remember(key, this.loadStats(driver, relation))
  }

  /** Drops cached DDL/stats, for the whole connection or for one object. */
  invalidate(connectionId?: string): void {
    if (connectionId === undefined) {
      this.cache.clear()
      return
    }
    const prefix = `${connectionId}\u0000`
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }

  private async driver(connectionId: string, database?: string): Promise<ObjectCatalogDriver> {
    const driver = await this.deps.connections.requireScopedDriver(connectionId, database)
    if (!isObjectCatalogDriver(driver)) {
      throw new DataForgeError('internal', 'This connection does not support object browsing yet.')
    }
    return driver
  }

  private async fallbackSearch(
    driver: ObjectCatalogDriver,
    query: string,
    limit: number,
  ): Promise<RelationInfo[]> {
    const needle = query.toLowerCase()
    const schemas = await driver.listSchemas()
    const found: RelationInfo[] = []
    for (const schema of schemas.slice(0, 10)) {
      const relations = await driver.listRelations(schema)
      for (const relation of relations) {
        if (
          relation.name.toLowerCase().includes(needle) ||
          relation.schema.toLowerCase().includes(needle)
        ) {
          found.push(relation)
          if (found.length >= limit) return found
        }
      }
    }
    return found
  }

  private async loadDdl(driver: ObjectCatalogDriver, relation: RelationInfo): Promise<string> {
    try {
      const ddl = await driver.objectDdl(relation)
      this.deps.logger.info(`Read DDL for ${relation.schema}.${relation.name}`)
      return ddl
    } catch (error) {
      throw wrapError('query_failed', 'Reading the object DDL', error)
    }
  }

  private async loadStats(driver: ObjectCatalogDriver, relation: RelationInfo): Promise<ObjectStatsDto> {
    try {
      const stats = await driver.objectStats(relation)
      return {
        totalBytes: stats.totalBytes,
        rowEstimate: stats.rowEstimate,
        indexBytes: stats.indexBytes,
        indexes: stats.indexes.map((index) => ({
          name: index.name,
          bytes: index.bytes,
          unique: index.unique,
          definition: index.definition,
        })),
      }
    } catch (error) {
      throw wrapError('query_failed', 'Reading object statistics', error)
    }
  }

  private scopeOf(target: ObjectTargetInput): string {
    const profile = this.deps.connections.get(target.connectionId)
    return scopeKey(scopeOf(target.connectionId, target.database ?? profile.database))
  }

  private peek<T>(key: string): Promise<T> | undefined {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    return entry.value
  }

  private remember<T>(key: string, value: Promise<T>): Promise<T> {
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    value.catch(() => this.cache.delete(key))
    return value
  }
}

function cacheKey(scope: string, relation: RelationInfo, flavour: string): string {
  // Starts with the scope key so invalidate() can drop a whole connection by prefix.
  return `${scope}\u0000${relation.schema}\u0000${relation.name}\u0000${flavour}`
}

function relationOf(target: ObjectTargetInput): RelationInfo {
  return { schema: target.schema, name: target.name, kind: target.kind as RelationKind }
}

export type { ObjectKind }
