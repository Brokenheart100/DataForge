import type * as vscode from 'vscode'
import { z } from 'zod'

import type { HistoryEntry, HistoryStore } from '../../application/history-service'

const HISTORY_KEY = 'dataforge.history.v1'

/** Stored entries pass through Zod: globalState is user-editable on disk. */
const entrySchema = z.object({
  id: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(128),
  connectionName: z.string().max(253),
  sql: z.string().min(1).max(1_000_000),
  success: z.boolean(),
  durationMs: z.number().nonnegative(),
  rowCount: z.number().int().nonnegative().nullable(),
  executedAt: z.number().nonnegative(),
})

const entriesSchema = z.array(entrySchema)

export class MementoHistoryStore implements HistoryStore {
  constructor(private readonly memento: vscode.Memento) {}

  async load(): Promise<readonly HistoryEntry[]> {
    const parsed = entriesSchema.safeParse(this.memento.get<unknown>(HISTORY_KEY, []))
    if (!parsed.success) return []
    return parsed.data.map((entry) => ({ ...entry }))
  }

  async save(entries: readonly HistoryEntry[]): Promise<void> {
    await this.memento.update(HISTORY_KEY, entries.map((entry) => ({ ...entry })))
  }
}
