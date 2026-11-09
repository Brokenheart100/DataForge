<script setup lang="ts">
import {
  AlertTriangle, Database, Gauge, Languages, Loader2, Monitor, Moon, Plug, Play, Plus, RefreshCw, Square, Sun, Table2, Unplug,
  Users, Zap,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { ConnectionSummary, WorkbenchStateDto } from '@shared/protocol'

import type { WorkbenchConsole } from '@/stores/workbench'

import ConnectionDialog from '@/components/ConnectionDialog.vue'
import DdlPanel from '@/components/DdlPanel.vue'
import DataGrid from '@/components/DataGrid.vue'
import FilterBar from '@/components/FilterBar.vue'
import PendingBar from '@/components/PendingBar.vue'
import PlanTree from '@/components/PlanTree.vue'
import ResultTable from '@/components/ResultTable.vue'
import SessionPanel from '@/components/SessionPanel.vue'
import { host } from '@/lib/host'
import { localeLabel, localeMode, nextLocaleMode, setLocaleMode, t } from '@/lib/i18n'
import { applyTheme, nextTheme, readTheme, saveTheme } from '@/lib/theme'
import { useDataEditorStore } from '@/stores/data-editor'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkbenchStore } from '@/stores/workbench'

const store = useWorkbenchStore()
const dataEditor = useDataEditorStore()
const sessionStore = useSessionsStore()

const dialogOpen = ref(false)
const editing = ref<ConnectionSummary>()
const pendingDelete = ref<string>()
const editor = ref<HTMLTextAreaElement>()
const view = ref<'sql' | 'data'>('sql')
const theme = ref(readTheme())
const themeIcon = computed(() => (theme.value === 'light' ? Sun : theme.value === 'dark' ? Moon : Monitor))
const themeLabel = computed(() =>
  t(theme.value === 'light' ? 'theme.light' : theme.value === 'dark' ? 'theme.dark' : 'theme.auto'),
)
const languageLabel = computed(() => localeLabel(localeMode.value))
const LANGUAGES_ICON = Languages
let saveTimer: ReturnType<typeof setTimeout> | undefined
let stopSessionWatch: (() => void) | undefined

watch(
  () => store.pendingRelation,
  (target) => {
    if (!target) return
    view.value = 'data'
    void dataEditor.open(target.connectionId, target.schema, target.relation, target.database ?? null)
    store.clearPendingRelation()
  },
)

// A restored data page may be waiting for its connection; load it once the
// user reconnects instead of asking them to reopen the relation.
watch(
  () => store.connections.find((item) => item.id === dataEditor.connectionId)?.state,
  (state, previous) => {
    if (state === 'connected' && previous !== 'connected' && view.value === 'data' && dataEditor.isOpen) {
      void dataEditor.load(dataEditor.offset)
    }
  },
)

/** Snapshot that survives a window reload; results and pending edits are omitted. */
function sessionState(): WorkbenchStateDto {
  const state: WorkbenchStateDto = {
    ...(store.activeConnectionId ? { activeConnectionId: store.activeConnectionId } : {}),
    ...(store.activeConsoleId ? { activeConsoleId: store.activeConsoleId } : {}),
    consoles: store.consoles.map((tab) => ({
      key: tab.key,
      title: tab.title,
      sql: tab.sql,
      ...(tab.connectionId ? { connectionId: tab.connectionId } : {}),
    })),
    view: view.value,
  }
  if (view.value === 'data' && dataEditor.isOpen && dataEditor.connectionId && dataEditor.schema && dataEditor.relation) {
    state.relation = {
      connectionId: dataEditor.connectionId,
      ...(dataEditor.database ? { database: dataEditor.database } : {}),
      schema: dataEditor.schema,
      relation: dataEditor.relation,
    }
    state.data = {
      offset: dataEditor.offset,
      orderBy: [...dataEditor.orderBy],
      filters: [...dataEditor.filters],
    }
  }
  return state
}

function flushSession(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  void host.request('workbench.save', sessionState()).catch(() => undefined)
}

function scheduleSessionSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void host.request('workbench.save', sessionState()).catch(() => undefined)
  }, 600)
}

async function initializeWorkbench(): Promise<void> {
  await store.initialize()
  const saved = store.restoredState
  if (
    saved?.view === 'data' &&
    saved.relation &&
    store.connections.some((item) => item.id === saved.relation?.connectionId)
  ) {
    view.value = 'data'
    await dataEditor.restore(saved.relation, saved.data)
  }
  stopSessionWatch = watch(
    [
      () => store.consoles,
      () => store.activeConsoleId,
      () => store.activeConnectionId,
      view,
      () => dataEditor.connectionId,
      () => dataEditor.database,
      () => dataEditor.schema,
      () => dataEditor.relation,
      () => dataEditor.offset,
      () => dataEditor.filters,
      () => dataEditor.orderBy,
    ],
    scheduleSessionSave,
    { deep: true, flush: 'post' },
  )
}

const stateLabel = computed(() => {
  const active = store.activeConnection
  if (!active) return t('app.noConnectionSelected')
  return `${active.name} · ${active.database}@${active.host}:${active.port}`
})

function connectionStateLabel(state: string): string {
  if (state === 'connected') return t('app.stateConnected')
  if (state === 'connecting') return t('app.stateConnecting')
  if (state === 'error') return t('app.stateError')
  if (state === 'disconnected') return t('app.stateDisconnected')
  return state
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('pagehide', flushSession)
  void initializeWorkbench()
})

onBeforeUnmount(() => {
  stopSessionWatch?.()
  flushSession()
  window.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('pagehide', flushSession)
})

function onGlobalKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    void runQuery()
  }
}

function onConnectionChange(event: Event): void {
  store.setActiveConnection((event.target as HTMLSelectElement).value)
}

async function closeConsole(key: string): Promise<void> {
  await store.closeConsole(key)
}

function consoleHint(tab: WorkbenchConsole): string {
  const connection = store.connections.find((item) => item.id === tab.connectionId)
  const state = connection ? connectionStateLabel(connection.state) : t('app.noConnection')
  return `${tab.title} · ${state}`
}

function isStale(tab: WorkbenchConsole): boolean {
  return tab.connectionId !== undefined && store.connections.find((item) => item.id === tab.connectionId)?.state !== 'connected'
}

function openNew(): void {
  editing.value = undefined
  dialogOpen.value = true
}

function openEdit(connection: ConnectionSummary): void {
  editing.value = connection
  dialogOpen.value = true
}

async function runQuery(): Promise<void> {
  const target = editor.value
  const selection = target ? target.value.slice(target.selectionStart, target.selectionEnd) : ''
  await store.runQuery(selection)
}

async function runExplain(): Promise<void> {
  const target = editor.value
  const selection = target ? target.value.slice(target.selectionStart, target.selectionEnd) : ''
  await store.explainSql(selection)
}

function openSessions(): void {
  const connectionId = store.activeConnectionId
  if (!connectionId) return
  sessionStore.show(connectionId, store.scopedDatabase ?? undefined)
}

function cycleTheme(): void {
  theme.value = nextTheme(theme.value)
  applyTheme(theme.value)
  saveTheme(theme.value)
}

function cycleLanguage(): void {
  setLocaleMode(nextLocaleMode(localeMode.value))
}

async function toggleConnection(connection: ConnectionSummary): Promise<void> {
  try {
    if (connection.state === 'connected') await store.disconnect(connection.id)
    else await store.connect(connection.id)
  } catch (error) {
    store.pushToast('error', error instanceof Error ? error.message : String(error))
  }
}

async function removeConnection(connection: ConnectionSummary): Promise<void> {
  pendingDelete.value = undefined
  try {
    await store.deleteConnection(connection.id)
  } catch (error) {
    store.pushToast('error', error instanceof Error ? error.message : String(error))
  }
}

function onEditorKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  event.preventDefault()
  const target = event.target as HTMLTextAreaElement
  const start = target.selectionStart
  store.sql = `${store.sql.slice(0, start)}  ${store.sql.slice(target.selectionEnd)}`
  requestAnimationFrame(() => {
    target.selectionStart = target.selectionEnd = start + 2
  })
}

const stateChip = (connection: ConnectionSummary): string => {
  if (connection.state === 'connected') return 'bg-forge-mint text-[#14121a]'
  if (connection.state === 'error') return 'bg-forge-red text-[#14121a]'
  return 'bg-surface text-muted'
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex shrink-0 items-center gap-3 border-b-2 border-ink bg-forge-yellow px-3 py-1.5 text-[#14121a]">
      <div class="flex items-center gap-2">
        <span class="grid size-7 place-items-center border-2 border-[#14121a] bg-white shadow-[2px_2px_0_0_#14121a]">
          <Database :size="15" :stroke-width="2.4" />
        </span>
        <strong class="text-sm font-black uppercase tracking-widest">DataForge</strong>
      </div>
      <span class="df-chip bg-white text-[#14121a]">PostgreSQL</span>
      <div class="ml-auto flex items-center gap-2">
        <span class="text-[11px] font-semibold">{{ t('app.connectedCount', { count: store.connectedCount }) }}</span>
        <button class="df-btn px-2 py-1" type="button" :title="t('lang.title', { label: languageLabel })"
          :aria-label="t('lang.title', { label: languageLabel })" @click="cycleLanguage">
          <component :is="LANGUAGES_ICON" :size="12" />
          {{ languageLabel }}
        </button>
        <button class="df-btn px-2 py-1" type="button" :title="t('theme.title', { label: themeLabel })"
          :aria-label="t('theme.title', { label: themeLabel })" @click="cycleTheme">
          <component :is="themeIcon" :size="12" />
          {{ themeLabel }}
        </button>
        <button class="df-btn px-2 py-1" type="button" :title="t('app.refreshTitle')" @click="store.refresh()">
          <RefreshCw :size="12" />
          {{ t('common.refresh') }}
        </button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1">
      <aside class="flex w-64 shrink-0 flex-col border-r-2 border-ink bg-paper">
        <div class="flex items-center justify-between gap-2 border-b-2 border-ink px-3 py-2">
          <h2 class="text-[11px] font-black uppercase tracking-widest text-muted">{{ t('app.connections') }}</h2>
          <button class="df-btn df-btn-primary px-2 py-1" type="button" :title="t('app.newConnectionTitle')"
            @click="openNew">
            <Plus :size="12" />
            {{ t('app.new') }}
          </button>
        </div>

        <div class="flex-1 space-y-2 overflow-y-auto p-2">
          <p v-if="store.connections.length === 0"
            class="border-2 border-dashed border-ink/40 p-3 text-[11px] text-muted">
            {{ t('app.emptyConnections') }}
          </p>

          <article v-for="connection in store.connections" :key="connection.id" class="df-panel cursor-pointer p-2"
            :class="connection.id === store.activeConnectionId ? 'border-forge-purple' : ''" tabindex="0" role="button"
            :aria-pressed="connection.id === store.activeConnectionId" @click="store.setActiveConnection(connection.id)"
            @keydown.enter.prevent="store.setActiveConnection(connection.id)"
            @keydown.space.prevent="store.setActiveConnection(connection.id)">
            <p class="truncate text-xs font-bold" :title="connection.name">{{ connection.name }}</p>
            <p class="truncate text-[10px] text-muted">{{ connection.database }}@{{ connection.host }}:{{
              connection.port }}</p>

            <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span class="df-chip" :class="stateChip(connection)">{{ connectionStateLabel(connection.state) }}</span>
              <span v-if="connection.readOnly" class="df-chip border-forge-purple">{{ t('app.readOnly') }}</span>
              <span v-if="connection.ssl === 'require'" class="df-chip border-forge-blue">ssl</span>
              <span v-if="connection.serverVersion" class="truncate text-[10px] text-muted">{{ connection.serverVersion
                }}</span>
            </div>

            <p v-if="connection.lastError" class="mt-1 line-clamp-2 text-[10px] text-forge-red">
              {{ connection.lastError }}
            </p>

            <div class="mt-2 flex items-center gap-1.5" @click.stop>
              <button class="df-btn px-1.5 py-0.5 text-[10px]" type="button" @click="toggleConnection(connection)">
                <component :is="connection.state === 'connected' ? Unplug : Plug" :size="11" />
                {{ connection.state === 'connected' ? t('app.disconnect') : t('app.connect') }}
              </button>
              <button class="df-btn df-btn-ghost px-1.5 py-0.5 text-[10px]" type="button" @click="openEdit(connection)">
                {{ t('app.edit') }}
              </button>

              <template v-if="pendingDelete === connection.id">
                <button class="df-btn df-btn-danger px-1.5 py-0.5 text-[10px]" type="button"
                  @click="removeConnection(connection)">
                  {{ t('app.confirmDelete') }}
                </button>
                <button class="df-btn df-btn-ghost px-1.5 py-0.5 text-[10px]" type="button"
                  @click="pendingDelete = undefined">
                  {{ t('app.keep') }}
                </button>
              </template>
              <button v-else class="df-btn df-btn-ghost ml-auto px-1.5 py-0.5 text-[10px]" type="button"
                @click="pendingDelete = connection.id">
                {{ t('app.delete') }}
              </button>
            </div>
          </article>
        </div>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col bg-paper">
        <div class="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b-2 border-ink bg-surface px-2 pt-1.5">
          <button v-for="tab in store.consoles" :key="tab.key" type="button"
            class="flex shrink-0 items-center gap-1.5 border-2 border-ink px-2 py-1 text-[11px] font-bold"
            :class="tab.key === store.activeConsoleId ? 'bg-forge-yellow text-[#14121a] shadow-brutal-sm' : 'bg-paper text-muted'"
            :title="consoleHint(tab)" @click="store.setActiveConsole(tab.key)">
            <span v-if="tab.running" class="size-2 animate-pulse rounded-full bg-forge-purple" />
            <span v-else-if="tab.transactionOpen" class="size-2 rounded-full bg-forge-mint" />
            <span v-else-if="tab.error" class="size-2 rounded-full bg-forge-red" />
            <span v-else-if="isStale(tab)" class="size-2 rounded-full bg-forge-pink" />
            <span class="max-w-40 truncate">{{ tab.title }}</span>
            <span v-if="tab.transactionOpen"
              class="border border-[#14121a] bg-forge-purple px-1 text-[9px] uppercase tracking-widest text-[#14121a]">tx</span>
            <span
              class="ml-0.5 grid size-4 cursor-pointer place-items-center border border-ink/30 text-[11px] leading-none hover:bg-forge-red hover:text-[#14121a]"
              role="button" tabindex="0" :aria-label="t('app.closeTab', { title: tab.title })"
              @click.stop="closeConsole(tab.key)" @keydown.enter.stop="closeConsole(tab.key)">×</span>
          </button>
          <button class="df-btn df-btn-ghost my-1 shrink-0 px-2 py-0.5" type="button" :title="t('app.newConsoleTitle')"
            @click="store.addConsole()">
            <Plus :size="12" />
            {{ t('app.console') }}
          </button>
        </div>

        <div class="flex shrink-0 items-center gap-2 border-b-2 border-ink bg-surface px-2 py-1">
          <button class="df-btn px-2 py-1" :class="view === 'sql' ? 'df-btn-primary' : 'df-btn-ghost'" type="button"
            @click="view = 'sql'">
            SQL
          </button>
          <button class="df-btn px-2 py-1" :class="view === 'data' ? 'df-btn-primary' : 'df-btn-ghost'" type="button"
            :disabled="store.capabilities?.dataEditing === false" :title="store.capabilities?.dataEditing === false
              ? t('app.dataDisabled')
              : t('app.browseData')" @click="view = 'data'">
            <Table2 :size="12" />
            {{ t('app.dataEmptyTitle') }}
          </button>
          <span v-if="view === 'data'" class="df-code truncate text-[11px] font-bold">
            {{ dataEditor.qualifiedName || t('app.noRelation') }}
          </span>
          <span class="ml-auto flex items-center gap-1 text-[10px] text-muted">
            <Zap :size="10" />
            {{ stateLabel }}
          </span>
        </div>

        <template v-if="view === 'sql'">
          <div class="flex shrink-0 flex-wrap items-center gap-2 border-b-2 border-ink px-3 py-2">
            <select :value="store.activeConnectionId" class="df-input max-w-64"
              :disabled="store.running || store.transactionOpen" @change="onConnectionChange">
              <option :value="undefined" disabled>{{ t('app.selectConnection') }}</option>
              <option v-for="connection in store.connections" :key="connection.id" :value="connection.id">
                {{ connection.name }} ({{ connectionStateLabel(connection.state) }})
              </option>
            </select>

            <button class="df-btn df-btn-primary" type="button" :disabled="store.running || !store.activeConnectionId"
              @click="runQuery">
              <Loader2 v-if="store.running" :size="13" class="animate-spin" />
              <Play v-else :size="13" />
              {{ t('app.run') }}
              <kbd class="ml-1 text-[10px] font-normal opacity-70">Ctrl/⌘↵</kbd>
            </button>
            <button v-if="store.running" class="df-btn df-btn-danger" type="button" @click="store.cancelQuery()">
              <Square :size="12" />
              {{ t('app.cancel') }}
            </button>
            <button class="df-btn df-btn-ghost" type="button" :disabled="store.explaining || !store.activeConnectionId"
              @click="runExplain">
              <Loader2 v-if="store.explaining" :size="12" class="animate-spin" />
              <Gauge v-else :size="12" />
              {{ t('app.explain') }}
            </button>
            <button v-if="store.capabilities?.sessions !== false" class="df-btn df-btn-ghost" type="button"
              :disabled="!store.activeConnectionId" @click="openSessions">
              <Users :size="12" />
              {{ t('app.sessions') }}
            </button>

            <template v-if="store.capabilities?.transactions !== false">
              <button v-if="!store.transactionOpen" class="df-btn df-btn-ghost" type="button"
                :disabled="store.transactionBusy || !store.activeConnectionId" @click="store.beginTransaction()">
                {{ t('app.beginTransaction') }}
              </button>
              <template v-else>
                <span class="df-chip border-forge-purple bg-forge-purple text-[#14121a]">{{ t('app.inTransaction')
                }}</span>
                <button class="df-btn df-btn-primary" type="button" :disabled="store.transactionBusy"
                  @click="store.commitTransaction()">
                  {{ t('app.commit') }}
                </button>
                <button class="df-btn df-btn-danger" type="button" :disabled="store.transactionBusy"
                  @click="store.rollbackTransaction()">
                  {{ t('app.rollback') }}
                </button>
              </template>
            </template>

            <button class="df-btn df-btn-ghost ml-auto" type="button" @click="store.clearResult()">
              {{ t('app.clear') }}
            </button>
            <span class="df-chip">{{ t('app.maxRows', { count: store.prefs.maxRows }) }}</span>
          </div>

          <div class="shrink-0 p-3">
            <div class="df-panel overflow-hidden">
              <div class="flex items-center justify-between border-b-2 border-ink bg-surface px-2 py-1">
                <span class="text-[10px] font-black uppercase tracking-widest text-muted">SQL</span>
                <span class="flex items-center gap-1 text-[10px] text-muted">
                  <Zap :size="10" />
                  {{ stateLabel }}
                </span>
              </div>
              <textarea ref="editor" v-model="store.sql"
                class="df-code df-editor block h-40 w-full resize-y border-0 p-2 outline-none" spellcheck="false"
                :placeholder="t('app.editorPlaceholder')" @keydown="onEditorKeydown" />
            </div>
          </div>

          <div class="flex min-h-0 flex-1 flex-col px-3 pb-3">
            <div v-if="store.error" class="df-panel mb-2 flex items-start gap-2 border-forge-red p-2 text-[11px]">
              <AlertTriangle :size="14" class="mt-0.5 shrink-0 text-forge-red" />
              <div class="min-w-0">
                <p class="font-bold uppercase tracking-wide text-forge-red">{{ store.error.code }}</p>
                <p class="df-code whitespace-pre-wrap wrap-break-word">{{ store.error.message }}</p>
              </div>
            </div>

            <div v-if="store.explainResult" class="df-panel mb-2 flex min-h-0 flex-col overflow-hidden">
              <div class="flex shrink-0 items-center gap-3 border-b-2 border-ink bg-surface px-2 py-1">
                <span class="flex items-center gap-1 text-[11px] font-bold">
                  <Gauge :size="12" />
                  {{ t('app.explainHeader') }}
                </span>
                <span class="text-[11px] text-muted">{{ store.explainResult.durationMs }} ms</span>
                <button class="df-btn df-btn-ghost ml-auto" type="button" @click="store.clearResult()">
                  {{ t('common.close') }}
                </button>
              </div>
              <PlanTree v-if="store.explainResult.root" :node="store.explainResult.root"
                class="max-h-72 overflow-auto p-2" />
              <pre v-else
                class="df-code m-0 max-h-72 overflow-auto p-2 text-[11px]">{{ store.explainResult.plan }}</pre>
            </div>

            <div v-if="store.result" class="df-panel flex min-h-0 flex-1 flex-col overflow-hidden">
              <div class="flex shrink-0 items-center gap-3 border-b-2 border-ink bg-surface px-2 py-1">
                <span class="flex items-center gap-1 text-[11px] font-bold">
                  <Table2 :size="12" />
                  {{ store.result.command }}
                </span>
                <span class="text-[11px] text-muted">{{ t('app.rows', { count: store.result.rowCount }) }}</span>
                <span class="text-[11px] text-muted">{{ store.result.durationMs }} ms</span>
                <span v-if="store.result.affectedRows !== null" class="text-[11px] text-muted">
                  {{ t('app.affected', { count: store.result.affectedRows }) }}
                </span>
                <span v-if="store.result.truncated" class="df-chip border-forge-pink bg-forge-pink text-[#14121a]">{{
                  t('app.truncated') }}</span>
                <span v-for="notice in store.result.notices" :key="notice"
                  class="ml-auto truncate text-[10px] text-muted">
                  {{ notice }}
                </span>
              </div>
              <ResultTable :result="store.result" />
            </div>

            <div v-else-if="!store.error"
              class="grid flex-1 place-items-center border-2 border-dashed border-ink/30 text-center">
              <div class="max-w-sm space-y-1 p-6">
                <p class="text-xs font-bold uppercase tracking-widest text-muted">{{ t('app.results') }}</p>
                <p class="text-[11px] text-muted">{{ t('app.resultsHint', { count: store.prefs.maxRows }) }}</p>
              </div>
            </div>
          </div>
        </template>

        <div v-else class="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <template v-if="dataEditor.isOpen">
            <FilterBar />
            <PendingBar />
            <div v-if="dataEditor.error" class="df-panel flex items-start gap-2 border-forge-red p-2 text-[11px]">
              <AlertTriangle :size="14" class="mt-0.5 shrink-0 text-forge-red" />
              <p class="df-code min-w-0 whitespace-pre-wrap wrap-break-word">{{ dataEditor.error }}</p>
            </div>
            <DataGrid />
          </template>
          <div v-else class="grid flex-1 place-items-center border-2 border-dashed border-ink/30 text-center">
            <div class="max-w-sm space-y-1 p-6">
              <p class="text-xs font-bold uppercase tracking-widest text-muted">{{ t('app.dataEmptyTitle') }}</p>
              <p class="text-[11px] text-muted">{{ t('app.dataEmptyHint') }}</p>
            </div>
          </div>
        </div>
      </main>
    </div>

    <footer class="flex shrink-0 items-center gap-3 border-t-2 border-ink bg-surface px-3 py-1 text-[10px] text-muted">
      <span class="truncate">{{ stateLabel }}</span>
      <span class="ml-auto">{{ t('app.statementTimeout', { ms: store.prefs.statementTimeoutMs }) }}</span>
      <span v-if="store.running" class="flex items-center gap-1 font-bold text-forge-purple">
        <Loader2 :size="10" class="animate-spin" />
        {{ t('app.running') }}
      </span>
    </footer>

    <ConnectionDialog v-model:open="dialogOpen" :connection="editing" />
    <DdlPanel />
    <SessionPanel v-if="sessionStore.open" />

    <div class="pointer-events-none fixed bottom-3 right-3 z-50 flex w-72 flex-col gap-2">
      <div v-for="toast in store.toasts" :key="toast.id" class="df-panel pointer-events-auto px-2 py-1.5 text-[11px]"
        :class="toast.level === 'error' ? 'border-forge-red' : toast.level === 'warn' ? 'border-forge-yellow' : 'border-forge-mint'">
        {{ toast.message }}
      </div>
    </div>
  </div>
</template>
