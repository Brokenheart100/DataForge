<script setup lang="ts">
import { computed, ref } from 'vue'
import { AgGridVue } from 'ag-grid-vue3'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellDoubleClickedEvent,
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
import { t } from '@/lib/i18n'

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

function isCellEditable(
  row: GridRow | undefined,
  columnName: string,
  primaryKey: boolean,
  generated = false,
): boolean {
  if (!store.editable || generated) return false
  if (row?.status === 'deleted') return false
  if (row?.status === 'inserted') return true
  // Changing a primary key in place would move the row under its own identity.
  return !primaryKey
}

const columnDefs = computed<ColDef<GridRow>[]>(() =>
  store.columns.map((column) => {
    const header = column.generated
      ? `${column.name} · ${t('grid.computed')}`
      : column.isPrimaryKey
        ? `${column.name} · PK`
        : column.name
    return {
      colId: column.name,
      headerName: header,
      headerTooltip: `${column.dataType}${column.nullable ? '' : ` · ${t('grid.notNull')}`}${
        column.defaultValue ? ` · ${t('grid.default', { value: column.defaultValue })}` : ''
      }`,
      sortable: true,
      minWidth: 110,
      valueGetter: (params: ValueGetterParams<GridRow>) => params.data?.values[column.name] ?? null,
      valueSetter: (params: ValueSetterParams<GridRow>) => {
        if (!params.data) return false
        store.setCell(params.data.rowId, column.name, params.newValue as CellValue)
        return true
      },
      editable: (params: { data?: GridRow }) =>
        isCellEditable(params.data, column.name, column.isPrimaryKey, column.generated),
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

const pageJump = ref('')

const overlayNoRows = computed(
  () => `<span class="df-grid-empty">${t('grid.empty')}</span>`,
)

async function jumpToPage(): Promise<void> {
  const requested = Number.parseInt(pageJump.value, 10)
  pageJump.value = ''
  if (!Number.isFinite(requested)) return
  await store.gotoPage(requested)
}

async function onSortChanged(event: SortChangedEvent): Promise<void> {
  const sorted = event.api
    .getColumnState()
    .filter((state) => state.sort === 'asc' || state.sort === 'desc')
    .sort((left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0))
    .map((state) => ({ column: state.colId, direction: state.sort === 'desc' ? ('desc' as const) : ('asc' as const) }))
  await store.sortBy(sorted)
}

const preview = ref<{ column: string; text: string } | null>(null)

function previewValue(column: string, value: CellValue | undefined): boolean {
  if (value === null || value === undefined) return false
  const text = String(value)
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false
  try {
    preview.value = { column, text: JSON.stringify(JSON.parse(trimmed), null, 2) }
    return true
  } catch {
    // Not valid JSON; leave the cell to its normal editor.
    return false
  }
}

function onCellDoubleClicked(event: CellDoubleClickedEvent<GridRow>): void {
  const column = event.colDef.colId
  if (!column || !event.data) return
  if (previewValue(column, event.data.values[column])) {
    gridApi.value?.stopEditing(true)
  }
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
        :overlay-no-rows-template="overlayNoRows"
        @grid-ready="onGridReady"
        @selection-changed="onSelectionChanged"
        @sort-changed="onSortChanged"
        @cell-key-down="onCellKeyDown"
        @cell-double-clicked="onCellDoubleClicked"
      />
    </div>

    <div class="df-grid-footer">
      <span class="df-grid-count">
        {{ store.loading ? t('grid.loading') : t('grid.rows', { count: store.totalRows }) }}
        <template v-if="store.loading === false"> · {{ t('grid.page', { page: store.pageNumber, pages: store.totalPages }) }}</template>
      </span>
      <span v-if="store.readOnlyReason" class="df-grid-readonly">{{ store.readOnlyReason }}</span>
      <span class="df-grid-spacer" />
      <label class="df-grid-jump">
        {{ t('grid.goTo') }}
        <input
          v-model="pageJump"
          class="df-input df-grid-jump-input"
          type="number"
          min="1"
          :max="store.totalPages"
          :disabled="store.loading || store.totalPages <= 1"
          :aria-label="t('grid.pageNumber')"
          @keydown.enter.prevent="jumpToPage"
        />
      </label>
      <button class="df-btn df-btn-ghost" :disabled="store.loading || store.offset === 0" @click="store.gotoPage(1)">
        {{ t('grid.first') }}
      </button>
      <button class="df-btn df-btn-ghost" :disabled="store.loading || store.offset === 0" @click="store.gotoPage(store.pageNumber - 1)">
        {{ t('grid.prev') }}
      </button>
      <button
        class="df-btn df-btn-ghost"
        :disabled="store.loading || store.pageNumber >= store.totalPages"
        @click="store.gotoPage(store.pageNumber + 1)"
      >
        {{ t('grid.next') }}
      </button>
      <button
        class="df-btn df-btn-ghost"
        :disabled="store.loading || store.pageNumber >= store.totalPages"
        @click="store.gotoPage(store.totalPages)"
      >
        {{ t('grid.last') }}
      </button>
    </div>

    <div
      v-if="preview"
      class="fixed inset-0 z-40 grid place-items-center bg-black/40 p-6"
      @click.self="preview = null"
    >
      <section class="df-panel df-cell-preview" role="dialog" aria-modal="true" :aria-label="t('grid.valueOf', { column: preview.column })">
        <header class="df-cell-preview-header">
          <span class="df-code text-xs font-bold">{{ preview.column }}</span>
          <button class="df-btn df-btn-ghost h-7 px-2 text-[11px]" type="button" @click="preview = null">{{ t('common.close') }}</button>
        </header>
        <pre class="df-code df-cell-preview-body">{{ preview.text }}</pre>
      </section>
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

.df-grid-jump {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--df-muted);
}

.df-grid-jump-input {
  width: 56px;
  height: 24px;
  padding: 0 4px;
  font-size: 11px;
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

.df-cell-preview {
  width: min(640px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}

.df-cell-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.df-cell-preview-body {
  min-height: 48px;
  max-height: 56vh;
  flex: 0 1 auto;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  padding: 8px;
  background: var(--df-surface);
}

:deep(.ag-cell-inline-editing) {
  border: 2px solid var(--df-purple) !important;
  box-shadow: none !important;
}
</style>
