<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download, Plus, RotateCcw, Trash2, Upload } from 'lucide-vue-next'

import ImportDialog from './ImportDialog.vue'
import { useDataEditorStore } from '../stores/data-editor'
import { useWorkbenchStore } from '../stores/workbench'

const editor = useDataEditorStore()
const ui = useWorkbenchStore()

const confirmingCommit = ref(false)
const confirmingDelete = ref(false)

const counts = computed(() => editor.pendingCounts)
const summary = computed(() => {
  const parts: string[] = []
  if (counts.value.inserted > 0) parts.push(`${counts.value.inserted} new`)
  if (counts.value.updated > 0) parts.push(`${counts.value.updated} updated`)
  if (counts.value.deleted > 0) parts.push(`${counts.value.deleted} deleted`)
  return parts.join(' · ')
})
const canDelete = computed(() => editor.editable && editor.selectedRowIds.length > 0)

function addRow(): void {
  editor.addRow()
}

function discard(): void {
  editor.discardAll()
  ui.pushToast('info', 'Pending changes discarded.')
}

function requestDelete(): void {
  if (canDelete.value) confirmingDelete.value = true
}

function confirmDelete(): void {
  for (const rowId of editor.selectedRowIds) editor.deleteRow(rowId)
  editor.setSelection([])
  confirmingDelete.value = false
}

async function confirmCommit(): Promise<void> {
  confirmingCommit.value = false
  try {
    const result = await editor.commit()
    ui.pushToast(
      'info',
      `Saved ${result.inserted} insert(s), ${result.updated} update(s) and ${result.deleted} delete(s) on ${editor.qualifiedName}.`,
    )
  } catch (cause) {
    const message =
      editor.conflictKeys.length > 0
        ? `Rows changed elsewhere: ${editor.conflictKeys.join(', ')}. Nothing was saved.`
        : cause instanceof Error
          ? cause.message
          : String(cause)
    ui.pushToast('error', message)
  }
}

async function exportCsv(): Promise<void> {
  try {
    const result = await editor.exportCsv()
    if (!result.saved) {
      ui.pushToast('info', 'Export cancelled.')
      return
    }
    ui.pushToast('info', `Exported ${result.rowCount ?? 0} row(s) to ${result.path ?? 'the selected file'}.`)
  } catch (cause) {
    ui.pushToast('error', cause instanceof Error ? cause.message : String(cause))
  }
}

async function cancelExport(): Promise<void> {
  await editor.cancelExport()
  ui.pushToast('info', 'Cancelling the export…')
}

async function cancelCommit(): Promise<void> {
  await editor.cancelCommit()
  ui.pushToast('info', 'Cancelling the commit…')
}
</script>

<template>
  <section class="df-panel flex flex-wrap items-center gap-3 px-3 py-2">
    <p v-if="editor.readOnlyReason" class="df-readonly-note" role="status">
      Read-only: {{ editor.readOnlyReason }}
    </p>

    <span class="df-label mb-0">Pending</span>
    <span v-if="editor.hasPending" class="df-chip bg-forge-yellow">{{ summary }}</span>
    <span v-else class="df-chip bg-surface">No changes</span>

    <span class="flex-1" />

    <button class="df-btn df-btn-ghost" :disabled="!editor.editable" @click="addRow">
      <Plus :size="13" /> New row
    </button>
    <button class="df-btn df-btn-ghost" :disabled="!canDelete" @click="requestDelete">
      <Trash2 :size="13" /> Delete
    </button>
    <button class="df-btn df-btn-ghost" :disabled="!editor.hasPending" @click="discard">
      <RotateCcw :size="13" /> Rollback
    </button>
    <button
      class="df-btn df-btn-ghost"
      :disabled="!editor.isOpen || editor.exporting || ui.capabilities?.exportCsv === false"
      :title="`Export ${editor.qualifiedName} to a CSV file`"
      @click="exportCsv"
    >
      <Download :size="13" /> {{ editor.exporting ? 'Exporting…' : 'Export CSV' }}
    </button>
    <button
      v-if="editor.exporting"
      class="df-btn df-btn-danger"
      title="Abort the export and delete the partial file"
      @click="cancelExport"
    >
      Cancel export
    </button>
    <button
      class="df-btn df-btn-ghost"
      :disabled="!editor.editable || editor.importing || ui.capabilities?.dataEditing === false"
      title="Import CSV or JSON rows into this relation"
      @click="editor.openImport()"
    >
      <Upload :size="13" /> Import
    </button>
    <button
      class="df-btn df-btn-primary"
      :disabled="!editor.editable || !editor.hasPending || editor.saving"
      @click="confirmingCommit = true"
    >
      <Upload :size="13" /> {{ editor.saving ? 'Saving…' : 'Commit' }}
    </button>
    <button v-if="editor.saving" class="df-btn df-btn-danger" title="Abort the commit and roll back" @click="cancelCommit">
      Cancel commit
    </button>

    <div v-if="confirmingCommit" class="mt-2 basis-full rounded-none border-2 border-ink bg-surface p-3 text-sm">
      <p class="font-bold">Commit {{ editor.changes.length }} change(s) to {{ editor.qualifiedName }}?</p>
      <p class="text-muted">All changes run in one transaction. Rows changed elsewhere abort the whole commit.</p>
      <div class="mt-2 flex justify-end gap-2">
        <button class="df-btn df-btn-ghost" @click="confirmingCommit = false">Cancel</button>
        <button class="df-btn df-btn-primary" @click="confirmCommit">Commit changes</button>
      </div>
    </div>

    <div v-if="confirmingDelete" class="mt-2 basis-full rounded-none border-2 border-ink bg-surface p-3 text-sm">
      <p class="font-bold">Delete {{ editor.selectedRowIds.length }} row(s) from {{ editor.qualifiedName }}?</p>
      <p class="text-muted">Rows are only removed after you commit; nothing is written yet.</p>
      <div class="mt-2 flex justify-end gap-2">
        <button class="df-btn df-btn-ghost" @click="confirmingDelete = false">Cancel</button>
        <button class="df-btn df-btn-danger" @click="confirmDelete">Mark for deletion</button>
      </div>
    </div>
  </section>

  <ImportDialog v-if="editor.importOpen" />
</template>

<style scoped>
.df-readonly-note {
  margin: 0;
  flex-basis: 100%;
  border: 2px solid var(--df-red);
  background: color-mix(in srgb, var(--df-red) 14%, transparent);
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 700;
  color: var(--df-red);
}
</style>
