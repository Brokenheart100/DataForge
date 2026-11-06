<script setup lang="ts">
import { computed, ref } from 'vue'
import { AgGridVue } from 'ag-grid-vue3'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellKeyDownEvent,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type RowClassParams,
  type RowSelectionOptions,
  type SelectionChangedEvent,
  type SortChangedEvent,
  type ValueGetterParams,
  type ValueSetterParams,
} from 'ag-grid-community'

import type { CellValue } from '@shared/protocol'

import { useDataEditorStore, type GridRow } from '../stores/data-editor'

ModuleRegistry.registerModules([AllCommunityModule])

const store = useDataEditorStore()
const gridApi = ref<GridApi | null>(null)

/** AG Grid theming follows the VS Code surface through the design tokens. */
const gridTheme = themeQuartz.withParams({
  accentColor: 'var(--df-purple)',
  backgroundColor: 'var(--df-surface)',
  foregroundColor: 'var(--df-ink)',
  borderColor: 'color-mix(in srgb, var(--df-ink) 40%, transparent)',
  headerBackgroundColor: 'var(--df-yellow)',
  headerTextColor: '#14121a',
  oddRowBackgroundColor: 'color-mix(in srgb, var(--df-ink) 3%, transparent)',
  headerFontWeight: 700,
  fontFamily: 'var(--vscode-editor-font-family, ui-monospace)',
  fontSize: '12px',
  rowHeight: 27,
  cellHorizontalPadding: 8,
  wrapperBorderRadius: 0,
})

const rowSelection = { mode: 'singleRow' } satisfies RowSelectionOptions

function isCellEditable(row: GridRow | undefined, columnName: string, primaryKey: boolean): boolean {
  if (!store.editable) return false
  if (row?.status === 'deleted') return false
  if (row?.status === 'inserted') return true
  // Changing a primary key in place would move the row under its own identity.
  return !primaryKey
}

const columnDefs = computed<ColDef<GridRow>[]>(() =>
  store.columns.map((column) => {
    const header = column.isPrimaryKey ? `${column.name} · PK` : column.name
    return {
      colId: column.name,
      headerName: header,
      headerTooltip: `${column.dataType}${column.nullable ? '' : ' · NOT NULL'}${
        column.defaultValue ? ` · default ${column.defaultValue}` : ''
      }`,
      sortable: true,
      minWidth: 110,
      valueGetter: (params: ValueGetterParams<GridRow>) => params.data?.values[column.name] ?? null,
      valueSetter: (params: ValueSetterParams<GridRow>) => {
        if (!params.data) return false
        store.setCell(params.data.rowId, column.name, params.newValue as CellValue)
        return true
      },
      editable: (params: { data?: GridRow }) => isCellEditable(params.data, column.name, column.isPrimaryKey),
    }
  }),
)

const rowClassRules = {
  'df-row--inserted': (params: RowClassParams<GridRow>) => params.data?.status === 'inserted',
  'df-row--updated': (params: RowClassParams<GridRow>) => params.data?.status === 'updated',
  'df-row--deleted': (params: RowClassParams<GridRow>) => params.data?.status === 'deleted',
}

function onGridReady(event: GridReadyEvent): void {
  gridApi.value = event.api
}

function onSelectionChanged(event: SelectionChangedEvent): void {
  store.setSelection(event.api.getSelectedRows().map((row) => row.rowId))
}

async function onSortChanged(event: SortChangedEvent): Promise<void> {
  const sorted = event.api.getColumnState().find((state) => state.sort !== null && state.sort !== undefined)
  await store.sortBy(sorted?.colId ?? '', sorted?.sort === 'desc' ? 'desc' : sorted ? 'asc' : null)
}

function onCellKeyDown(event: CellKeyDownEvent<GridRow>): void {
  const key = event.event instanceof KeyboardEvent ? event.event.key : ''
  if (key !== 'Delete' || !store.editable || !event.data) return
  event.event?.preventDefault()
  store.deleteRow(event.data.rowId)
  gridApi.value?.refreshCells({ rowNodes: [event.node] })
}
</script>

<template>
  <div class="df-grid-shell">
    <div class="df-grid">
      <AgGridVue
        class="df-grid-ag"
        :theme="gridTheme"
        :row-data="store.rows"
        :column-defs="columnDefs"
        :row-selection="rowSelection"
        :row-class-rules="rowClassRules"
        :get-row-id="(params: { data: GridRow }) => params.data.rowId"
        :default-col-def="{ suppressHeaderMenuButton: true, resizable: true }"
        :single-click-edit="false"
        :stop-editing-when-cells-lose-focus="true"
        :animate-rows="false"
        :overlay-no-rows-template="'<span class=&quot;df-grid-empty&quot;>This page is empty.</span>'"
        @grid-ready="onGridReady"
        @selection-changed="onSelectionChanged"
        @sort-changed="onSortChanged"
        @cell-key-down="onCellKeyDown"
      />
    </div>

    <div class="df-grid-footer">
      <span class="df-grid-count">
        {{ store.loading ? 'Loading…' : `${store.totalRows} row(s)` }}
        <template v-if="store.loading === false"> · page {{ store.pageNumber }} / {{ store.totalPages }}</template>
      </span>
      <span v-if="store.readOnlyReason" class="df-grid-readonly">{{ store.readOnlyReason }}</span>
      <span class="df-grid-spacer" />
      <button class="df-btn df-btn-ghost" :disabled="store.loading || store.offset === 0" @click="store.gotoPage(1)">
        « First
      </button>
      <button class="df-btn df-btn-ghost" :disabled="store.loading || store.offset === 0" @click="store.gotoPage(store.pageNumber - 1)">
        ‹ Prev
      </button>
      <button
        class="df-btn df-btn-ghost"
        :disabled="store.loading || store.pageNumber >= store.totalPages"
        @click="store.gotoPage(store.pageNumber + 1)"
      >
        Next ›
      </button>
      <button
        class="df-btn df-btn-ghost"
        :disabled="store.loading || store.pageNumber >= store.totalPages"
        @click="store.gotoPage(store.totalPages)"
      >
        Last »
      </button>
    </div>
  </div>
</template>

<style scoped>
.df-grid-shell {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.df-grid {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  border: 2px solid var(--df-ink);
  background: var(--df-surface);
}

/* AG Grid measures its container height, so the component root needs a
   definite one: a percentage height would resolve against `auto`. */
.df-grid-ag {
  min-height: 0;
  flex: 1;
}

:deep(.ag-root-wrapper) {
  height: 100%;
}

.df-grid-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 2px 0;
}

.df-grid-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--df-muted);
}

.df-grid-readonly {
  font-size: 11px;
  font-weight: 700;
  color: var(--df-red);
}

.df-grid-spacer {
  flex: 1;
}

:deep(.df-row--inserted) {
  background: color-mix(in srgb, var(--df-mint) 26%, transparent) !important;
}

:deep(.df-row--updated) {
  background: color-mix(in srgb, var(--df-yellow) 30%, transparent) !important;
}

:deep(.df-row--deleted) {
  background: color-mix(in srgb, var(--df-red) 18%, transparent) !important;
  text-decoration: line-through;
  opacity: 0.75;
}

:deep(.ag-cell-inline-editing) {
  border: 2px solid var(--df-purple) !important;
  box-shadow: none !important;
}
</style>
