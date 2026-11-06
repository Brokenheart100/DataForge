<script setup lang="ts">
import type { ExplainPlanNodeDto } from '@shared/protocol'

defineOptions({ name: 'PlanTree' })

defineProps<{ node: ExplainPlanNodeDto }>()

function number(value: number | undefined): string {
  if (value === undefined) return '–'
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}
</script>

<template>
  <div class="min-w-0">
    <div class="flex flex-wrap items-center gap-2 border-2 border-ink bg-paper px-2 py-1">
      <span class="df-chip border-ink bg-surface text-[10px] font-black uppercase tracking-wide">
        {{ node.nodeType }}
      </span>
      <span v-if="node.relation" class="text-[11px]">
        on <span class="font-bold">{{ node.relation }}</span>
        <span v-if="node.alias && node.alias !== node.relation" class="text-muted"> as {{ node.alias }}</span>
      </span>
      <span v-if="node.indexName" class="df-chip border-forge-purple bg-forge-purple/15 text-[10px]">
        index {{ node.indexName }}
      </span>
      <span v-if="node.joinType" class="df-chip text-[10px]">{{ node.joinType }} join</span>
      <span class="ml-auto text-[10px] text-muted">
        cost {{ number(node.startupCost) }}..{{ number(node.totalCost) }}
        · rows {{ number(node.planRows) }}
        · width {{ number(node.planWidth) }}
        <template v-if="node.actualRows !== undefined">
          · actual {{ number(node.actualRows) }} rows / {{ number(node.actualTotalTime) }} ms
        </template>
      </span>
    </div>
    <div v-if="node.filter" class="df-code mt-1 border-2 border-ink/20 bg-surface p-1 text-[10px]">
      {{ node.filter }}
    </div>
    <div v-if="node.children.length > 0" class="mt-1 ml-3 flex flex-col gap-1 border-l-2 border-ink/30 pl-3">
      <PlanTree v-for="(child, index) in node.children" :key="index" :node="child" />
    </div>
  </div>
</template>
