import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { CellValue, DataChangeDto, DataColumnDto, DataPageDto, DataRowDto, DataSortDto } from '@shared/protocol'

import { HostRequestError, host } from '../lib/host'

export type RowStatus = 'clean' | 'inserted' | 'updated' | 'deleted'

export interface GridRow {
  rowId: string
  identity: Record<string, CellValue>
  version: string | null
  values: Record<string, CellValue>
  original: Record<string, CellValue>
  status: RowStatus
}

export type SortDirection = 'asc' | 'desc'

const PAGE_SIZE = 200

function rowIdOf(row: DataRowDto, index: number, offset: number): string {
  const identity = Object.keys(row.identity)
    .sort()
    .map((column) => `${column}=${String(row.identity[column])}`)
    .join('&')
  return identity.length > 0 ? identity : `row-${offset + index}`
}

function toGridRow(row: DataRowDto, columnList: DataColumnDto[], index: number, offset: number): GridRow {
  const values: Record<string, CellValue> = {}
  columnList.forEach((column, position) => {
    values[column.name] = row.values[position] ?? null
  })
  return {
    rowId: rowIdOf(row, index, offset),
    identity: { ...row.identity },
    version: row.version,
    values,
    original: { ...values },
    status: 'clean',
  }
}

/** A row is sent only after the user touched it; clean rows never leave the webview. */
function changeOf(row: GridRow): DataChangeDto {
  if (row.status === 'inserted') {
    return { rowId: row.rowId, version: null, change: { kind: 'insert', values: row.values } }
  }
  if (row.status === 'deleted') {
    return { rowId: row.rowId, version: row.version, change: { kind: 'delete', identity: row.identity } }
  }

  const values: Record<string, CellValue> = {}
  for (const [column, value] of Object.entries(row.values)) {
    if (row.original[column] !== value) values[column] = value
  }
  return { rowId: row.rowId, version: row.version, change: { kind: 'update', identity: row.identity, values } }
}

export const useDataEditorStore = defineStore('data-editor', () => {
  const connectionId = ref<string | null>(null)
  const schema = ref<string | null>(null)
  const relation = ref<string | null>(null)
  const columns = ref<DataColumnDto[]>([])
  const primaryKey = ref<string[]>([])
  const rows = ref<GridRow[]>([])
  const totalRows = ref(0)
  const limit = ref(PAGE_SIZE)
  const offset = ref(0)
  const orderBy = ref<DataSortDto[]>([])
  const editable = ref(false)
  const readOnlyReason = ref<string | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const exporting = ref(false)
  const commitRequestId = ref<string | null>(null)
  const exportRequestId = ref<string | null>(null)
  const error = ref<string | null>(null)
  const conflictKeys = ref<string[]>([])
  const selectedRowIds = ref<string[]>([])
  let newRowSequence = 0

  const isOpen = computed(() => connectionId.value !== null && schema.value !== null && relation.value !== null)
  const qualifiedName = computed(() => (schema.value && relation.value ? `${schema.value}.${relation.value}` : ''))
  const totalPages = computed(() => Math.max(1, Math.ceil(totalRows.value / limit.value)))
  const pageNumber = computed(() => Math.floor(offset.value / limit.value) + 1)
  const changes = computed<DataChangeDto[]>(() =>
    rows.value.filter((row) => row.status !== 'clean').map((row) => changeOf(row)),
  )
  const pendingCounts = computed(() => {
    const counts = { inserted: 0, updated: 0, deleted: 0 }
    for (const row of rows.value) {
      if (row.status === 'inserted') counts.inserted += 1
      else if (row.status === 'updated') counts.updated += 1
      else if (row.status === 'deleted') counts.deleted += 1
    }
    return counts
  })
  const hasPending = computed(() => changes.value.length > 0)

  function applyPage(page: DataPageDto): void {
    columns.value = page.columns
    primaryKey.value = page.primaryKey
    rows.value = page.rows.map((row, index) => toGridRow(row, page.columns, index, page.offset))
    totalRows.value = page.totalRows
    limit.value = page.limit
    offset.value = page.offset
    editable.value = page.editable
    readOnlyReason.value = page.readOnlyReason ?? null
  }

  async function load(nextOffset = offset.value): Promise<void> {
    if (!connectionId.value || !schema.value || !relation.value) return
    loading.value = true
    error.value = null
    try {
      applyPage(
        await host.request('data.page', {
          connectionId: connectionId.value,
          schema: schema.value,
          relation: relation.value,
          limit: limit.value,
          offset: Math.max(0, nextOffset),
          orderBy: orderBy.value,
        }),
      )
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function open(nextConnectionId: string, nextSchema: string, nextRelation: string): Promise<void> {
    connectionId.value = nextConnectionId
    schema.value = nextSchema
    relation.value = nextRelation
    orderBy.value = []
    offset.value = 0
    rows.value = []
    conflictKeys.value = []
    await load(0)
  }

  function close(): void {
    connectionId.value = null
    schema.value = null
    relation.value = null
    rows.value = []
    columns.value = []
    primaryKey.value = []
    totalRows.value = 0
    error.value = null
    conflictKeys.value = []
  }

  async function gotoPage(page: number): Promise<void> {
    const clamped = Math.min(Math.max(1, page), totalPages.value)
    await load((clamped - 1) * limit.value)
  }

  async function sortBy(column: string, direction: SortDirection | null): Promise<void> {
    orderBy.value = direction === null ? [] : [{ column, direction }]
    await load(0)
  }

  function setSelection(rowIds: string[]): void {
    selectedRowIds.value = rowIds
  }

  function findRow(rowId: string): GridRow | undefined {
    return rows.value.find((row) => row.rowId === rowId)
  }

  function setCell(rowId: string, column: string, value: CellValue): void {
    const row = findRow(rowId)
    if (!row || row.status === 'deleted') return
    row.values = { ...row.values, [column]: value }
    if (row.status === 'clean' && row.values[column] !== row.original[column]) row.status = 'updated'
  }

  function addRow(): string {
    const values: Record<string, CellValue> = {}
    for (const column of columns.value) values[column.name] = null
    newRowSequence += 1
    const row: GridRow = {
      rowId: `new-${newRowSequence}`,
      identity: {},
      version: null,
      values,
      original: { ...values },
      status: 'inserted',
    }
    rows.value = [row, ...rows.value]
    return row.rowId
  }

  function deleteRow(rowId: string): void {
    const row = findRow(rowId)
    if (!row) return
    if (row.status === 'inserted') {
      rows.value = rows.value.filter((candidate) => candidate.rowId !== rowId)
      return
    }
    row.status = 'deleted'
  }

  function undoRow(rowId: string): void {
    const row = findRow(rowId)
    if (!row) return
    if (row.status === 'inserted') {
      rows.value = rows.value.filter((candidate) => candidate.rowId !== rowId)
      return
    }
    row.values = { ...row.original }
    row.status = 'clean'
  }

  function discardAll(): void {
    rows.value = rows.value.filter((row) => row.status !== 'inserted')
    for (const row of rows.value) {
      row.values = { ...row.original }
      row.status = 'clean'
    }
    conflictKeys.value = []
  }

  async function commit(): Promise<{ inserted: number; updated: number; deleted: number }> {
    if (!connectionId.value || !schema.value || !relation.value) throw new Error('No relation is open.')
    if (changes.value.length === 0) return { inserted: 0, updated: 0, deleted: 0 }

    const requestId = crypto.randomUUID()
    commitRequestId.value = requestId
    saving.value = true
    error.value = null
    conflictKeys.value = []
    try {
      const result = await host.request(
        'data.commit',
        {
          connectionId: connectionId.value,
          schema: schema.value,
          relation: relation.value,
          changes: changes.value,
        },
        requestId,
      )
      await load(offset.value)
      return { inserted: result.inserted, updated: result.updated, deleted: result.deleted }
    } catch (cause) {
      if (cause instanceof HostRequestError && cause.code === 'conflict') conflictKeys.value = [...cause.conflictingKeys]
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      commitRequestId.value = null
      saving.value = false
    }
  }

  /** Asks the host to abort the running commit; the transaction rolls back. */
  async function cancelCommit(): Promise<void> {
    const target = commitRequestId.value
    if (!target) return
    try {
      await host.request('data.cancel', { targetRequestId: target })
    } catch {
      // The commit already finished; cancelling it is a no-op.
    }
  }

  /** Asks the host to stream this relation into a CSV file. */
  async function exportCsv(): Promise<{ saved: boolean; path?: string; rowCount?: number }> {
    if (!connectionId.value || !schema.value || !relation.value) throw new Error('No relation is open.')

    const requestId = crypto.randomUUID()
    exportRequestId.value = requestId
    exporting.value = true
    error.value = null
    try {
      return await host.request(
        'data.export',
        {
          connectionId: connectionId.value,
          schema: schema.value,
          relation: relation.value,
        },
        requestId,
      )
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      exportRequestId.value = null
      exporting.value = false
    }
  }

  /** Aborts the running export; the host deletes the partial file. */
  async function cancelExport(): Promise<void> {
    const target = exportRequestId.value
    if (!target) return
    try {
      await host.request('data.cancel', { targetRequestId: target })
    } catch {
      // The export already finished; cancelling it is a no-op.
    }
  }

  return {
    connectionId,
    schema,
    relation,
    columns,
    primaryKey,
    rows,
    totalRows,
    limit,
    offset,
    orderBy,
    editable,
    readOnlyReason,
    loading,
    saving,
    exporting,
    error,
    conflictKeys,
    selectedRowIds,
    isOpen,
    qualifiedName,
    totalPages,
    pageNumber,
    changes,
    pendingCounts,
    hasPending,
    open,
    close,
    load,
    gotoPage,
    sortBy,
    setSelection,
    setCell,
    addRow,
    deleteRow,
    undoRow,
    discardAll,
    commit,
    cancelCommit,
    exportCsv,
    cancelExport,
  }
})
