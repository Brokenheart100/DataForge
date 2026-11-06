import type { CellValue } from '@shared/protocol'

import type { ColumnInfo, RelationInfo, RelationKind, RowIdentity } from './driver'
import { DataForgeError } from './errors'

/** Values keyed by column name, as edited in the grid. */
export type RowValues = Readonly<Record<string, CellValue>>

export type ChangeKind = 'insert' | 'update' | 'delete'

export interface InsertChange {
  readonly kind: 'insert'
  readonly values: RowValues
}

export interface UpdateChange {
  readonly kind: 'update'
  readonly identity: RowIdentity
  readonly values: RowValues
}

export interface DeleteChange {
  readonly kind: 'delete'
  readonly identity: RowIdentity
}

export type PendingChange = InsertChange | UpdateChange | DeleteChange

export interface ChangeEntry {
  readonly rowId: string
  readonly change: PendingChange
}

export interface ChangeCounts {
  readonly inserts: number
  readonly updates: number
  readonly deletes: number
}

export interface ChangeSnapshot {
  readonly entries: readonly ChangeEntry[]
}

/** Only real tables can be written to; views stay read-only. */
const EDITABLE_KINDS: readonly RelationKind[] = ['table', 'partitioned table']

export function isEditableRelation(kind: RelationKind): boolean {
  return EDITABLE_KINDS.includes(kind)
}

/** Primary-key columns in declaration order. */
export function primaryKeyColumns(columns: readonly ColumnInfo[]): ColumnInfo[] {
  return columns.filter((column) => column.isPrimaryKey).sort((a, b) => a.ordinal - b.ordinal)
}

export function identityOf(values: RowValues, primaryKey: readonly ColumnInfo[]): RowIdentity {
  const identity: Record<string, CellValue> = {}
  for (const column of primaryKey) identity[column.name] = values[column.name] ?? null
  return identity
}

/**
 * Stable key for a row identity.
 *
 * Values are type-tagged because `1` and `'1'` identify different rows, and
 * keys are sorted so the order they arrived in never changes the result.
 */
export function identityKey(identity: RowIdentity): string {
  return Object.keys(identity)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${encodeValue(identity[name])}`)
    .join('|')
}

function encodeValue(value: CellValue | undefined): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return `s:${JSON.stringify(value)}`
    case 'number':
      return `n:${String(value)}`
    case 'boolean':
      return `b:${String(value)}`
  }
}

/**
 * Rejects editing for anything the UI cannot address safely.
 *
 * Called on the host before a page is served, so the webview never offers an
 * edit path that would silently update the wrong row.
 */
export function assertEditable(relation: RelationInfo, columns: readonly ColumnInfo[]): void {
  const label = `"${relation.schema}"."${relation.name}"`
  if (!isEditableRelation(relation.kind)) {
    throw new DataForgeError(
      'invalid_request',
      `${label} is a ${relation.kind} and cannot be edited. Only tables and partitioned tables are editable.`,
    )
  }
  if (primaryKeyColumns(columns).length === 0) {
    throw new DataForgeError(
      'invalid_request',
      `${label} has no primary key, so rows cannot be identified safely. Add a primary key to edit this table.`,
    )
  }
}

/**
 * Ordered set of pending row changes, keyed by the grid row id.
 *
 * Merging rules keep one entry per row: editing a pending insert updates that
 * insert instead of stacking an update, and deleting a pending insert simply
 * discards it.
 */
export class PendingChangeSet {
  private readonly changes = new Map<string, PendingChange>()

  constructor(initial?: Iterable<readonly [string, PendingChange]>) {
    if (!initial) return
    for (const [rowId, change] of initial) this.changes.set(rowId, change)
  }

  get size(): number {
    return this.changes.size
  }

  get(rowId: string): PendingChange | undefined {
    return this.changes.get(rowId)
  }

  entries(): ChangeEntry[] {
    return [...this.changes].map(([rowId, change]) => ({ rowId, change }))
  }

  track(rowId: string, change: PendingChange): void {
    const existing = this.changes.get(rowId)
    if (change.kind === 'delete') {
      if (existing?.kind === 'insert') {
        this.changes.delete(rowId)
        return
      }
      this.changes.set(rowId, change)
      return
    }
    if (change.kind === 'update' && existing?.kind === 'insert') {
      this.changes.set(rowId, { kind: 'insert', values: change.values })
      return
    }
    this.changes.set(rowId, change)
  }

  discard(rowId: string): boolean {
    return this.changes.delete(rowId)
  }

  clear(): void {
    this.changes.clear()
  }

  counts(): ChangeCounts {
    let inserts = 0
    let updates = 0
    let deletes = 0
    for (const change of this.changes.values()) {
      if (change.kind === 'insert') inserts += 1
      else if (change.kind === 'update') updates += 1
      else deletes += 1
    }
    return { inserts, updates, deletes }
  }

  /**
   * Row ids that target the same physical row through different grid rows.
   *
   * This should not happen with a sane grid, but two edits of one row would
   * otherwise apply twice, so the commit path refuses to run.
   */
  conflictingRowIds(): string[] {
    const owners = new Map<string, string>()
    const conflicts = new Set<string>()
    for (const [rowId, change] of this.changes) {
      if (change.kind === 'insert') continue
      const key = identityKey(change.identity)
      const owner = owners.get(key)
      if (owner === undefined) {
        owners.set(key, rowId)
        continue
      }
      conflicts.add(owner)
      conflicts.add(rowId)
    }
    return [...conflicts]
  }

  snapshot(): ChangeSnapshot {
    return { entries: this.entries() }
  }

  restore(snapshot: ChangeSnapshot): void {
    this.changes.clear()
    for (const { rowId, change } of snapshot.entries) this.changes.set(rowId, change)
  }
}
