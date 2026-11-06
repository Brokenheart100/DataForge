<script setup lang="ts">
import { Copy, FileCode2, Loader2, X } from 'lucide-vue-next'

import { useWorkbenchStore } from '@/stores/workbench'

const store = useWorkbenchStore()
</script>

<template>
  <div
    v-if="store.ddlOpen"
    class="fixed inset-0 z-40 grid place-items-center bg-black/40 p-6"
    role="dialog"
    aria-modal="true"
    @click.self="store.closeDdl()"
  >
    <section class="df-panel flex max-h-full w-full max-w-3xl flex-col bg-surface">
      <header class="flex items-center gap-3 border-b-2 border-ink px-4 py-3">
        <FileCode2 class="h-4 w-4 shrink-0" aria-hidden="true" />
        <div class="min-w-0">
          <h2 class="truncate text-sm font-black">
            {{ store.ddlTarget ? `${store.ddlTarget.schema}.${store.ddlTarget.name}` : 'DDL' }}
          </h2>
          <p v-if="store.ddlTarget" class="text-[11px] text-muted">
            {{ store.ddlTarget.kind }}{{ store.ddlTarget.database ? ` · ${store.ddlTarget.database}` : '' }} · read-only
          </p>
        </div>
        <button class="df-btn df-btn-ghost ml-auto" type="button" aria-label="Close the DDL viewer" @click="store.closeDdl()">
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto p-4">
        <div v-if="store.ddlLoading" class="flex items-center gap-2 text-xs text-muted">
          <Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
          Reading the definition…
        </div>
        <p v-else-if="store.ddlError" class="df-chip bg-forge-red/20" data-testid="ddl-error">
          {{ store.ddlError.code }} · {{ store.ddlError.message }}
        </p>
        <pre v-else class="df-code whitespace-pre text-xs leading-5">{{ store.ddlText }}</pre>
      </div>

      <footer class="flex flex-wrap items-center gap-2 border-t-2 border-ink px-4 py-3">
        <button class="df-btn" type="button" :disabled="store.ddlLoading || !!store.ddlError" @click="store.copyDdl()">
          <Copy class="h-4 w-4" aria-hidden="true" />
          Copy
        </button>
        <button
          class="df-btn df-btn-primary"
          type="button"
          :disabled="store.ddlLoading || !!store.ddlError"
          @click="store.openDdlInEditor()"
        >
          <FileCode2 class="h-4 w-4" aria-hidden="true" />
          Open in editor
        </button>
        <button class="df-btn df-btn-ghost ml-auto" type="button" @click="store.closeDdl()">Close</button>
      </footer>
    </section>
  </div>
</template>
