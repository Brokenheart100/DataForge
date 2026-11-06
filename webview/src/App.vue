<script setup lang="ts">
import { AlertTriangle, Database, Gauge, Loader2, Plug, Play, Plus, RefreshCw, Square, Table2, Unplug, Zap } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { ConnectionSummary } from '@shared/protocol'

import ConnectionDialog from '@/components/ConnectionDialog.vue'
import DataGrid from '@/components/DataGrid.vue'
import PendingBar from '@/components/PendingBar.vue'
import ResultTable from '@/components/ResultTable.vue'
import { useDataEditorStore } from '@/stores/data-editor'
import { useWorkbenchStore } from '@/stores/workbench'

const store = useWorkbenchStore()
const dataEditor = useDataEditorStore()

const dialogOpen = ref(false)
const editing = ref<ConnectionSummary>()
const pendingDelete = ref<string>()
const editor = ref<HTMLTextAreaElement>()
const view = ref<'sql' | 'data'>('sql')

watch(
  () => store.pendingRelation,
  (target) => {
    if (!target) return
    view.value = 'data'
    void dataEditor.open(target.connectionId, target.schema, target.relation)
    store.clearPendingRelation()
  },
)

const stateLabel = computed(() => {
  const active = store.activeConnection
  if (!active) return 'No connection selected'
  return `${active.name} · ${active.database}@${active.host}:${active.port}`
})

onMounted(() => {
  void store.initialize()
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})

function onGlobalKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    void runQuery()
  }
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
        <span class="text-[11px] font-semibold">{{ store.connectedCount }} connected</span>
        <button class="df-btn px-2 py-1" type="button" title="Refresh connections" @click="store.refresh()">
          <RefreshCw :size="12" />
          Refresh
        </button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1">
      <aside class="flex w-64 shrink-0 flex-col border-r-2 border-ink bg-paper">
        <div class="flex items-center justify-between gap-2 border-b-2 border-ink px-3 py-2">
          <h2 class="text-[11px] font-black uppercase tracking-widest text-muted">Connections</h2>
          <button class="df-btn df-btn-primary px-2 py-1" type="button" title="New connection" @click="openNew">
            <Plus :size="12" />
            New
          </button>
        </div>

        <div class="flex-1 space-y-2 overflow-y-auto p-2">
          <p v-if="store.connections.length === 0"
            class="border-2 border-dashed border-ink/40 p-3 text-[11px] text-muted">
            No connections yet. Create one to start exploring a PostgreSQL database.
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
              <span class="df-chip" :class="stateChip(connection)">{{ connection.state }}</span>
              <span v-if="connection.readOnly" class="df-chip border-forge-purple">read-only</span>
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
                {{ connection.state === 'connected' ? 'Disconnect' : 'Connect' }}
              </button>
              <button class="df-btn df-btn-ghost px-1.5 py-0.5 text-[10px]" type="button" @click="openEdit(connection)">
                Edit
              </button>

              <template v-if="pendingDelete === connection.id">
                <button class="df-btn df-btn-danger px-1.5 py-0.5 text-[10px]" type="button"
                  @click="removeConnection(connection)">
                  Confirm delete
                </button>
                <button class="df-btn df-btn-ghost px-1.5 py-0.5 text-[10px]" type="button"
                  @click="pendingDelete = undefined">
                  Keep
                </button>
              </template>
              <button v-else class="df-btn df-btn-ghost ml-auto px-1.5 py-0.5 text-[10px]" type="button"
                @click="pendingDelete = connection.id">
                Delete
              </button>
            </div>
          </article>
        </div>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col bg-paper">
        <div class="flex shrink-0 items-center gap-2 border-b-2 border-ink bg-surface px-2 py-1">
          <button class="df-btn px-2 py-1" :class="view === 'sql' ? 'df-btn-primary' : 'df-btn-ghost'" type="button"
            @click="view = 'sql'">
            SQL
          </button>
          <button class="df-btn px-2 py-1" :class="view === 'data' ? 'df-btn-primary' : 'df-btn-ghost'" type="button"
            @click="view = 'data'">
            <Table2 :size="12" />
            Data
          </button>
          <span v-if="view === 'data'" class="df-code truncate text-[11px] font-bold">
            {{ dataEditor.qualifiedName || 'no relation open' }}
          </span>
          <span class="ml-auto flex items-center gap-1 text-[10px] text-muted">
            <Zap :size="10" />
            {{ stateLabel }}
          </span>
        </div>

        <template v-if="view === 'sql'">
          <div class="flex shrink-0 flex-wrap items-center gap-2 border-b-2 border-ink px-3 py-2">
            <select v-model="store.activeConnectionId" class="df-input max-w-64"
              :disabled="store.running || store.transactionOpen">
              <option :value="undefined" disabled>Select a connection…</option>
              <option v-for="connection in store.connections" :key="connection.id" :value="connection.id">
                {{ connection.name }} ({{ connection.state }})
              </option>
            </select>

            <button class="df-btn df-btn-primary" type="button" :disabled="store.running || !store.activeConnectionId"
              @click="runQuery">
              <Loader2 v-if="store.running" :size="13" class="animate-spin" />
              <Play v-else :size="13" />
              Run
              <kbd class="ml-1 text-[10px] font-normal opacity-70">Ctrl/⌘↵</kbd>
            </button>
            <button v-if="store.running" class="df-btn df-btn-danger" type="button" @click="store.cancelQuery()">
              <Square :size="12" />
              Cancel
            </button>
            <button class="df-btn df-btn-ghost" type="button" :disabled="store.explaining || !store.activeConnectionId"
              @click="runExplain">
              <Loader2 v-if="store.explaining" :size="12" class="animate-spin" />
              <Gauge v-else :size="12" />
              Explain
            </button>

            <button v-if="!store.transactionOpen" class="df-btn df-btn-ghost" type="button"
              :disabled="store.transactionBusy || !store.activeConnectionId" @click="store.beginTransaction()">
              Begin transaction
            </button>
            <template v-else>
              <span class="df-chip border-forge-purple bg-forge-purple text-[#14121a]">in transaction</span>
              <button class="df-btn df-btn-primary" type="button" :disabled="store.transactionBusy"
                @click="store.commitTransaction()">
                Commit
              </button>
              <button class="df-btn df-btn-danger" type="button" :disabled="store.transactionBusy"
                @click="store.rollbackTransaction()">
                Rollback
              </button>
            </template>

            <button class="df-btn df-btn-ghost ml-auto" type="button" @click="store.clearResult()">Clear</button>
            <span class="df-chip">max {{ store.prefs.maxRows }} rows</span>
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
                placeholder="SELECT * FROM public.customers LIMIT 100;" @keydown="onEditorKeydown" />
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
                  EXPLAIN (FORMAT JSON)
                </span>
                <span class="text-[11px] text-muted">{{ store.explainResult.durationMs }} ms</span>
                <button class="df-btn df-btn-ghost ml-auto" type="button" @click="store.clearResult()">Close</button>
              </div>
              <pre class="df-code m-0 max-h-72 overflow-auto p-2 text-[11px]">{{ store.explainResult.plan }}</pre>
            </div>

            <div v-if="store.result" class="df-panel flex min-h-0 flex-1 flex-col overflow-hidden">
              <div class="flex shrink-0 items-center gap-3 border-b-2 border-ink bg-surface px-2 py-1">
                <span class="flex items-center gap-1 text-[11px] font-bold">
                  <Table2 :size="12" />
                  {{ store.result.command }}
                </span>
                <span class="text-[11px] text-muted">{{ store.result.rowCount }} rows</span>
                <span class="text-[11px] text-muted">{{ store.result.durationMs }} ms</span>
                <span v-if="store.result.affectedRows !== null" class="text-[11px] text-muted">
                  {{ store.result.affectedRows }} affected
                </span>
                <span v-if="store.result.truncated"
                  class="df-chip border-forge-pink bg-forge-pink text-[#14121a]">truncated</span>
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
                <p class="text-xs font-bold uppercase tracking-widest text-muted">Results</p>
                <p class="text-[11px] text-muted">Run a statement to see rows here. Results are capped at {{
                  store.prefs.maxRows
                }} rows.</p>
              </div>
            </div>
          </div>
        </template>

        <div v-else class="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <template v-if="dataEditor.isOpen">
            <PendingBar />
            <div v-if="dataEditor.error" class="df-panel flex items-start gap-2 border-forge-red p-2 text-[11px]">
              <AlertTriangle :size="14" class="mt-0.5 shrink-0 text-forge-red" />
              <p class="df-code min-w-0 whitespace-pre-wrap wrap-break-word">{{ dataEditor.error }}</p>
            </div>
            <DataGrid />
          </template>
          <div v-else class="grid flex-1 place-items-center border-2 border-dashed border-ink/30 text-center">
            <div class="max-w-sm space-y-1 p-6">
              <p class="text-xs font-bold uppercase tracking-widest text-muted">Data</p>
              <p class="text-[11px] text-muted">Pick a table or view in the DataForge explorer to browse and edit its
                rows. Views and tables without a primary key open read-only.</p>
            </div>
          </div>
        </div>
      </main>
    </div>

    <footer class="flex shrink-0 items-center gap-3 border-t-2 border-ink bg-surface px-3 py-1 text-[10px] text-muted">
      <span class="truncate">{{ stateLabel }}</span>
      <span class="ml-auto">statement timeout {{ store.prefs.statementTimeoutMs }} ms</span>
      <span v-if="store.running" class="flex items-center gap-1 font-bold text-forge-purple">
        <Loader2 :size="10" class="animate-spin" />
        running
      </span>
    </footer>

    <ConnectionDialog v-model:open="dialogOpen" :connection="editing" />

    <div class="pointer-events-none fixed bottom-3 right-3 z-50 flex w-72 flex-col gap-2">
      <div v-for="toast in store.toasts" :key="toast.id" class="df-panel pointer-events-auto px-2 py-1.5 text-[11px]"
        :class="toast.level === 'error' ? 'border-forge-red' : toast.level === 'warn' ? 'border-forge-yellow' : 'border-forge-mint'">
        {{ toast.message }}
      </div>
    </div>
  </div>
</template>
