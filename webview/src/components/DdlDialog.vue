<script setup lang="ts">
import { computed } from 'vue'
import { AlertTriangle, Copy, ExternalLink, Loader2, Plus, Trash2, Wrench, X } from 'lucide-vue-next'

import type { DdlRisk } from '@shared/protocol'

import { DDL_MODES, useDdlStore } from '@/stores/ddl'
import { useDataEditorStore } from '@/stores/data-editor'
import { useWorkbenchStore } from '@/stores/workbench'
import { t } from '@/lib/i18n'

const ddl = useDdlStore()
const editor = useDataEditorStore()
const workbench = useWorkbenchStore()

const COLUMN_TYPES = [
  'integer',
  'bigint',
  'text',
  'varchar(255)',
  'boolean',
  'numeric(12,2)',
  'timestamptz',
  'date',
  'uuid',
  'jsonb',
]

const busy = computed(() => ddl.previewing || ddl.applying)

function riskLabel(risk: DdlRisk): string {
  return t(risk === 'safe' ? 'ddl.risk.safe' : risk === 'caution' ? 'ddl.risk.caution' : 'ddl.risk.dangerous')
}

function riskClass(risk: DdlRisk): string {
  if (risk === 'safe') return 'bg-forge-mint text-ink'
  if (risk === 'caution') return 'bg-forge-yellow text-ink'
  return 'bg-forge-red text-paper'
}

function close(): void {
  ddl.close()
}

function modeLabel(mode: string): string {
  if (mode === 'add column') return t('ddl.mode.addColumn')
  if (mode === 'create index') return t('ddl.mode.createIndex')
  if (mode === 'alter column') return t('ddl.mode.alterColumn')
  if (mode === 'drop table') return t('ddl.mode.dropTable')
  return t('ddl.mode.createTable')
}

async function preview(): Promise<void> {
  await ddl.previewPlan()
  if (ddl.error) workbench.pushToast('error', ddl.error)
}

async function copySql(): Promise<void> {
  try {
    await navigator.clipboard.writeText(ddl.previewSql())
    workbench.pushToast('info', t('ddl.copied'))
  } catch {
    workbench.pushToast('error', t('ddl.copyError'))
  }
}

async function openInEditor(): Promise<void> {
  await ddl.openInEditor()
  if (ddl.error) workbench.pushToast('error', ddl.error)
}

async function apply(): Promise<void> {
  const target = { schema: ddl.schema, table: ddl.table, kind: ddl.mode }
  const result = await ddl.apply()
  if (!result) {
    if (ddl.error) workbench.pushToast('error', ddl.error)
    return
  }
  workbench.pushToast('info', t('ddl.applied', { count: result.statements, ms: result.durationMs }))
  const touchesOpenRelation =
    target.kind === 'add column' || target.kind === 'create index' || target.kind === 'alter column'
  if (touchesOpenRelation && target.schema === editor.schema && target.table === editor.relation) {
    void editor.load()
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6" role="dialog" aria-modal="true">
    <section class="df-panel flex max-h-full w-full max-w-4xl flex-col overflow-hidden bg-paper">
      <header class="flex items-center gap-2 border-b-2 border-ink bg-ink px-3 py-2 text-paper">
        <Wrench class="h-4 w-4" aria-hidden="true" />
        <h2 class="text-sm font-black uppercase tracking-wide">{{ t('ddl.title') }}</h2>
        <span v-if="ddl.schema" class="df-chip bg-surface text-ink">{{ ddl.schema }}</span>
        <button class="df-btn df-btn-ghost ml-auto !px-2 !py-1" type="button" :title="t('common.close')" @click="close">
          <X class="h-3.5 w-3.5" />
        </button>
      </header>

      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <div class="flex flex-wrap gap-1">
          <button
            v-for="entry in DDL_MODES"
            :key="entry.value"
            class="df-btn"
            :class="ddl.mode === entry.value ? 'df-btn-primary' : 'df-btn-ghost'"
            type="button"
            :disabled="busy"
            @click="ddl.chooseMode(entry.value)"
          >
            {{ modeLabel(entry.value) }}
          </button>
        </div>

        <div class="flex flex-wrap items-end gap-2">
          <label class="grid gap-1 text-[11px]">
            <span class="df-label">{{ t('ddl.schema') }}</span>
            <input v-model="ddl.schema" class="df-input !w-36" :disabled="busy" />
          </label>
          <label class="grid gap-1 text-[11px]">
            <span class="df-label">{{ t('ddl.table') }}</span>
            <input
              v-model="ddl.table"
              class="df-input !w-48"
              :disabled="busy"
              :placeholder="ddl.mode === 'create table' ? t('ddl.newTable') : ddl.baseTable"
            />
          </label>
          <label
            v-if="ddl.mode === 'create table' || ddl.mode === 'add column' || ddl.mode === 'create index'"
            class="flex items-center gap-1 pb-1.5 text-[11px]"
          >
            <input v-model="ddl.ifNotExists" type="checkbox" :disabled="busy" />
            {{ t('ddl.ifNotExists') }}
          </label>
          <label v-else-if="ddl.mode === 'drop table'" class="flex items-center gap-1 pb-1.5 text-[11px]">
            <input v-model="ddl.ifExists" type="checkbox" :disabled="busy" />
            {{ t('ddl.ifExists') }}
          </label>
        </div>

        <div v-if="ddl.mode === 'create table'" class="space-y-2">
          <div class="overflow-x-auto rounded border-2 border-ink">
            <table class="min-w-full border-collapse text-[11px]">
              <thead>
                <tr class="bg-forge-yellow text-ink">
                  <th class="px-2 py-1 text-left font-bold">{{ t('ddl.name') }}</th>
                  <th class="px-2 py-1 text-left font-bold">{{ t('ddl.type') }}</th>
                  <th class="px-1 py-1 font-bold">{{ t('ddl.nullable') }}</th>
                  <th class="px-1 py-1 font-bold">{{ t('ddl.pk') }}</th>
                  <th class="px-1 py-1 font-bold">{{ t('ddl.unique') }}</th>
                  <th class="px-2 py-1 text-left font-bold">{{ t('ddl.default') }}</th>
                  <th class="px-1 py-1" />
                </tr>
              </thead>
              <tbody>
                <tr v-for="(entry, index) in ddl.columns" :key="index" class="border-t border-ink/20">
                  <td class="px-1 py-1">
                    <input v-model="entry.name" class="df-input !w-36 !py-0.5" :disabled="busy" placeholder="name" />
                  </td>
                  <td class="px-1 py-1">
                    <input
                      v-model="entry.dataType"
                      list="ddl-column-types"
                      class="df-input !w-40 !py-0.5"
                      :disabled="busy"
                    />
                  </td>
                  <td class="px-1 py-1 text-center">
                    <input
                      v-model="entry.nullable"
                      type="checkbox"
                      :disabled="busy || entry.primaryKey"
                      :aria-label="t('ddl.nullable')"
                    />
                  </td>
                  <td class="px-1 py-1 text-center">
                    <input
                      v-model="entry.primaryKey"
                      type="checkbox"
                      :disabled="busy"
                      :aria-label="t('ddl.pk')"
                      @change="entry.primaryKey ? (entry.nullable = false) : undefined"
                    />
                  </td>
                  <td class="px-1 py-1 text-center">
                    <input v-model="entry.unique" type="checkbox" :disabled="busy" :aria-label="t('ddl.unique')" />
                  </td>
                  <td class="px-1 py-1">
                    <input
                      v-model="entry.defaultValue"
                      class="df-input !w-40 !py-0.5"
                      :disabled="busy"
                      :placeholder="t('ddl.defaultPlaceholder')"
                    />
                  </td>
                  <td class="px-1 py-1 text-center">
                    <button
                      class="df-btn df-btn-ghost !px-1 !py-0.5"
                      type="button"
                      :title="t('ddl.removeColumn')"
                      :disabled="busy || ddl.columns.length === 1"
                      @click="ddl.removeColumnRow(index)"
                    >
                      <Trash2 class="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <button class="df-btn df-btn-ghost text-[11px]" type="button" :disabled="busy" @click="ddl.addColumnRow()">
            <Plus class="h-3 w-3" />
            {{ t('ddl.addColumn') }}
          </button>
        </div>

        <div v-else-if="ddl.mode === 'add column'" class="grid max-w-2xl gap-2 text-[11px] sm:grid-cols-2">
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.columnName') }}</span>
            <input v-model="ddl.column.name" class="df-input" :disabled="busy" :placeholder="t('ddl.columnNamePlaceholder')" />
          </label>
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.type') }}</span>
            <input v-model="ddl.column.dataType" list="ddl-column-types" class="df-input" :disabled="busy" />
          </label>
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.default') }}</span>
            <input
              v-model="ddl.column.defaultValue"
              class="df-input"
              :disabled="busy"
              :placeholder="t('ddl.defaultEmpty')"
            />
          </label>
          <div class="flex items-end gap-3 pb-1.5">
            <label class="flex items-center gap-1">
              <input v-model="ddl.column.nullable" type="checkbox" :disabled="busy" />
              {{ t('ddl.nullable') }}
            </label>
            <label class="flex items-center gap-1">
              <input v-model="ddl.column.unique" type="checkbox" :disabled="busy" />
              {{ t('ddl.unique') }}
            </label>
          </div>
        </div>

        <div v-else-if="ddl.mode === 'create index'" class="grid max-w-2xl gap-2 text-[11px] sm:grid-cols-2">
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.indexName') }}</span>
            <input v-model="ddl.indexName" class="df-input" :disabled="busy" :placeholder="t('ddl.indexGenerated')" />
          </label>
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.columnsComma') }}</span>
            <input v-model="ddl.indexColumns" class="df-input" :disabled="busy" :placeholder="t('ddl.columnsPlaceholder')" />
          </label>
          <label class="flex items-center gap-1 pb-1.5">
            <input v-model="ddl.indexUnique" type="checkbox" :disabled="busy" />
            {{ t('ddl.uniqueIndex') }}
          </label>
        </div>

        <div v-else-if="ddl.mode === 'alter column'" class="grid max-w-2xl gap-2 text-[11px] sm:grid-cols-2">
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.alterColumn') }}</span>
            <input v-model="ddl.alter.name" class="df-input" :disabled="busy" :placeholder="t('ddl.alterPlaceholder')" />
          </label>
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.newType') }}</span>
            <input
              v-model="ddl.alter.dataType"
              list="ddl-column-types"
              class="df-input"
              :disabled="busy"
              :placeholder="t('ddl.keepType')"
            />
          </label>
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.nullability') }}</span>
            <select v-model="ddl.alter.nullableMode" class="df-input" :disabled="busy">
              <option value="keep">{{ t('ddl.keepCurrent') }}</option>
              <option value="not null">{{ t('ddl.setNotNull') }}</option>
              <option value="nullable">{{ t('ddl.dropNotNull') }}</option>
            </select>
          </label>
          <label class="grid gap-1">
            <span class="df-label">{{ t('ddl.defaultMode') }}</span>
            <select v-model="ddl.alter.defaultMode" class="df-input" :disabled="busy">
              <option value="keep">{{ t('ddl.keepCurrent') }}</option>
              <option value="set">{{ t('ddl.setDefault') }}</option>
              <option value="drop">{{ t('ddl.dropDefault') }}</option>
            </select>
          </label>
          <label v-if="ddl.alter.defaultMode === 'set'" class="grid gap-1">
            <span class="df-label">{{ t('ddl.defaultValue') }}</span>
            <input
              v-model="ddl.alter.defaultValue"
              class="df-input"
              :disabled="busy"
              :placeholder="t('ddl.defaultValuePlaceholder')"
            />
          </label>
        </div>

        <div v-else class="rounded border-2 border-forge-red bg-forge-red/10 p-2 text-[11px]">
          <p class="flex items-center gap-1 font-bold text-forge-red">
            <AlertTriangle class="h-3.5 w-3.5" />
            {{ t('ddl.dropWarning') }}
          </p>
          <p class="mt-1 text-muted">{{ t('ddl.dropHint') }}</p>
        </div>

        <datalist id="ddl-column-types">
          <option v-for="type in COLUMN_TYPES" :key="type" :value="type" />
        </datalist>

        <p v-if="ddl.error" class="rounded border-2 border-forge-red bg-forge-red/10 p-2 text-[11px] text-forge-red">
          {{ ddl.error }}
        </p>

        <div class="flex items-center gap-2">
          <button class="df-btn df-btn-primary text-[11px]" type="button" :disabled="busy" @click="preview">
            <Loader2 v-if="ddl.previewing" class="h-3.5 w-3.5 animate-spin" />
            <Wrench v-else class="h-3.5 w-3.5" />
            {{ t('ddl.preview') }}
          </button>
        </div>

        <div v-if="ddl.preview" class="space-y-2">
          <div class="space-y-2">
            <div v-for="(statement, index) in ddl.preview.statements" :key="index" class="space-y-1">
              <div class="flex items-center gap-2">
                <span class="df-chip" :class="riskClass(statement.risk)">{{ riskLabel(statement.risk) }}</span>
                <span class="text-[11px] text-muted">{{ t('ddl.statement', { n: index + 1 }) }}</span>
              </div>
              <pre
                class="overflow-auto rounded border-2 border-ink bg-ink p-2 font-mono text-[11px] leading-relaxed text-paper"
                >{{ statement.sql }}</pre
              >
              <p v-if="statement.note" class="text-[11px] text-muted">{{ statement.note }}</p>
            </div>
          </div>

          <ul v-if="ddl.preview.warnings.length > 0" class="space-y-1 rounded border-2 border-forge-yellow bg-forge-yellow/15 p-2 text-[11px]">
            <li v-for="warning in ddl.preview.warnings" :key="warning" class="flex items-start gap-1">
              <AlertTriangle class="mt-0.5 h-3 w-3 shrink-0" />
              {{ warning }}
            </li>
          </ul>

          <label v-if="ddl.risky" class="grid gap-1 text-[11px]">
            <span class="df-label">
              {{ t('ddl.confirmPrefix') }}
              <code class="df-code">{{ ddl.preview.expectedConfirmation }}</code>
              {{ t('ddl.confirmSuffix') }}
            </span>
            <input
              v-model="ddl.confirmText"
              class="df-input !w-60"
              :disabled="busy"
              :placeholder="ddl.preview.expectedConfirmation ?? 'CONFIRM'"
            />
          </label>

          <div class="flex flex-wrap items-center gap-2">
            <button class="df-btn df-btn-ghost text-[11px]" type="button" :disabled="busy" @click="copySql">
              <Copy class="h-3.5 w-3.5" />
              {{ t('ddl.copySql') }}
            </button>
            <button class="df-btn df-btn-ghost text-[11px]" type="button" :disabled="busy" @click="openInEditor">
              <ExternalLink class="h-3.5 w-3.5" />
              {{ t('ddl.openInEditor') }}
            </button>
            <button
              class="df-btn text-[11px]"
              :class="ddl.risky ? 'df-btn-danger' : 'df-btn-primary'"
              type="button"
              :disabled="!ddl.canApply"
              @click="apply"
            >
              <Loader2 v-if="ddl.applying" class="h-3.5 w-3.5 animate-spin" />
              {{ t('ddl.apply') }}
            </button>
          </div>
        </div>
      </div>

      <footer class="flex items-center gap-2 border-t-2 border-ink bg-surface px-3 py-2">
        <span class="text-[11px] text-muted">
          {{ t('ddl.footer') }}
        </span>
        <button class="df-btn df-btn-ghost ml-auto text-[11px]" type="button" :disabled="ddl.applying" @click="close">
          {{ t('common.close') }}
        </button>
      </footer>
    </section>
  </div>
</template>
