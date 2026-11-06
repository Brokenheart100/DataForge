<script setup lang="ts">
import { Loader2, RefreshCw, Users, X } from 'lucide-vue-next'

import type { ServerSessionDto } from '@shared/protocol'

import { useSessionsStore } from '@/stores/sessions'

const sessions = useSessionsStore()

function duration(value: number | undefined): string {
  if (value === undefined) return '–'
  if (value < 1_000) return `${Math.round(value)} ms`
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function shortSql(session: ServerSessionDto): string {
  const text = session.query?.replace(/\s+/g, ' ').trim() ?? ''
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function isMine(session: ServerSessionDto): boolean {
  return session.user !== undefined && session.user === sessions.currentUser
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4" @click.self="sessions.close()">
    <div class="df-panel flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden">
      <div class="flex shrink-0 items-center gap-2 border-b-2 border-ink bg-forge-yellow px-3 py-2">
        <Users :size="15" />
        <h2 class="text-[13px] font-black uppercase tracking-wide">Server sessions</h2>
        <span v-if="sessions.currentUser" class="df-chip text-[10px]">as {{ sessions.currentUser }}</span>
        <span class="text-[10px] text-muted">long-running after {{ duration(sessions.longRunningMs) }}</span>
        <div class="ml-auto flex items-center gap-2">
          <button class="df-btn df-btn-ghost" type="button" :disabled="sessions.loading" @click="sessions.refresh()">
            <Loader2 v-if="sessions.loading" :size="12" class="animate-spin" />
            <RefreshCw v-else :size="12" />
            Refresh
          </button>
          <button class="df-btn df-btn-ghost" type="button" aria-label="Close" @click="sessions.close()">
            <X :size="14" />
          </button>
        </div>
      </div>

      <div v-if="sessions.error" class="border-b-2 border-forge-red bg-forge-red/10 px-3 py-2 text-[11px] text-forge-red">
        {{ sessions.error }}
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full border-collapse text-left text-[11px]">
          <thead class="sticky top-0 z-10 bg-surface">
            <tr class="border-b-2 border-ink text-[10px] uppercase tracking-wide text-muted">
              <th class="px-2 py-1 font-bold">Id</th>
              <th class="px-2 py-1 font-bold">User</th>
              <th class="px-2 py-1 font-bold">Database</th>
              <th class="px-2 py-1 font-bold">State</th>
              <th class="px-2 py-1 font-bold">For</th>
              <th class="px-2 py-1 font-bold">Query</th>
              <th class="px-2 py-1 font-bold" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in sessions.sessions" :key="session.id" class="border-b border-ink/15 align-top">
              <td class="df-code px-2 py-1.5">{{ session.id }}</td>
              <td class="px-2 py-1.5">
                {{ session.user ?? '–' }}
                <span v-if="isMine(session)" class="df-chip ml-1 text-[9px]">you</span>
              </td>
              <td class="px-2 py-1.5">{{ session.database ?? '–' }}</td>
              <td class="px-2 py-1.5">
                {{ session.state ?? '–' }}
                <span v-if="session.waitEvent" class="mt-1 block text-[10px] text-muted">{{ session.waitEvent }}</span>
              </td>
              <td class="px-2 py-1.5">
                <span
                  class="df-chip text-[10px]"
                  :class="session.longRunning ? 'border-forge-red bg-forge-red/15 text-forge-red' : ''"
                >
                  {{ duration(session.durationMs) }}
                </span>
              </td>
              <td class="df-code max-w-[360px] px-2 py-1.5 whitespace-normal break-words text-[10px]">
                {{ shortSql(session) || '–' }}
                <span v-if="session.application" class="mt-1 block text-muted">{{ session.application }} · {{ session.client ?? 'local' }}</span>
              </td>
              <td class="px-2 py-1.5">
                <div v-if="sessions.confirmId === session.id" class="flex items-center gap-1">
                  <button class="df-btn df-btn-danger" type="button" :disabled="sessions.terminatingId === session.id"
                    @click="sessions.terminate(session.id)">
                    <Loader2 v-if="sessions.terminatingId === session.id" :size="12" class="animate-spin" />
                    Confirm
                  </button>
                  <button class="df-btn df-btn-ghost" type="button" @click="sessions.cancelTerminate()">No</button>
                </div>
                <button v-else class="df-btn df-btn-ghost" type="button" :disabled="!isMine(session)"
                  :title="isMine(session) ? 'Terminate this session' : 'Only sessions of the connection user can be terminated'"
                  @click="sessions.askTerminate(session.id)">
                  Terminate
                </button>
              </td>
            </tr>
            <tr v-if="!sessions.loading && sessions.sessions.length === 0">
              <td colspan="7" class="px-2 py-6 text-center text-muted">No other sessions are connected.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="shrink-0 border-t-2 border-ink bg-surface px-3 py-1.5 text-[10px] text-muted">
        Only sessions owned by the connection user can be terminated. The host asks the server to close the backend.
      </div>
    </div>
  </div>
</template>
