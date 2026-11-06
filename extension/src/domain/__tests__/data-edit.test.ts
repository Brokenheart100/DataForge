import { describe, expect, it } from 'vitest'

import {
  PendingChangeSet,
  assertEditable,
  identityKey,
  identityOf,
  isEditableRelation,
  primaryKeyColumns,
  type PendingChange,
} from '../data-edit'
import type { ColumnInfo, RelationInfo } from '../driver'
import { DataForgeError } from '../errors'

function column(name: string, ordinal: number, isPrimaryKey = false): ColumnInfo {
  return { name, dataType: 'text', nullable: !isPrimaryKey, defaultValue: null, isPrimaryKey, ordinal }
}

const columns: readonly ColumnInfo[] = [column('id', 1, true), column('tenant', 2, true), column('name', 3)]
const relation: RelationInfo = { schema: 'public', name: 'orders', kind: 'table' }

function errorOf(run: () => void): DataForgeError {
  try {
    run()
  } catch (error) {
    if (error instanceof DataForgeError) return error
    throw error
  }
  throw new Error('expected the call to throw')
}

describe('editable relations', () => {
  it('allows tables and partitioned tables only', () => {
    expect(isEditableRelation('table')).toBe(true)
    expect(isEditableRelation('partitioned table')).toBe(true)
    expect(isEditableRelation('view')).toBe(false)
    expect(isEditableRelation('materialized view')).toBe(false)
    expect(isEditableRelation('foreign table')).toBe(false)
  })

  it('orders primary-key columns by ordinal', () => {
    const unordered = [column('tenant', 4, true), column('name', 2), column('id', 1, true)]
    expect(primaryKeyColumns(unordered).map((entry) => entry.name)).toEqual(['id', 'tenant'])
  })

  it('accepts a table with a primary key', () => {
    expect(() => assertEditable(relation, columns)).not.toThrow()
  })

  it('rejects views with an invalid_request error', () => {
    const error = errorOf(() => assertEditable({ ...relation, kind: 'view' }, columns))
    expect(error.code).toBe('invalid_request')
    expect(error.message).toContain('"public"."orders"')
    expect(error.message).toContain('cannot be edited')
  })

  it('rejects tables without a primary key', () => {
    const error = errorOf(() => assertEditable(relation, [column('name', 1)]))
    expect(error.code).toBe('invalid_request')
    expect(error.message).toContain('no primary key')
  })
})

describe('row identity', () => {
  it('picks primary-key values in declaration order', () => {
    expect(identityOf({ id: 7, tenant: 'acme', name: 'x' }, primaryKeyColumns(columns))).toEqual({ id: 7, tenant: 'acme' })
  })

  it('keeps missing values explicit instead of dropping the key', () => {
    expect(identityOf({ id: 7 }, primaryKeyColumns(columns))).toEqual({ id: 7, tenant: null })
  })

  it('does not depend on property order', () => {
    expect(identityKey({ tenant: 'acme', id: 1 })).toBe(identityKey({ id: 1, tenant: 'acme' }))
  })

  it('distinguishes values that look alike as text', () => {
    expect(identityKey({ id: 1 })).not.toBe(identityKey({ id: '1' }))
    expect(identityKey({ id: null })).not.toBe(identityKey({ id: 'null' }))
    expect(identityKey({ id: false })).not.toBe(identityKey({ id: 'false' }))
  })
})

describe('PendingChangeSet', () => {
  const insert: PendingChange = { kind: 'insert', values: { name: 'new' } }
  const update: PendingChange = { kind: 'update', identity: { id: 1 }, values: { name: 'changed' } }
  const remove: PendingChange = { kind: 'delete', identity: { id: 2 } }

  it('counts each kind and keeps insertion order', () => {
    const changes = new PendingChangeSet()
    changes.track('row-new', insert)
    changes.track('row-1', update)
    changes.track('row-2', remove)
    expect(changes.size).toBe(3)
    expect(changes.counts()).toEqual({ inserts: 1, updates: 1, deletes: 1 })
    expect(changes.entries().map((entry) => entry.rowId)).toEqual(['row-new', 'row-1', 'row-2'])
  })

  it('merges an edit into a pending insert instead of stacking an update', () => {
    const changes = new PendingChangeSet()
    changes.track('row-new', insert)
    changes.track('row-new', update)
    expect(changes.size).toBe(1)
    expect(changes.get('row-new')).toEqual({ kind: 'insert', values: { name: 'changed' } })
  })

  it('discards a pending insert when the row is deleted', () => {
    const changes = new PendingChangeSet()
    changes.track('row-new', insert)
    changes.track('row-new', { kind: 'delete', identity: {} })
    expect(changes.size).toBe(0)
    expect(changes.counts()).toEqual({ inserts: 0, updates: 0, deletes: 0 })
  })

  it('tracks delete then update as an update on the same row', () => {
    const changes = new PendingChangeSet()
    changes.track('row-2', remove)
    changes.track('row-2', update)
    expect(changes.get('row-2')).toEqual(update)
  })

  it('reports two rows addressing the same physical row', () => {
    const changes = new PendingChangeSet()
    changes.track('row-a', { kind: 'update', identity: { tenant: 'acme', id: 1 }, values: {} })
    changes.track('row-b', { kind: 'update', identity: { id: 1, tenant: 'acme' }, values: {} })
    changes.track('row-c', { kind: 'delete', identity: { id: 2 } })
    expect(changes.conflictingRowIds().sort()).toEqual(['row-a', 'row-b'])
  })

  it('ignores inserts when looking for conflicts', () => {
    const changes = new PendingChangeSet()
    changes.track('row-a', insert)
    changes.track('row-b', insert)
    expect(changes.conflictingRowIds()).toEqual([])
  })

  it('restores a snapshot and drops later edits', () => {
    const changes = new PendingChangeSet()
    changes.track('row-1', update)
    const snapshot = changes.snapshot()
    changes.track('row-2', remove)
    changes.restore(snapshot)
    expect(changes.entries().map((entry) => entry.rowId)).toEqual(['row-1'])
  })

  it('discards and clears tracked rows', () => {
    const changes = new PendingChangeSet()
    changes.track('row-1', update)
    changes.track('row-2', remove)
    expect(changes.discard('row-1')).toBe(true)
    expect(changes.discard('row-1')).toBe(false)
    changes.clear()
    expect(changes.size).toBe(0)
  })
})
