<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { AlertTriangle, Check, FileSpreadsheet, Loader2, Upload, X } from 'lucide-vue-next'

import type { ImportFormat, ImportMappingDto } from '@shared/protocol'

import { host } from '../lib/host'
import { t } from '@/lib/i18n'
import { useDataEditorStore } from '../stores/data-editor'
import { useWorkbenchStore } from '../stores/workbench'

const editor = useDataEditorStore()
const workbench = useWorkbenchStore()

const format = ref<ImportFormat>('csv')
const delimiter = ref(',')
const hasHeader = ref(true)
const mapping = ref<ImportMappingDto[]>([])
const globals = ref<string[]>([])

let unsubscribe: (() => void) | null = null

watch(
  () => editor.importPreview,
  (preview) => {
    mapping.value = preview ? preview.mapping.map((entry) => ({ ...entry })) : []
    globals.value = preview ? preview.issues : []
  },
  { immediate: true },
)

onMounted(() => {
  unsubscribe = host.onEvent((event) => {
    if (event.type === 'import.progress') editor.applyImportProgress(event.payload)
  })
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})

function chooseFile(): void {
  void editor.previewImport(format.value, {
    delimiter: delimiter.value,
    hasHeader: hasHeader.value,
  })
}

async function submit(): Promise<void> {
  await editor.runImport(mapping.value)
  const result = editor.importResult
  if (result && !result.cancelled) {
    workbench.pushToast('info', t('import.importedToast', { count: result.imported, name: editor.qualifiedName }))
  }
}

async function cancel(): Promise<void> {
  await editor.cancelImport()
}

function close(): void {
  editor.closeImport()
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6" role="dialog" aria-modal="true">
    <section class="df-panel flex max-h-full w-full max-w-3xl flex-col overflow-hidden bg-paper">
      <header class="flex items-center gap-2 border-b-2 border-ink bg-ink px-3 py-2 text-paper">
        <FileSpreadsheet class="h-4 w-4" />
        <h2 class="text-sm font-black uppercase tracking-wide">{{ t('import.title') }}</h2>
        <span class="df-chip ml-1 bg-surface text-ink">{{ editor.qualifiedName }}</span>
        <button class="df-btn df-btn-ghost ml-auto !px-2 !py-1" type="button" :title="t('common.close')" @click="close">
          <X class="h-3.5 w-3.5" />
        </button>
      </header>

      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <div class="flex flex-wrap items-end gap-2">
          <label class="grid gap-1 text-[11px]">
            <span class="df-label">{{ t('import.type') }}</span>
            <select v-model="format" class="df-input !w-36" :disabled="editor.importing">
              <option value="csv">CSV / TSV</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <label v-if="format === 'csv'" class="grid gap-1 text-[11px]">
            <span class="df-label">{{ t('import.delimiter') }}</span>
            <select v-model="delimiter" class="df-input !w-24" :disabled="editor.importing">
              <option value=",">{{ t('import.comma') }}</option>
              <option value=";">{{ t('import.semicolon') }}</option>
              <option :value="'\t'">{{ t('import.tab') }}</option>
            </select>
          </label>
          <label v-if="format === 'csv'" class="flex items-center gap-1 pb-1.5 text-[11px]">
            <input v-model="hasHeader" type="checkbox" :disabled="editor.importing" />
            {{ t('import.header') }}
          </label>
          <button class="df-btn" type="button" :disabled="editor.importLoading || editor.importing" @click="chooseFile">
            <Loader2 v-if="editor.importLoading" class="h-3.5 w-3.5 animate-spin" />
            <Upload v-else class="h-3.5 w-3.5" />
            {{ t('import.choose') }}
          </button>
        </div>

        <div v-if="editor.importPreview" class="space-y-3">
          <p class="text-[11px] text-muted">
            {{ editor.importPreview.fileName }} · {{ sizeLabel(editor.importPreview.totalBytes) }} ·
            {{ editor.importPreview.format.toUpperCase() }}
          </p>

          <div class="overflow-auto rounded border-2 border-ink">
            <table class="min-w-full border-collapse text-[11px]">
              <thead>
                <tr class="bg-forge-yellow text-ink">
                  <th
                    v-for="header in editor.importPreview.headers"
                    :key="header"
                    class="border-r border-ink/30 px-2 py-1 text-left font-bold last:border-r-0"
                  >
                    {{ header }}
                  </th>
                </tr>
                <tr class="bg-surface">
                  <th v-for="header in editor.importPreview.headers" :key="`${header}-map`" class="px-1 py-1">
                    <select
                      class="df-input !w-full !py-0.5 text-[11px]"
                      :value="mapping.find((entry) => entry.source === header)?.target ?? null"
                      :disabled="editor.importing"
                      @change="
                        mapping = mapping.map((entry) =>
                          entry.source === header
                            ? { ...entry, target: ($event.target as HTMLSelectElement).value || null }
                            : entry,
                        )
                      "
                    >
                      <option :value="null">{{ t('import.ignore') }}</option>
                      <option
                        v-for="column in editor.importPreview.columns"
                        :key="column.name"
                        :value="column.name"
                      >
                        {{ column.name }}
                      </option>
                    </select>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, index) in editor.importPreview.sample"
                  :key="index"
                  class="border-t border-ink/15 odd:bg-surface/40"
                >
                  <td v-for="(cell, cellIndex) in row" :key="cellIndex" class="truncate px-2 py-0.5">
                    {{ cell === '' ? '—' : cell }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul v-if="globals.length > 0" class="space-y-1 text-[11px] text-forge-red">
            <li v-for="issue in globals" :key="issue" class="flex items-start gap-1">
              <AlertTriangle class="mt-0.5 h-3 w-3 shrink-0" />
              {{ issue }}
            </li>
          </ul>
        </div>

        <p v-else class="text-[11px] text-muted">
          {{ t('import.hint') }}
        </p>

        <div v-if="editor.importing" class="space-y-1">
          <p class="flex items-center gap-1 text-[11px] text-muted">
            <Loader2 class="h-3 w-3 animate-spin" />
            {{ t('import.read', { count: editor.importProgress?.processed ?? 0 }) }} ·
            {{ t('import.inserted', { count: editor.importProgress?.inserted ?? 0 }) }} ·
            {{ t('import.failed', { count: editor.importProgress?.failed ?? 0 }) }}
          </p>
          <div class="h-2 overflow-hidden rounded border-2 border-ink bg-surface">
            <div class="h-full w-1/3 animate-pulse bg-forge-purple" />
          </div>
        </div>

        <ul v-if="editor.importErrors.length > 0" class="max-h-40 space-y-1 overflow-auto text-[11px] text-forge-red">
          <li v-for="issue in editor.importErrors.slice(0, 20)" :key="`${issue.row}-${issue.message}`">
            {{ t('import.rowError', { row: issue.row, message: issue.message }) }}
          </li>
        </ul>

        <p v-if="editor.importResult && !editor.importing" class="text-[11px] text-muted">
          <Check v-if="!editor.importResult.cancelled" class="mr-1 inline h-3 w-3 text-forge-mint" />
          {{ t('import.summary', {
            imported: editor.importResult.imported,
            failed: editor.importResult.failed,
            ms: editor.importResult.durationMs,
          }) }}
        </p>
      </div>

      <footer class="flex items-center gap-2 border-t-2 border-ink bg-surface px-3 py-2">
        <button
          v-if="editor.importing"
          class="df-btn df-btn-danger"
          type="button"
          @click="cancel"
        >
          {{ t('import.cancel') }}
        </button>
        <button class="df-btn df-btn-ghost ml-auto" type="button" :disabled="editor.importing" @click="close">
          {{ t('common.close') }}
        </button>
        <button
          class="df-btn df-btn-primary"
          type="button"
          :disabled="!editor.importPreview || editor.importing"
          @click="submit"
        >
          <Loader2 v-if="editor.importing" class="h-3.5 w-3.5 animate-spin" />
          <Upload v-else class="h-3.5 w-3.5" />
          {{ t('import.rows') }}
        </button>
      </footer>
    </section>
  </div>
</template>
