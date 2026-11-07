import type { Memento } from 'vscode'
import { z } from 'zod'

import type { WorkbenchStateDto } from '@shared/protocol'

import type { WorkbenchStateStore } from '../../application/ports'

const STORAGE_KEY = 'dataforge.workbench.v1'

const filterSchema = z.object({
  column: z.string().min(1),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'is null', 'is not null']),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
})

const sortSchema = z.object({
  column: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
})

const consoleSchema = z.object({
  key: z.string().min(1).max(200),
  title: z.string().max(200),
  // A session is a convenience snapshot: cap the SQL so a huge buffer cannot
  // bloat globalState without bound.
  sql: z.string().max(500_000),
  connectionId: z.string().max(200).optional(),
})

const relationSchema = z.object({
  connectionId: z.string().min(1).max(200),
  database: z.string().max(200).optional(),
  schema: z.string().min(1).max(200),
  relation: z.string().min(1).max(200),
})

const dataViewSchema = z.object({
  offset: z.number().int().min(0).max(1_000_000_000),
  orderBy: z.array(sortSchema).max(50),
  filters: z.array(filterSchema).max(50),
})

const stateSchema = z.object({
  activeConnectionId: z.string().max(200).optional(),
  activeConsoleId: z.string().max(200).optional(),
  consoles: z.array(consoleSchema).max(50),
  view: z.enum(['sql', 'data']).optional(),
  relation: relationSchema.optional(),
  data: dataViewSchema.optional(),
})

/**
 * The webview session lives in globalState beside connection profiles.
 * globalState is user-editable on disk, so the shape is re-validated on load
 * and a corrupt entry is treated as "no session" instead of breaking startup.
 */
export class MementoWorkbenchStateStore implements WorkbenchStateStore {
  constructor(private readonly state: Memento) {}

  async load(): Promise<WorkbenchStateDto | null> {
    const raw: unknown = this.state.get(STORAGE_KEY, null)
    const parsed = stateSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  async save(state: WorkbenchStateDto): Promise<void> {
    await this.state.update(STORAGE_KEY, state)
  }
}
