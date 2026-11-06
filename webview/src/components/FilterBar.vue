<script setup lang="ts">
import { computed, ref } from 'vue'
import { ClipboardPaste, Filter, Plus, Wrench, X } from 'lucide-vue-next'

import type { CellValue, DataFilterDto, DataFilterOperator } from '@shared/protocol'

import { useDataEditorStore } from '@/stores/data-editor'
import { useDdlStore } from '@/stores/ddl'
import { useWorkbenchStore } from '@/stores/workbench'
import DdlDialog from '@/components/DdlDialog.vue'
import PasteDialog from '@/components/PasteDialog.vue'

const store = useDataEditorStore()
const workbench = useWorkbenchStore()
const ddl = useDdlStore()
const pasteOpen = ref(false)

const OPERATORS: { value: DataFilterOperator; label: string }[] = [
  { value: 'eq', label: '= equals' },
  { value: 'neq', label: '≠ not equal' },
  { value: 'gt', label: '> greater' },
  { value: 'gte', label: '≥ greater or equal' },
  { value: 'lt', label: '< less' },
  { value: 'lte', label: '≤ less or equal' },
  { value: 'contains', label: 'contains' },
  { value: 'is null', label: 'is null' },
  { value: 'is not null', label: 'is not null' },
]

const column = ref<string>()
const operator = ref<DataFilterOperator>('eq')
const value = ref('')

const nullable = computed(() => operator.value === 'is null' || operator.value === 'is not null')
const canAdd = computed(() => Boolean(column.value) && (nullable.value || value.value.trim().length > 0))

function coerce(targetColumn: string, raw: string): CellValue {
  const info = store.columns.find((entry) => entry.name === targetColumn)
  const type = info?.dataType.toLowerCase() ?? ''
  const text = raw.trim()
  if (/^(int|numeric|decimal|real|double|bigint|smallint|serial)/.test(type) && Number.isFinite(Number(text))) {
    return text.includes('.') ? Number(text) : Number.parseInt(text, 10)
  }
  if (/boolean|bool/.test(type)) return text === 'true' || text === 't' || text === '1'
  return text
}

function add(): void {
  if (!column.value || !canAdd.value) return
  const filter: DataFilterDto = {
    column: column.value,
    operator: operator.value,
    ...(nullable.value ? {} : { value: coerce(column.value, value.value) }),
  }
  void store.addFilter(filter)
  value.value = ''
}

function labelFor(filter: DataFilterDto): string {
  const operatorLabel = OPERATORS.find((entry) => entry.value === filter.operator)?.label ?? filter.operator
  return isNullable(filter) ? `${filter.column} ${operatorLabel}` : `${filter.column} ${operatorLabel} ${String(filter.value ?? '')}`
}

function isNullable(filter: DataFilterDto): boolean {
  return filter.operator === 'is null' || filter.operator === 'is not null'
}

function openSchema(): void {
  if (!store.connectionId || !store.schema) return
  ddl.openFor({
    connectionId: store.connectionId,
    database: store.database,
    schema: store.schema,
    table: store.relation,
  })
}
</script>

<template>
  <section class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="df-chip bg-forge-purple/15">
        <Filter class="h-3 w-3" aria-hidden="true" />
        Filters
      </span>
      <select v-model="column" class="df-input h-7 max-w-40 py-0 text-[11px]" aria-label="Filter column">
        <option :value="undefined" disabled>column…</option>
        <option v-for="entry in store.columns" :key="entry.name" :value="entry.name">{{ entry.name }}</option>
      </select>
      <select v-model="operator" class="df-input h-7 max-w-44 py-0 text-[11px]" aria-label="Filter operator">
        <option v-for="entry in OPERATORS" :key="entry.value" :value="entry.value">{{ entry.label }}</option>
      </select>
      <input
        v-model="value"
        class="df-input h-7 max-w-44 py-0 text-[11px]"
        :disabled="nullable"
        :placeholder="nullable ? 'no value' : 'value'"
        aria-label="Filter value"
        @keydown.enter.prevent="add"
      />
      <button class="df-btn df-btn-primary h-7 px-2 text-[11px]" type="button" :disabled="!canAdd" @click="add">
        <Plus class="h-3 w-3" aria-hidden="true" />
        Add
      </button>
      <button
        v-if="store.filters.length > 0"
        class="df-btn df-btn-ghost h-7 px-2 text-[11px]"
        type="button"
        @click="store.clearFilters()"
      >
        Clear
      </button>
      <span class="flex-1" />
      <button
        class="df-btn df-btn-ghost h-7 px-2 text-[11px]"
        type="button"
        :disabled="!store.editable"
        @click="pasteOpen = true"
      >
        <ClipboardPaste class="h-3 w-3" aria-hidden="true" />
        Paste rows
      </button>
      <button
        class="df-btn df-btn-ghost h-7 px-2 text-[11px]"
        type="button"
        title="Create or change the table structure"
        :disabled="!store.connectionId || !store.schema"
        @click="openSchema"
      >
        <Wrench class="h-3 w-3" aria-hidden="true" />
        Schema
      </button>
    </div>

    <div v-if="store.filters.length > 0" class="flex flex-wrap gap-1.5">
      <span v-for="(filter, index) in store.filters" :key="`${filter.column}-${index}`" class="df-chip bg-surface">
        <span class="df-code">{{ labelFor(filter) }}</span>
        <button
          class="ml-1 rounded-sm p-0.5 hover:bg-ink/10"
          type="button"
          :aria-label="`Remove filter on ${filter.column}`"
          @click="store.removeFilter(index)"
        >
          <X class="h-3 w-3" aria-hidden="true" />
        </button>
      </span>
    </div>

    <DdlDialog v-if="ddl.open" />
    <PasteDialog
      v-model:open="pasteOpen"
      @pasted="(count) => workbench.pushToast('info', `Added ${count} pasted row(s).`)"
    />
  </section>
</template>
