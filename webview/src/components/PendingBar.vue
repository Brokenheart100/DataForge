<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download, Plus, RotateCcw, Trash2, Upload } from 'lucide-vue-next'

import ImportDialog from './ImportDialog.vue'
import { useDataEditorStore } from '../stores/data-editor'
import { useWorkbenchStore } from '../stores/workbench'
import { t } from '@/lib/i18n'

const editor = useDataEditorStore()
const ui = useWorkbenchStore()

const confirmingCommit = ref(false)
const confirmingDelete = ref(false)

const counts = computed(() => editor.pendingCounts)
const summary = computed(() => {
  const parts: string[] = []
  if (counts.value.inserted > 0) parts.push(t('pending.inserted', { count: counts.value.inserted }))
  if (counts.value.updated > 0) parts.push(t('pending.updated', { count: counts.value.updated }))
  if (counts.value.deleted > 0) parts.push(t('pending.deleted', { count: counts.value.deleted }))
  return parts.join(' · ')
})
const canDelete = computed(() => editor.editable && editor.selectedRowIds.length > 0)

function addRow(): void {
  editor.addRow()
}

function discard(): void {
  editor.discardAll()
  ui.pushToast('info', t('pending.discarded'))
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
      t('pending.saved', {
        inserted: result.inserted,
        updated: result.updated,
        deleted: result.deleted,
        name: editor.qualifiedName,
      }),
    )
  } catch (cause) {
    const message =
      editor.conflictKeys.length > 0
        ? t('pending.conflict', { keys: editor.conflictKeys.join(', ') })
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
      ui.pushToast('info', t('pending.exportCancelled'))
      return
    }
    ui.pushToast('info', t('pending.exported', { count: result.rowCount ?? 0, path: result.path ?? '' }))
  } catch (cause) {
    ui.pushToast('error', cause instanceof Error ? cause.message : String(cause))
  }
}

async function cancelExport(): Promise<void> {
  await editor.cancelExport()
  ui.pushToast('info', t('pending.cancellingExport'))
}

async function cancelCommit(): Promise<void> {
  await editor.cancelCommit()
  ui.pushToast('info', t('pending.cancellingCommit'))
}
</script>

<template>
  <section class="df-panel flex flex-wrap items-center gap-3 px-3 py-2">
    <p v-if="editor.readOnlyReason" class="df-readonly-note" role="status">
      {{ t('pending.readOnly', { reason: editor.readOnlyReason }) }}
    </p>

    <span class="df-label mb-0">{{ t('pending.title') }}</span>
    <span v-if="editor.hasPending" class="df-chip bg-forge-yellow">{{ summary }}</span>
    <span v-else class="df-chip bg-surface">{{ t('pending.none') }}</span>

    <span class="flex-1" />

    <button class="df-btn df-btn-ghost" :disabled="!editor.editable" @click="addRow">
      <Plus :size="13" /> {{ t('pending.newRow') }}
    </button>
    <button class="df-btn df-btn-ghost" :disabled="!canDelete" @click="requestDelete">
      <Trash2 :size="13" /> {{ t('pending.delete') }}
    </button>
    <button class="df-btn df-btn-ghost" :disabled="!editor.hasPending" @click="discard">
      <RotateCcw :size="13" /> {{ t('pending.rollback') }}
    </button>
    <button
      class="df-btn df-btn-ghost"
      :disabled="!editor.isOpen || editor.exporting || ui.capabilities?.exportCsv === false"
      :title="t('pending.exportTitle', { name: editor.qualifiedName })"
      @click="exportCsv"
    >
      <Download :size="13" /> {{ editor.exporting ? t('pending.exporting') : t('pending.export') }}
    </button>
    <button
      v-if="editor.exporting"
      class="df-btn df-btn-danger"
      :title="t('pending.cancelExportHint')"
      @click="cancelExport"
    >
      {{ t('pending.cancelExport') }}
    </button>
    <button
      class="df-btn df-btn-ghost"
      :disabled="!editor.editable || editor.importing || ui.capabilities?.dataEditing === false"
      :title="t('pending.importTitle')"
      @click="editor.openImport()"
    >
      <Upload :size="13" /> {{ t('pending.import') }}
    </button>
    <button
      class="df-btn df-btn-primary"
      :disabled="!editor.editable || !editor.hasPending || editor.saving"
      @click="confirmingCommit = true"
    >
      <Upload :size="13" /> {{ editor.saving ? t('pending.saving') : t('pending.commit') }}
    </button>
    <button v-if="editor.saving" class="df-btn df-btn-danger" :title="t('pending.cancelCommitHint')" @click="cancelCommit">
      {{ t('pending.cancelCommit') }}
    </button>

    <div v-if="confirmingCommit" class="mt-2 basis-full rounded-none border-2 border-ink bg-surface p-3 text-sm">
      <p class="font-bold">{{ t('pending.commitQuestion', { count: editor.changes.length, name: editor.qualifiedName }) }}</p>
      <p class="text-muted">{{ t('pending.commitHint') }}</p>
      <div class="mt-2 flex justify-end gap-2">
        <button class="df-btn df-btn-ghost" @click="confirmingCommit = false">{{ t('common.cancel') }}</button>
        <button class="df-btn df-btn-primary" @click="confirmCommit">{{ t('pending.commitChanges') }}</button>
      </div>
    </div>

    <div v-if="confirmingDelete" class="mt-2 basis-full rounded-none border-2 border-ink bg-surface p-3 text-sm">
      <p class="font-bold">{{ t('pending.deleteQuestion', { count: editor.selectedRowIds.length, name: editor.qualifiedName }) }}</p>
      <p class="text-muted">{{ t('pending.deleteHint') }}</p>
      <div class="mt-2 flex justify-end gap-2">
        <button class="df-btn df-btn-ghost" @click="confirmingDelete = false">{{ t('common.cancel') }}</button>
        <button class="df-btn df-btn-danger" @click="confirmDelete">{{ t('pending.markForDeletion') }}</button>
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
