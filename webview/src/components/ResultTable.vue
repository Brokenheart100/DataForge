<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { CellValue, QueryResultDto } from '@shared/protocol'

const props = defineProps<{ result: QueryResultDto }>()

/** Result sets can hold 10k rows; paint a first page and extend on demand. */
const PAGE_SIZE = 200
const visibleCount = ref(PAGE_SIZE)

watch(
  () => props.result,
  () => {
    visibleCount.value = PAGE_SIZE
  },
)

const visibleRows = computed(() => props.result.rows.slice(0, visibleCount.value))
const hiddenRows = computed(() => props.result.rows.length - visibleRows.value.length)

function displayValue(cell: CellValue): string {
  return cell === null ? 'NULL' : String(cell)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full border-collapse text-left">
        <thead class="sticky top-0 z-10">
          <tr>
            <th class="df-head bg-paper px-2 py-1 text-[10px] font-bold text-muted">#</th>
            <th v-for="column in result.columns" :key="column.name" class="df-head bg-paper px-2 py-1">
              <span class="block text-[11px] font-bold">{{ column.name }}</span>
              <span class="block text-[10px] font-normal text-muted">{{ column.dataType }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in visibleRows" :key="rowIndex" class="df-body-row">
            <td class="df-row px-2 py-1 text-right text-[10px] text-muted tabular-nums">{{ rowIndex + 1 }}</td>
            <td v-for="(cell, columnIndex) in row" :key="columnIndex" class="df-row df-code max-w-xl truncate px-2 py-1"
              :title="displayValue(cell)" :class="{ 'text-muted italic': cell === null }">
              {{ displayValue(cell) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="result.rows.length === 0" class="p-4 text-xs text-muted">The statement returned no rows.</p>
    </div>

    <div v-if="hiddenRows > 0" class="border-t-2 border-ink bg-surface px-3 py-2">
      <button class="df-btn" type="button" @click="visibleCount += PAGE_SIZE">
        Show {{ Math.min(hiddenRows, PAGE_SIZE) }} more · {{ hiddenRows }} hidden
      </button>
    </div>
  </div>
</template>

<style scoped>
.df-head {
  border-bottom: 2px solid var(--df-ink);
  box-shadow: 0 1px 0 0 var(--df-ink);
}

.df-row {
  border-bottom: 1px solid color-mix(in srgb, var(--df-ink) 14%, transparent);
}

.df-body-row:nth-child(even) {
  background: color-mix(in srgb, var(--df-ink) 3%, transparent);
}

.df-body-row:hover {
  background: color-mix(in srgb, var(--df-yellow) 22%, transparent);
}
</style>
