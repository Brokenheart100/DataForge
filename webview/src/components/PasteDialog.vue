<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ClipboardPaste, X } from 'lucide-vue-next'

import { useDataEditorStore } from '@/stores/data-editor'
import { t } from '@/lib/i18n'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; pasted: [count: number] }>()

const store = useDataEditorStore()
const text = ref('')

const rowCount = computed(() => text.value.split(String.fromCharCode(10)).filter((line) => line.trim().length > 0).length)
const columnNames = computed(() => store.columns.filter((column) => !column.isPrimaryKey).map((column) => column.name))

watch(
  () => props.open,
  (open) => {
    if (open) text.value = ''
  },
)

function close(): void {
  emit('update:open', false)
}

function paste(): void {
  const added = store.appendPastedRows(text.value)
  close()
  emit('pasted', added)
}
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-40 grid place-items-center bg-black/40 p-6" @click.self="close">
    <section class="df-panel df-paste-dialog" role="dialog" aria-modal="true" aria-labelledby="paste-title">
      <header class="df-paste-header">
        <div class="flex items-center gap-2">
          <ClipboardPaste class="h-4 w-4 text-forge-purple" aria-hidden="true" />
          <h2 id="paste-title" class="text-sm font-bold uppercase tracking-wide">{{ t('paste.title') }}</h2>
        </div>
        <button class="df-btn df-btn-ghost h-7 w-7 p-0" type="button" :aria-label="t('common.close')" @click="close">
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <p class="px-3 text-[11px] leading-4 text-muted">
        {{ t('paste.hint', { columns: columnNames.join(', ') || t('paste.noEditableColumns') }) }}
      </p>

      <textarea
        v-model="text"
        class="df-code df-editor df-paste-input"
        spellcheck="false"
        :aria-label="t('paste.ariaRows')"
        :placeholder="t('paste.placeholder')"
      />

      <footer class="df-paste-footer">
        <span class="text-[11px] text-muted">{{ t('paste.rowsDetected', { count: rowCount }) }}</span>
        <span class="flex-1" />
        <button class="df-btn df-btn-ghost" type="button" @click="close">{{ t('common.cancel') }}</button>
        <button class="df-btn df-btn-primary" type="button" :disabled="rowCount === 0 || !store.editable" @click="paste">
          {{ t('paste.addRows', { count: rowCount }) }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.df-paste-dialog {
  width: min(640px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.df-paste-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.df-paste-input {
  min-height: 180px;
  padding: 8px;
  font-size: 12px;
  resize: vertical;
}

.df-paste-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
