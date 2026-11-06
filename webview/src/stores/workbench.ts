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

/** One editor tab: text, last result and transaction state stay with it. */
export interface WorkbenchConsole {
  /** Local key, never reused. */
  key: string
  title: string
  connectionId: string | undefined
  /** Host console id, created lazily on the first statement of this tab. */
  hostId: string | undefined
  hostConnectionId: string | undefined
  sql: string
  result: QueryResultDto | undefined
  explain: ExplainResultDto | undefined
  error: ErrorDto | undefined
  running: boolean
  cancelRequestId: string | undefined
  explaining: boolean
  transactionOpen: boolean
  transactionBusy: boolean
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
  const consoles = ref<WorkbenchConsole[]>([])
  const activeConsoleId = ref<string>()
  const testing = ref(false)
  const lastTest = ref<ConnectionTestResult>()
  const toasts = ref<Toast[]>([])
  const initialized = ref(false)
  /** Set by an `editor.prefill` event that carries a relation to edit. */
  const pendingRelation = ref<RelationTarget | null>(null)
  /** Database of a relation opened from another database of the same connection. */
  const scopedDatabase = ref<string | null>(null)

  let toastSequence = 0
  let consoleSequence = 0

  const activeConnection = computed(() => connections.value.find((item) => item.id === activeConnectionId.value))
  const connectedCount = computed(() => connections.value.filter((item) => item.state === 'connected').length)
  const activeConsole = computed(() => consoles.value.find((item) => item.key === activeConsoleId.value))

  // Aliases keep the existing template bindings working while state is per tab.
  const sql = computed({
    get: () => activeConsole.value?.sql ?? '',
    set: (value: string) => {
      const tab = activeConsole.value
      if (tab) tab.sql = value
    },
  })
  const result = computed(() => activeConsole.value?.result)
  const explainResult = computed(() => activeConsole.value?.explain)
  const error = computed(() => activeConsole.value?.error)
  const running = computed(() => activeConsole.value?.running ?? false)
  const explaining = computed(() => activeConsole.value?.explaining ?? false)
  const transactionOpen = computed(() => activeConsole.value?.transactionOpen ?? false)
  const transactionBusy = computed(() => activeConsole.value?.transactionBusy ?? false)

  function makeConsole(connectionId: string | undefined, text = 'select 1 as ok;'): WorkbenchConsole {
    consoleSequence += 1
    return {
      key: crypto.randomUUID(),
      title: `Console ${consoleSequence}`,
      connectionId,
      hostId: undefined,
      hostConnectionId: undefined,
      sql: text,
      result: undefined,
      explain: undefined,
      error: undefined,
      running: false,
      cancelRequestId: undefined,
      explaining: false,
      transactionOpen: false,
      transactionBusy: false,
    }
  }

  function activate(tab: WorkbenchConsole): void {
    activeConsoleId.value = tab.key
    if (tab.connectionId && connections.value.some((item) => item.id === tab.connectionId)) {
      activeConnectionId.value = tab.connectionId
    }
  }

  async function addConsole(): Promise<void> {
    const tab = makeConsole(activeConnectionId.value)
    consoles.value = [...consoles.value, tab]
    activate(tab)
  }

  /** Closing a tab lets the host cancel its statement and roll back its transaction. */
  async function closeConsole(key: string): Promise<void> {
    const tab = consoles.value.find((item) => item.key === key)
    if (!tab) return
    if (tab.running) {
      pushToast('warn', 'Cancelling the running statement before closing the console.')
      if (tab.cancelRequestId) {
        await host.request('query.cancel', { targetRequestId: tab.cancelRequestId }).catch(() => undefined)
      }
    }
    const index = consoles.value.findIndex((item) => item.key === key)
    const remaining = consoles.value.filter((item) => item.key !== key)
    consoles.value = remaining.length > 0 ? remaining : [makeConsole(activeConnectionId.value)]
    if (activeConsoleId.value === key) {
      activeConsoleId.value = consoles.value[Math.min(index, consoles.value.length - 1)]?.key
    }
    if (tab.hostId) {
      const wasInTransaction = tab.transactionOpen
      await host.request('console.close', { consoleId: tab.hostId }).catch((caught: unknown) => {
        pushToast('warn', `Could not close the console cleanly: ${describeError(caught).message}`)
      })
      if (wasInTransaction) pushToast('warn', 'The closed console’s transaction was rolled back.')
    }
  }

  function setActiveConsole(key: string): void {
    const tab = consoles.value.find((item) => item.key === key)
    if (!tab) return
    if (transactionOpen.value && activeConsole.value?.key !== key) {
      pushToast('warn', 'Commit or roll back the open transaction before switching consoles.')
      return
    }
    activate(tab)
  }

  /** Host-side console for this tab, opened lazily and rebound after a connection switch. */
  async function ensureHostConsole(tab: WorkbenchConsole): Promise<string> {
    const connectionId = tab.connectionId ?? activeConnectionId.value
    if (!connectionId) throw new Error('Select a connection first.')
    if (tab.hostId && tab.hostConnectionId === connectionId) return tab.hostId
    if (tab.hostId) {
      const stale = tab.hostId
      tab.hostId = undefined
      void host.request('console.close', { consoleId: stale }).catch(() => undefined)
    }
    const created = await host.request('console.open', { connectionId, title: tab.title })
    tab.hostId = created.id
    tab.hostConnectionId = connectionId
    tab.connectionId = connectionId
    return created.id
  }

  function setActiveConnection(id: string): void {
    if (transactionOpen.value && activeConsole.value?.connectionId !== id) {
      pushToast('warn', 'Commit or roll back the open transaction before switching connections.')
      return
    }
    activeConnectionId.value = id
    scopedDatabase.value = null
    const tab = activeConsole.value
    if (tab && tab.connectionId !== id) {
      tab.connectionId = id
      tab.hostId = undefined
      tab.hostConnectionId = undefined
    }
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
    const first = makeConsole(activeConnectionId.value, restored.sql ?? 'select 1 as ok;')
    consoles.value = [first]
    activeConsoleId.value = first.key

    host.onEvent((event) => {
      if (event.type === 'connections.changed') {
        connections.value = [...event.payload].sort(byName)
        if (!connections.value.some((item) => item.id === activeConnectionId.value)) {
          activeConnectionId.value = connections.value[0]?.id
        }
      } else if (event.type === 'editor.prefill') {
        const tab = activeConsole.value ?? consoles.value[0]
        if (tab) {
          tab.sql = event.payload.sql
          if (event.payload.connectionId && connections.value.some((item) => item.id === event.payload.connectionId)) {
            tab.connectionId = event.payload.connectionId
            tab.hostId = undefined
            tab.hostConnectionId = undefined
            activeConnectionId.value = event.payload.connectionId
            scopedDatabase.value = null
          }
          if (event.payload.target) {
            const own = connections.value.find((item) => item.id === event.payload.target?.connectionId)?.database
            scopedDatabase.value = event.payload.target.database && event.payload.target.database !== own
              ? event.payload.target.database
              : null
            pendingRelation.value = event.payload.target
            pushToast('info', `Opened ${event.payload.target.schema}.${event.payload.target.relation}.`)
          } else {
            pushToast('info', 'Loaded the selected relation into the editor.')
          }
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
      if (activeConsole.value) activeConsole.value.error = dto
      pushToast('error', dto.message)
    }
  }

  async function createConnection(draft: ConnectionDraft): Promise<ConnectionSummary> {
    const summary = await host.request('connection.create', draft)
    upsert(summary)
    activeConnectionId.value = summary.id
    if (activeConsole.value) {
      activeConsole.value.connectionId = summary.id
      activeConsole.value.hostId = undefined
      activeConsole.value.hostConnectionId = undefined
    }
    pushToast('info', `Saved connection "${summary.name}"`)
    return summary
  }

  async function updateConnection(id: string, patch: Partial<ConnectionDraft>): Promise<ConnectionSummary> {
    const summary = await host.request('connection.update', { id, ...patch })
    upsert(summary)
    for (const tab of consoles.value) {
      if (tab.connectionId === id) {
        tab.hostId = undefined
        tab.hostConnectionId = undefined
      }
    }
    pushToast('info', `Updated connection "${summary.name}"`)
    return summary
  }

  async function deleteConnection(id: string): Promise<void> {
    await host.request('connection.delete', { id })
    connections.value = connections.value.filter((item) => item.id !== id)
    if (activeConnectionId.value === id) activeConnectionId.value = connections.value[0]?.id
    for (const tab of consoles.value) {
      if (tab.connectionId === id) {
        tab.connectionId = activeConnectionId.value
        tab.hostId = undefined
        tab.hostConnectionId = undefined
        tab.transactionOpen = false
      }
    }
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
    for (const tab of consoles.value) {
      if (tab.connectionId === id) {
        tab.transactionOpen = false
        tab.hostId = undefined
        tab.hostConnectionId = undefined
      }
    }
    upsert(summary)
  }

  async function beginTransaction(): Promise<void> {
    const tab = activeConsole.value
    const connectionId = tab?.connectionId ?? activeConnectionId.value
    if (!tab || !connectionId) {
      pushToast('warn', 'Select a connection before starting a transaction.')
      return
    }
    if (connections.value.find((item) => item.id === connectionId)?.state !== 'connected') {
      pushToast('warn', 'Connect to the database before starting a transaction.')
      return
    }
    tab.transactionBusy = true
    try {
      const hostId = await ensureHostConsole(tab)
      await host.request('transaction.begin', { connectionId, consoleId: hostId })
      tab.transactionOpen = true
      pushToast('info', 'Transaction started. Nothing is saved until you commit.')
    } catch (caught) {
      const dto = describeError(caught)
      tab.error = dto
      pushToast('error', dto.message)
    } finally {
      tab.transactionBusy = false
    }
  }

  async function finishTransaction(kind: 'commit' | 'rollback'): Promise<void> {
    const tab = activeConsole.value
    if (!tab || !tab.transactionOpen) return
    const connectionId = tab.connectionId ?? activeConnectionId.value
    if (!connectionId) return
    tab.transactionBusy = true
    try {
      await host.request(kind === 'commit' ? 'transaction.commit' : 'transaction.rollback', {
        connectionId,
        consoleId: tab.hostId,
      })
      tab.transactionOpen = false
      pushToast('info', kind === 'commit' ? 'Transaction committed.' : 'Transaction rolled back.')
    } catch (caught) {
      const dto = describeError(caught)
      tab.error = dto
      pushToast('error', dto.message)
    } finally {
      tab.transactionBusy = false
    }
  }

  async function runQuery(selection?: string): Promise<void> {
    const tab = activeConsole.value
    if (!tab) return
    const connectionId = tab.connectionId ?? activeConnectionId.value
    if (!connectionId) {
      tab.error = { code: 'invalid_request', message: 'Select a connection before running a query.' }
      return
    }
    if (connections.value.find((item) => item.id === connectionId)?.state !== 'connected') {
      const dto = { code: 'connection_failed' as const, message: 'Connect to the database before running a query.' }
      tab.error = dto
      pushToast('warn', dto.message)
      return
    }
    // Running a selection leaves the buffer untouched; the editor owns the text.
    const statement = selection && selection.trim() ? selection : tab.sql
    if (!statement.trim()) {
      tab.error = { code: 'invalid_request', message: 'The SQL buffer is empty.' }
      return
    }

    const requestId = crypto.randomUUID()
    tab.running = true
    tab.cancelRequestId = requestId
    tab.error = undefined

    try {
      const hostId = await ensureHostConsole(tab)
      const inTransaction = tab.transactionOpen
      const query = await host.request(
        inTransaction ? 'transaction.run' : 'query.execute',
        {
          connectionId,
          database: inTransaction ? undefined : (scopedDatabase.value ?? undefined),
          consoleId: hostId,
          sql: statement,
          maxRows: prefs.value.maxRows,
        },
        requestId,
      )
      tab.result = query
    } catch (caught) {
      const dto = describeError(caught)
      if (dto.code === 'cancelled') {
        pushToast('warn', 'Query cancelled.')
      } else {
        tab.error = dto
        pushToast('error', dto.message)
      }
    } finally {
      tab.running = false
      tab.cancelRequestId = undefined
    }
  }

  async function cancelQuery(): Promise<void> {
    const tab = activeConsole.value
    const targetRequestId = tab?.cancelRequestId
    if (!targetRequestId) return
    try {
      await host.request('query.cancel', { targetRequestId })
    } catch {
      // The query already finished: nothing to cancel.
    }
  }

  async function explainSql(selection?: string): Promise<void> {
    const tab = activeConsole.value
    if (!tab) return
    const connectionId = tab.connectionId ?? activeConnectionId.value
    if (!connectionId) {
      tab.error = { code: 'invalid_request', message: 'Select a connection before explaining a query.' }
      return
    }
    const statement = selection && selection.trim() ? selection : tab.sql
    if (!statement.trim()) {
      tab.error = { code: 'invalid_request', message: 'The SQL buffer is empty.' }
      return
    }
    tab.explaining = true
    tab.error = undefined
    try {
      tab.explain = await host.request(
        'query.explain',
        { connectionId, database: scopedDatabase.value ?? undefined, sql: statement },
        crypto.randomUUID(),
      )
    } catch (caught) {
      const dto = describeError(caught)
      tab.error = dto
      pushToast('error', dto.message)
    } finally {
      tab.explaining = false
    }
  }

  function clearResult(): void {
    const tab = activeConsole.value
    if (!tab) return
    tab.result = undefined
    tab.explain = undefined
    tab.error = undefined
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
    consoles,
    activeConsoleId,
    activeConsole,
    sql,
    result,
    error,
    running,
    explaining,
    explainResult,
    transactionOpen,
    transactionBusy,
    beginTransaction,
    commitTransaction: () => finishTransaction('commit'),
    rollbackTransaction: () => finishTransaction('rollback'),
    testing,
    lastTest,
    toasts,
    pendingRelation,
    scopedDatabase,
    initialize,
    refresh,
    setActiveConnection,
    setActiveConsole,
    addConsole,
    closeConsole,
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
