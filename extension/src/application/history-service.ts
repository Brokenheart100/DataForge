import { randomUUID } from 'node:crypto'

import type { Logger } from './ports'

/** One executed statement, kept for the history view and quick re-runs. */
export interface HistoryEntry {
  readonly id: string
  readonly connectionId: string
  readonly connectionName: string
  readonly sql: string
  readonly success: boolean
  readonly durationMs: number
  readonly rowCount: number | null
  readonly executedAt: number
}

export interface HistoryStore {
  load(): Promise<readonly HistoryEntry[]>
  save(entries: readonly HistoryEntry[]): Promise<void>
}

/** Narrow port so `QueryService` can record without knowing how history is kept. */
export interface HistoryRecorder {
  record(entry: Omit<HistoryEntry, 'id'>): Promise<void>
}

/** Old entries are dropped past this size; the queue is a convenience, not a log. */
export const HISTORY_LIMIT = 200

/**
 * Bounded, newest-first query history persisted through a {@link HistoryStore}.
 *
 * Consecutive duplicates (same connection and SQL) collapse into one entry so a
 * re-run does not push everything else out of the queue.
 */
export class HistoryService implements HistoryRecorder {
  private entries: HistoryEntry[] | undefined

  constructor(private readonly deps: { store: HistoryStore; logger: Logger }) {}

  async list(): Promise<readonly HistoryEntry[]> {
    const entries = await this.load()
    return [...entries]
  }

  async record(input: Omit<HistoryEntry, 'id'>): Promise<void> {
    try {
      const entries = await this.load()
      const newest = entries[0]
      const entry: HistoryEntry = { ...input, id: newest?.id ?? randomUUID() }
      const duplicate =
        newest !== undefined && newest.connectionId === input.connectionId && newest.sql === input.sql

      if (duplicate) entries[0] = entry
      else entries.unshift(entry)

      if (entries.length > HISTORY_LIMIT) entries.length = HISTORY_LIMIT
      await this.deps.store.save(entries)
    } catch (error) {
      // History must never fail the query that produced it.
      this.deps.logger.warn(`Could not save query history: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async remove(id: string): Promise<void> {
    const entries = await this.load()
    const index = entries.findIndex((entry) => entry.id === id)
    if (index === -1) return
    entries.splice(index, 1)
    await this.deps.store.save(entries)
  }

  async clear(): Promise<void> {
    this.entries = []
    await this.deps.store.save([])
  }

  private async load(): Promise<HistoryEntry[]> {
    if (!this.entries) this.entries = [...(await this.deps.store.load())]
    return this.entries
  }
}
