<script setup lang="ts">
import { reactive, ref, watch } from 'vue'

import type { ConnectionDraft, ConnectionKind, ConnectionSummary, ConnectionTestResult, SslMode } from '@shared/protocol'

import { useWorkbenchStore } from '@/stores/workbench'
import { t } from '@/lib/i18n'

const props = defineProps<{
  open: boolean
  connection?: ConnectionSummary
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: [connection: ConnectionSummary]
}>()

const store = useWorkbenchStore()

interface KindPreset {
  value: ConnectionKind
  label: string
  port: string
  database: string
  user: string
}

const KIND_PRESETS: readonly KindPreset[] = [
  { value: 'postgresql', label: 'PostgreSQL', port: '5432', database: 'postgres', user: 'postgres' },
  { value: 'mysql', label: 'MySQL / MariaDB', port: '3306', database: 'mysql', user: 'root' },
  { value: 'sqlserver', label: 'SQL Server (read-only)', port: '1433', database: 'master', user: 'sa' },
]

interface FormState {
  kind: ConnectionKind
  name: string
  host: string
  port: string
  database: string
  user: string
  password: string
  ssl: SslMode
  readOnly: boolean
  tunnel: boolean
  sshHost: string
  sshPort: string
  sshUser: string
  sshAuth: 'password' | 'private key'
  sshKeyPath: string
  sshPassword: string
  sshPassphrase: string
}

const form = reactive<FormState>(blankForm())
const busy = ref(false)
const message = ref<{ tone: 'ok' | 'error'; text: string }>()
const testResult = ref<ConnectionTestResult>()

function presetFor(kind: ConnectionKind): KindPreset {
  return KIND_PRESETS.find((preset) => preset.value === kind) ?? KIND_PRESETS[0]!
}

function kindLabel(kind: ConnectionKind): string {
  if (kind === 'mysql') return t('conn.kindMysql')
  if (kind === 'sqlserver') return t('conn.kindSqlServer')
  return 'PostgreSQL'
}

function blankForm(kind: ConnectionKind = 'postgresql'): FormState {
  const preset = presetFor(kind)
  return {
    kind,
    name: '',
    host: 'localhost',
    port: preset.port,
    database: preset.database,
    user: preset.user,
    password: '',
    ssl: kind === 'postgresql' ? 'require' : 'disable',
    readOnly: kind === 'sqlserver',
    tunnel: false,
    sshHost: '',
    sshPort: '22',
    sshUser: '',
    sshAuth: 'password',
    sshKeyPath: '',
    sshPassword: '',
    sshPassphrase: '',
  }
}

function applyKind(kind: ConnectionKind): void {
  if (kind === form.kind) return
  const preset = presetFor(kind)
  form.kind = kind
  form.port = preset.port
  form.database = preset.database
  form.user = preset.user
  form.readOnly = kind === 'sqlserver'
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
          kind: connection.kind,
          name: connection.name,
          host: connection.host,
          port: String(connection.port),
          database: connection.database,
          user: connection.user,
          password: '',
          ssl: connection.ssl,
          readOnly: connection.readOnly,
          tunnel: connection.tunnel !== undefined,
          sshHost: connection.tunnel?.host ?? '',
          sshPort: String(connection.tunnel?.port ?? 22),
          sshUser: connection.tunnel?.user ?? '',
          sshAuth: connection.tunnel?.auth ?? 'password',
          sshKeyPath: connection.tunnel?.privateKeyPath ?? '',
          sshPassword: '',
          sshPassphrase: '',
        }
        : blankForm(),
    )
  },
  { immediate: true },
)

function toDraft(): ConnectionDraft {
  const port = Number.parseInt(form.port, 10)
  const draft: ConnectionDraft = {
    kind: form.kind,
    name: form.name.trim() || `${form.database.trim()}@${form.host.trim()}`,
    host: form.host.trim(),
    port: Number.isFinite(port) ? port : Number.parseInt(presetFor(form.kind).port, 10),
    database: form.database.trim(),
    user: form.user.trim(),
    password: form.password,
    ssl: form.ssl,
    readOnly: form.readOnly,
  }
  if (form.tunnel) {
    const sshPort = Number.parseInt(form.sshPort, 10)
    draft.tunnel = {
      host: form.sshHost.trim(),
      port: Number.isFinite(sshPort) ? sshPort : 22,
      user: form.sshUser.trim(),
      auth: form.sshAuth,
      ...(form.sshAuth === 'private key' ? { privateKeyPath: form.sshKeyPath.trim() } : {}),
    }
    if (form.sshPassword) draft.sshPassword = form.sshPassword
    if (form.sshPassphrase) draft.sshPassphrase = form.sshPassphrase
  } else if (props.connection?.tunnel) {
    // Explicit null removes an existing tunnel; updates treat undefined as “keep”.
    draft.tunnel = null
  }
  return draft
}

function validate(): string | undefined {
  const draft = toDraft()
  if (!draft.host) return t('conn.errHost')
  if (!draft.database) return t('conn.errDatabase')
  if (!draft.user) return t('conn.errUser')
  if (draft.kind !== 'sqlite' && (draft.port < 1 || draft.port > 65535)) return t('conn.errPort')
  if (form.tunnel) {
    if (!form.sshHost.trim()) return t('conn.errSshHost')
    if (!form.sshUser.trim()) return t('conn.errSshUser')
    const sshPort = Number.parseInt(form.sshPort, 10)
    if (!Number.isFinite(sshPort) || sshPort < 1 || sshPort > 65535) {
      return t('conn.errSshPort')
    }
    if (form.sshAuth === 'private key' && !form.sshKeyPath.trim()) {
      return t('conn.errKey')
    }
    if (form.sshAuth === 'password' && !form.sshPassword && !props.connection) {
      return t('conn.errSshPassword')
    }
  }
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
    <form class="df-panel max-h-[90vh] w-full max-w-lg overflow-y-auto p-4" @submit.prevent="save">
      <div class="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-black uppercase tracking-wide">
            {{ connection ? t('conn.titleEdit') : t('conn.titleNew') }}
          </h2>
          <p class="text-[11px] text-muted">{{ t('conn.secretNote') }}</p>
        </div>
        <button class="df-btn df-btn-ghost px-2 py-1 text-xs" type="button" @click="close">✕</button>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="col-span-2">
          <span class="df-label">{{ t('conn.type') }}</span>
          <select class="df-input" :value="form.kind"
            @change="applyKind(($event.target as HTMLSelectElement).value as ConnectionKind)">
            <option v-for="preset in KIND_PRESETS" :key="preset.value" :value="preset.value">{{ kindLabel(preset.value) }}</option>
          </select>
        </label>
        <label class="col-span-2">
          <span class="df-label">{{ t('conn.name') }}</span>
          <input v-model="form.name" class="df-input" :placeholder="`${form.database}@${form.host}`" />
        </label>
        <label class="col-span-2 sm:col-span-1">
          <span class="df-label">{{ t('conn.host') }}</span>
          <input v-model="form.host" class="df-input" required autocomplete="off" spellcheck="false" />
        </label>
        <label class="col-span-2 sm:col-span-1">
          <span class="df-label">{{ t('conn.port') }}</span>
          <input v-model="form.port" class="df-input" inputmode="numeric" />
        </label>
        <label>
          <span class="df-label">{{ t('conn.database') }}</span>
          <input v-model="form.database" class="df-input" required autocomplete="off" spellcheck="false" />
        </label>
        <label>
          <span class="df-label">{{ t('conn.user') }}</span>
          <input v-model="form.user" class="df-input" required autocomplete="off" spellcheck="false" />
        </label>
        <label>
          <span class="df-label">{{ t('conn.password') }}</span>
          <input v-model="form.password" class="df-input" type="password" autocomplete="new-password"
            :placeholder="connection ? t('common.unchanged') : ''" />
        </label>
        <label>
          <span class="df-label">{{ t('conn.ssl') }}</span>
          <select v-model="form.ssl" class="df-input">
            <option value="disable">{{ t('conn.sslDisable') }}</option>
            <option value="require">{{ t('conn.sslRequire') }}</option>
            <option value="verify-full">{{ t('conn.sslVerify') }}</option>
          </select>
        </label>
        <label class="col-span-2 flex items-center gap-2 pt-1">
          <input v-model="form.readOnly" type="checkbox" class="size-4 accent-forge-purple" />
          <span class="text-xs">{{ t('conn.readOnly') }}</span>
        </label>
        <label class="col-span-2 flex items-center gap-2 border-t-2 border-ink pt-3">
          <input v-model="form.tunnel" type="checkbox" class="size-4 accent-forge-purple" />
          <span class="text-xs font-bold">{{ t('conn.tunnel') }}</span>
        </label>
        <template v-if="form.tunnel">
          <label class="col-span-2 sm:col-span-1">
            <span class="df-label">{{ t('conn.sshHost') }}</span>
            <input v-model="form.sshHost" class="df-input" autocomplete="off" spellcheck="false" />
          </label>
          <label class="col-span-2 sm:col-span-1">
            <span class="df-label">{{ t('conn.sshPort') }}</span>
            <input v-model="form.sshPort" class="df-input" inputmode="numeric" />
          </label>
          <label class="col-span-2">
            <span class="df-label">{{ t('conn.sshUser') }}</span>
            <input v-model="form.sshUser" class="df-input" autocomplete="off" spellcheck="false" />
          </label>
          <label class="col-span-2">
            <span class="df-label">{{ t('conn.sshAuth') }}</span>
            <select v-model="form.sshAuth" class="df-input">
              <option value="password">{{ t('conn.authPassword') }}</option>
              <option value="private key">{{ t('conn.authKey') }}</option>
            </select>
          </label>
          <label v-if="form.sshAuth === 'password'" class="col-span-2">
            <span class="df-label">{{ t('conn.sshPassword') }}</span>
            <input v-model="form.sshPassword" class="df-input" type="password" autocomplete="new-password"
              :placeholder="connection?.tunnel ? t('common.unchanged') : ''" />
          </label>
          <template v-else>
            <label class="col-span-2">
              <span class="df-label">{{ t('conn.privateKey') }}</span>
              <input v-model="form.sshKeyPath" class="df-input" placeholder="~/.ssh/id_ed25519" spellcheck="false" />
            </label>
            <label class="col-span-2">
              <span class="df-label">{{ t('conn.passphrase') }}</span>
              <input v-model="form.sshPassphrase" class="df-input" type="password" autocomplete="new-password"
                :placeholder="connection?.tunnel ? t('common.unchanged') : ''" />
            </label>
          </template>
        </template>
      </div>

      <p v-if="message" class="mt-3 border-2 px-2 py-1 text-[11px]"
        :class="message.tone === 'ok' ? 'border-forge-mint' : 'border-forge-red'">
        {{ message.text }}
      </p>

      <div class="mt-4 flex items-center justify-between gap-2">
        <button class="df-btn" type="button" :disabled="busy" @click="testConnection">{{ t('conn.test') }}</button>
        <div class="flex gap-2">
          <button class="df-btn df-btn-ghost" type="button" :disabled="busy" @click="close">{{ t('common.cancel') }}</button>
          <button class="df-btn df-btn-primary" type="submit" :disabled="busy">
            {{ connection ? t('conn.save') : t('conn.create') }}
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
