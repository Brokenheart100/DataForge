import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import type {
  BootstrapPayload,
  ConnectionDraft,
  ConnectionSummary,
  ConnectionTestResult,
  ConnectionTestTarget,
  ErrorDto,
  ExplainResultDto,
  QueryResultDto,
  RelationTarget,
} from '@shared/protocol'

import { HostRequestError, host } from '@/lib/host'

export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
}

const byName = (a: ConnectionSummary, b: ConnectionSummary): number => a.name.localeCompare(b.name)

function describeError(error: unknown): ErrorDto {
  if (error instanceof HostRequestError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'internal', message: error.message }
  return { code: 'internal', message: String(error) }
}

export const useWorkbenchStore = defineStore('workbench', () => {
  const connections = ref<ConnectionSummary[]>([])
  const prefs = ref<BootstrapPayload['prefs']>({ maxRows: 500, statementTimeoutMs: 30_000, connectTimeoutMs: 10_000 })
  const activeConnectionId = ref<string | undefined>()
  const sql = ref('select 1 as ok;')
  const result = ref<QueryResultDto>()
  const error = ref<ErrorDto>()
  const running = ref(false)
  const cancelTargetId = ref<string>()
  const testing = ref(false)
  const lastTest = ref<ConnectionTestResult>()
  const toasts = ref<Toast[]>([])
  const initialized = ref(false)
  /** Set by an `editor.prefill` event that carries a relation to edit. */
  const pendingRelation = ref<RelationTarget | null>(null)

  let toastSequence = 0

  const activeConnection = computed(() => connections.value.find((item) => item.id === activeConnectionId.value))
  const connectedCount = computed(() => connections.value.filter((item) => item.state === 'connected').length)

  const transactionConnectionId = ref<string>()
  const transactionOpen = computed(() => transactionConnectionId.value !== undefined)
  const transactionBusy = ref(false)

  function setActiveConnection(id: string): void {
    if (transactionOpen.value && transactionConnectionId.value !== id) {
      pushToast('warn', 'Commit or roll back the open transaction before switching connections.')
      return
    }
    activeConnectionId.value = id
  }

  /** Replaces a summary in place after a state transition. */
  function upsert(summary: ConnectionSummary): void {
    const index = connections.value.findIndex((item) => item.id === summary.id)
    if (index === -1) connections.value = [...connections.value, summary].sort(byName)
    else connections.value = connections.value.map((item) => (item.id === summary.id ? summary : item))
  }

  function pushToast(level: Toast['level'], message: string): void {
    const toast: Toast = { id: ++toastSequence, level, message }
    toasts.value = [...toasts.value, toast]
    setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== toast.id)
    }, 6000)
  }

  async function initialize(): Promise<void> {
    if (initialized.value) return
    const restored = host.restore()
    const payload = await host.ready()
    prefs.value = payload.prefs
    connections.value = [...payload.connections].sort(byName)
    activeConnectionId.value = restored.activeConnectionId ?? connections.value[0]?.id
    if (restored.sql !== undefined) sql.value = restored.sql

    host.onEvent((event) => {
      if (event.type === 'connections.changed') {
        connections.value = [...event.payload].sort(byName)
        if (!connections.value.some((item) => item.id === activeConnectionId.value)) {
          activeConnectionId.value = connections.value[0]?.id
        }
      } else if (event.type === 'editor.prefill') {
        sql.value = event.payload.sql
        if (event.payload.connectionId && connections.value.some((item) => item.id === event.payload.connectionId)) {
          activeConnectionId.value = event.payload.connectionId
        }
        if (event.payload.target) {
          pendingRelation.value = event.payload.target
          pushToast('info', `Opened ${event.payload.target.schema}.${event.payload.target.relation}.`)
        } else {
          pushToast('info', 'Loaded the selected relation into the editor.')
        }
      } else {
        pushToast(event.payload.level, event.payload.message)
      }
    })

    watch(
      [activeConnectionId, sql],
      () => host.persist({ activeConnectionId: activeConnectionId.value, sql: sql.value }),
      { flush: 'post' },
    )
    initialized.value = true
  }

  async function refresh(): Promise<void> {
    try {
      connections.value = [...(await host.request('connection.list', null))].sort(byName)
    } catch (caught) {
      const dto = describeError(caught)
      error.value = dto
      pushToast('error', dto.message)
    }
  }

  async function createConnection(draft: ConnectionDraft): Promise<ConnectionSummary> {
    const summary = await host.request('connection.create', draft)
    upsert(summary)
    activeConnectionId.value = summary.id
    pushToast('info', `Saved connection "${summary.name}"`)
    return summary
  }

  async function updateConnection(id: string, patch: Partial<ConnectionDraft>): Promise<ConnectionSummary> {
    const summary = await host.request('connection.update', { id, ...patch })
    upsert(summary)
    pushToast('info', `Updated connection "${summary.name}"`)
    return summary
  }

  async function deleteConnection(id: string): Promise<void> {
    await host.request('connection.delete', { id })
    connections.value = connections.value.filter((item) => item.id !== id)
    if (activeConnectionId.value === id) activeConnectionId.value = connections.value[0]?.id
    pushToast('info', 'Connection deleted')
  }

  async function testConnection(target: ConnectionTestTarget): Promise<ConnectionTestResult> {
    testing.value = true
    try {
      const result = await host.request('connection.test', target)
      lastTest.value = result
      return result
    } finally {
      testing.value = false
    }
  }

  async function connect(id: string): Promise<void> {
    const summary = await host.request('connection.connect', { id })
    upsert(summary)
    pushToast('info', `Connected to ${summary.name}`)
  }

  async function disconnect(id: string): Promise<void> {
    const summary = await host.request('connection.disconnect', { id })
    if (transactionConnectionId.value === id) transactionConnectionId.value = undefined
    upsert(summary)
  }

  async function beginTransaction(): Promise<void> {
    const connectionId = activeConnectionId.value
    if (!connectionId) {
      pushToast('warn', 'Select a connection before starting a transaction.')
      return
    }
    if (activeConnection.value?.state !== 'connected') {
      pushToast('warn', 'Connect to the database before starting a transaction.')
      return
    }
    transactionBusy.value = true
    try {
      await host.request('transaction.begin', { connectionId })
      transactionConnectionId.value = connectionId
      pushToast('info', 'Transaction started. Nothing is saved until you commit.')
    } catch (caught) {
      const dto = describeError(caught)
      error.value = dto
      pushToast('error', dto.message)
    } finally {
      transactionBusy.value = false
    }
  }

  async function finishTransaction(kind: 'commit' | 'rollback'): Promise<void> {
    const connectionId = transactionConnectionId.value
    if (!connectionId) return
    transactionBusy.value = true
    try {
      await host.request(kind === 'commit' ? 'transaction.commit' : 'transaction.rollback', { connectionId })
      transactionConnectionId.value = undefined
      pushToast('info', kind === 'commit' ? 'Transaction committed.' : 'Transaction rolled back.')
    } catch (caught) {
      const dto = describeError(caught)
      error.value = dto
      pushToast('error', dto.message)
    } finally {
      transactionBusy.value = false
    }
  }

  async function runQuery(selection?: string): Promise<void> {
    const connectionId = activeConnectionId.value
    if (!connectionId) {
      error.value = { code: 'invalid_request', message: 'Select a connection before running a query.' }
      return
    }
    // Running a selection leaves the buffer untouched; the editor owns the text.
    const statement = selection && selection.trim() ? selection : sql.value
    if (!statement.trim()) {
      error.value = { code: 'invalid_request', message: 'The SQL buffer is empty.' }
      return
    }

    const requestId = crypto.randomUUID()
    running.value = true
    cancelTargetId.value = requestId
    error.value = undefined

    try {
      const inTransaction = transactionConnectionId.value === connectionId
      result.value = await host.request(
        inTransaction ? 'transaction.run' : 'query.execute',
        { connectionId, sql: statement, maxRows: prefs.value.maxRows },
        requestId,
      )
    } catch (caught) {
      const dto = describeError(caught)
      if (dto.code === 'cancelled') {
        pushToast('warn', 'Query cancelled.')
      } else {
        error.value = dto
        pushToast('error', dto.message)
      }
    } finally {
      running.value = false
      cancelTargetId.value = undefined
    }
  }

  async function cancelQuery(): Promise<void> {
    const targetRequestId = cancelTargetId.value
    if (!targetRequestId) return
    try {
      await host.request('query.cancel', { targetRequestId })
    } catch {
      // The query already finished: nothing to cancel.
    }
  }

  const explaining = ref(false)
  const explainResult = ref<ExplainResultDto>()

  async function explainSql(selection?: string): Promise<void> {
    const connectionId = activeConnectionId.value
    if (!connectionId) {
      error.value = { code: 'invalid_request', message: 'Select a connection before explaining a query.' }
      return
    }
    const statement = selection && selection.trim() ? selection : sql.value
    if (!statement.trim()) {
      error.value = { code: 'invalid_request', message: 'The SQL buffer is empty.' }
      return
    }
    explaining.value = true
    error.value = undefined
    try {
      explainResult.value = await host.request('query.explain', { connectionId, sql: statement }, crypto.randomUUID())
    } catch (caught) {
      const dto = describeError(caught)
      error.value = dto
      pushToast('error', dto.message)
    } finally {
      explaining.value = false
    }
  }

  function clearResult(): void {
    result.value = undefined
    explainResult.value = undefined
    error.value = undefined
  }

  function clearPendingRelation(): void {
    pendingRelation.value = null
  }

  return {
    connections,
    prefs,
    activeConnectionId,
    activeConnection,
    connectedCount,
    sql,
    result,
    error,
    running,
    explaining,
    explainResult,
    transactionOpen,
    transactionBusy,
    transactionConnectionId,
    beginTransaction,
    commitTransaction: () => finishTransaction('commit'),
    rollbackTransaction: () => finishTransaction('rollback'),
    testing,
    lastTest,
    toasts,
    pendingRelation,
    initialize,
    refresh,
    setActiveConnection,
    createConnection,
    updateConnection,
    deleteConnection,
    testConnection,
    connect,
    disconnect,
    runQuery,
    explainSql,
    cancelQuery,
    clearResult,
    clearPendingRelation,
    pushToast,
  }
})
