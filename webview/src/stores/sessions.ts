import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { SessionListDto } from '@shared/protocol'

import { host } from '../lib/host'
import { useWorkbenchStore } from './workbench'

/**
 * Operations view state. The panel is scoped to the connection that opened it,
 * so a refresh cannot silently switch to another connection's server.
 */
export const useSessionsStore = defineStore('sessions', () => {
  const open = ref(false)
  const loading = ref(false)
  const error = ref<string>()
  const data = ref<SessionListDto>()
  const confirmId = ref<string>()
  const terminatingId = ref<string>()

  let scope: { connectionId?: string; database?: string } = {}

  const sessions = computed(() => data.value?.sessions ?? [])
  const longRunningMs = computed(() => data.value?.longRunningMs ?? 60_000)
  const currentUser = computed(() => data.value?.currentUser)

  function show(connectionId: string, database?: string): void {
    scope = { connectionId, database: database ?? undefined }
    open.value = true
    confirmId.value = undefined
    void refresh()
  }

  async function refresh(): Promise<void> {
    if (!scope.connectionId) return
    loading.value = true
    error.value = undefined
    try {
      data.value = await host.request(
        'session.list',
        { connectionId: scope.connectionId, database: scope.database },
        crypto.randomUUID(),
      )
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      loading.value = false
    }
  }

  function askTerminate(id: string): void {
    confirmId.value = id
  }

  function cancelTerminate(): void {
    confirmId.value = undefined
  }

  async function terminate(id: string): Promise<void> {
    if (!scope.connectionId) return
    terminatingId.value = id
    error.value = undefined
    try {
      await host.request(
        'session.terminate',
        {
          connectionId: scope.connectionId,
          database: scope.database,
          sessionId: id,
          confirm: true,
        },
        crypto.randomUUID(),
      )
      useWorkbenchStore().pushToast('info', `Terminated session ${id}.`)
      confirmId.value = undefined
      await refresh()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      error.value = message
      useWorkbenchStore().pushToast('error', message)
    } finally {
      terminatingId.value = undefined
    }
  }

  function close(): void {
    open.value = false
    confirmId.value = undefined
  }

  return {
    open,
    loading,
    error,
    data,
    confirmId,
    terminatingId,
    sessions,
    longRunningMs,
    currentUser,
    show,
    refresh,
    askTerminate,
    cancelTerminate,
    terminate,
    close,
  }
})
