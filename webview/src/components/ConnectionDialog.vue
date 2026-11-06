<script setup lang="ts">
import { reactive, ref, watch } from 'vue'

import type { ConnectionDraft, ConnectionSummary, ConnectionTestResult, SslMode } from '@shared/protocol'

import { useWorkbenchStore } from '@/stores/workbench'

const props = defineProps<{
  open: boolean
  connection?: ConnectionSummary
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: [connection: ConnectionSummary]
}>()

const store = useWorkbenchStore()

interface FormState {
  name: string
  host: string
  port: string
  database: string
  user: string
  password: string
  ssl: SslMode
  readOnly: boolean
}

const form = reactive<FormState>(blankForm())
const busy = ref(false)
const message = ref<{ tone: 'ok' | 'error'; text: string }>()
const testResult = ref<ConnectionTestResult>()

function blankForm(): FormState {
  return {
    name: '',
    host: 'localhost',
    port: '5432',
    database: 'postgres',
    user: 'postgres',
    password: '',
    ssl: 'require',
    readOnly: false,
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    message.value = undefined
    testResult.value = undefined
    const connection = props.connection
    Object.assign(
      form,
      connection
        ? {
          name: connection.name,
          host: connection.host,
          port: String(connection.port),
          database: connection.database,
          user: connection.user,
          password: '',
          ssl: connection.ssl,
          readOnly: connection.readOnly,
        }
        : blankForm(),
    )
  },
  { immediate: true },
)

function toDraft(): ConnectionDraft {
  const port = Number.parseInt(form.port, 10)
  return {
    name: form.name.trim() || `${form.database.trim()}@${form.host.trim()}`,
    host: form.host.trim(),
    port: Number.isFinite(port) ? port : 5432,
    database: form.database.trim(),
    user: form.user.trim(),
    password: form.password,
    ssl: form.ssl,
    readOnly: form.readOnly,
  }
}

function validate(): string | undefined {
  const draft = toDraft()
  if (!draft.host) return 'Host is required.'
  if (!draft.database) return 'Database name is required.'
  if (!draft.user) return 'User is required.'
  if (draft.port < 1 || draft.port > 65535) return 'Port must be between 1 and 65535.'
  return undefined
}

async function testConnection(): Promise<void> {
  const invalid = validate()
  if (invalid) {
    message.value = { tone: 'error', text: invalid }
    return
  }
  busy.value = true
  message.value = undefined
  try {
    const target = props.connection ? { connectionId: props.connection.id } : { draft: toDraft() }
    testResult.value = await store.testConnection(target)
    message.value = {
      tone: 'ok',
      text: `${testResult.value.serverVersion} · ${testResult.value.database} · ${testResult.value.latencyMs} ms`,
    }
  } catch (error) {
    message.value = { tone: 'error', text: error instanceof Error ? error.message : String(error) }
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  const invalid = validate()
  if (invalid) {
    message.value = { tone: 'error', text: invalid }
    return
  }
  busy.value = true
  message.value = undefined
  try {
    const draft = toDraft()
    const saved = props.connection
      ? await store.updateConnection(props.connection.id, form.password ? draft : { ...draft, password: undefined })
      : await store.createConnection(draft)
    emit('saved', saved)
    emit('update:open', false)
  } catch (error) {
    message.value = { tone: 'error', text: error instanceof Error ? error.message : String(error) }
  } finally {
    busy.value = false
  }
}

function close(): void {
  emit('update:open', false)
}
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" @click.self="close">
    <form class="df-panel w-full max-w-lg p-4" @submit.prevent="save">
      <div class="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-black uppercase tracking-wide">
            {{ connection ? 'Edit connection' : 'New PostgreSQL connection' }}
          </h2>
          <p class="text-[11px] text-muted">The password is stored in VS Code SecretStorage, never in settings.</p>
        </div>
        <button class="df-btn df-btn-ghost px-2 py-1 text-xs" type="button" @click="close">✕</button>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="col-span-2">
          <span class="df-label">Name</span>
          <input v-model="form.name" class="df-input" :placeholder="`${form.database}@${form.host}`" />
        </label>
        <label class="col-span-2 sm:col-span-1">
          <span class="df-label">Host</span>
          <input v-model="form.host" class="df-input" required autocomplete="off" spellcheck="false" />
        </label>
        <label class="col-span-2 sm:col-span-1">
          <span class="df-label">Port</span>
          <input v-model="form.port" class="df-input" inputmode="numeric" />
        </label>
        <label>
          <span class="df-label">Database</span>
          <input v-model="form.database" class="df-input" required autocomplete="off" spellcheck="false" />
        </label>
        <label>
          <span class="df-label">User</span>
          <input v-model="form.user" class="df-input" required autocomplete="off" spellcheck="false" />
        </label>
        <label>
          <span class="df-label">Password</span>
          <input v-model="form.password" class="df-input" type="password" autocomplete="new-password"
            :placeholder="connection ? 'unchanged' : ''" />
        </label>
        <label>
          <span class="df-label">SSL</span>
          <select v-model="form.ssl" class="df-input">
            <option value="disable">disable</option>
            <option value="require">require</option>
            <option value="verify-full">verify-full</option>
          </select>
        </label>
        <label class="col-span-2 flex items-center gap-2 pt-1">
          <input v-model="form.readOnly" type="checkbox" class="size-4 accent-forge-purple" />
          <span class="text-xs">Read-only: block writes from this connection</span>
        </label>
      </div>

      <p v-if="message" class="mt-3 border-2 px-2 py-1 text-[11px]"
        :class="message.tone === 'ok' ? 'border-forge-mint' : 'border-forge-red'">
        {{ message.text }}
      </p>

      <div class="mt-4 flex items-center justify-between gap-2">
        <button class="df-btn" type="button" :disabled="busy" @click="testConnection">Test connection</button>
        <div class="flex gap-2">
          <button class="df-btn df-btn-ghost" type="button" :disabled="busy" @click="close">Cancel</button>
          <button class="df-btn df-btn-primary" type="submit" :disabled="busy">
            {{ connection ? 'Save changes' : 'Create connection' }}
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
