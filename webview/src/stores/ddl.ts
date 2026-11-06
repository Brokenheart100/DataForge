import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type {
  DdlAlterColumnPlanDto,
  DdlApplyDto,
  DdlColumnPlanDto,
  DdlPlanDto,
  DdlPreviewDto,
} from '@shared/protocol'

import { host } from '../lib/host'

export type DdlMode = 'create table' | 'add column' | 'create index' | 'alter column' | 'drop table'

export interface ColumnDraft {
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  unique: boolean
  defaultValue: string
}

export interface AlterDraft {
  name: string
  dataType: string
  nullableMode: 'keep' | 'nullable' | 'not null'
  defaultMode: 'keep' | 'set' | 'drop'
  defaultValue: string
}

export const DDL_MODES: readonly { value: DdlMode; label: string }[] = [
  { value: 'create table', label: 'Create table' },
  { value: 'add column', label: 'Add column' },
  { value: 'create index', label: 'Create index' },
  { value: 'alter column', label: 'Alter column' },
  { value: 'drop table', label: 'Drop table' },
]

function blankColumn(): ColumnDraft {
  return { name: '', dataType: 'text', nullable: true, primaryKey: false, unique: false, defaultValue: '' }
}

function blankAlter(): AlterDraft {
  return { name: '', dataType: '', nullableMode: 'keep', defaultMode: 'keep', defaultValue: '' }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Structural-change drafts. The store never builds SQL: it assembles intent,
 * and the host validates it and returns the previewed statements.
 */
export const useDdlStore = defineStore('ddl', () => {
  const open = ref(false)
  const mode = ref<DdlMode>('create table')
  const connectionId = ref<string | null>(null)
  const database = ref<string | null>(null)
  const schema = ref('public')
  const table = ref('')
  const baseTable = ref('')
  const columns = ref<ColumnDraft[]>([
    { name: 'id', dataType: 'integer', nullable: false, primaryKey: true, unique: false, defaultValue: '' },
  ])
  const column = ref<ColumnDraft>(blankColumn())
  const alter = ref<AlterDraft>(blankAlter())
  const indexName = ref('')
  const indexUnique = ref(false)
  const indexColumns = ref('')
  const ifNotExists = ref(true)
  const ifExists = ref(true)
  const preview = ref<DdlPreviewDto | null>(null)
  const previewing = ref(false)
  const applying = ref(false)
  const confirmText = ref('')
  const error = ref<string | null>(null)

  const risky = computed(() => preview.value?.requiresConfirmation === true)
  const canApply = computed(
    () =>
      preview.value !== null &&
      !applying.value &&
      (!risky.value || confirmText.value === preview.value.expectedConfirmation),
  )

  function openFor(scope: {
    connectionId: string
    database?: string | null
    schema: string
    table?: string | null
  }): void {
    connectionId.value = scope.connectionId
    database.value = scope.database ?? null
    schema.value = scope.schema
    baseTable.value = scope.table ?? ''
    table.value = ''
    mode.value = 'create table'
    columns.value = [
      { name: 'id', dataType: 'integer', nullable: false, primaryKey: true, unique: false, defaultValue: '' },
    ]
    column.value = blankColumn()
    alter.value = blankAlter()
    indexName.value = ''
    indexUnique.value = false
    indexColumns.value = ''
    ifNotExists.value = true
    ifExists.value = true
    preview.value = null
    confirmText.value = ''
    error.value = null
    open.value = true
  }

  function close(): void {
    if (applying.value) return
    open.value = false
    preview.value = null
    confirmText.value = ''
    error.value = null
  }

  function chooseMode(next: DdlMode): void {
    mode.value = next
    table.value = next === 'create table' ? '' : baseTable.value
    preview.value = null
    confirmText.value = ''
    error.value = null
  }

  function addColumnRow(): void {
    columns.value.push(blankColumn())
  }

  function removeColumnRow(index: number): void {
    columns.value.splice(index, 1)
  }

  function toColumnPlan(draft: ColumnDraft): DdlColumnPlanDto {
    return {
      name: draft.name.trim(),
      dataType: draft.dataType.trim(),
      nullable: draft.nullable,
      defaultValue: draft.defaultValue.trim() === '' ? null : draft.defaultValue.trim(),
      primaryKey: draft.primaryKey,
      unique: draft.unique,
    }
  }

  function plan(): DdlPlanDto | null {
    if (connectionId.value === null) return null
    const base = {
      connectionId: connectionId.value,
      ...(database.value === null ? {} : { database: database.value }),
      schema: schema.value.trim(),
      table: table.value.trim(),
    }
    switch (mode.value) {
      case 'create table':
        return {
          kind: 'create table',
          ...base,
          columns: columns.value.map(toColumnPlan),
          ifNotExists: ifNotExists.value,
        }
      case 'add column':
        return {
          kind: 'add column',
          ...base,
          column: toColumnPlan(column.value),
          ifNotExists: ifNotExists.value,
        }
      case 'create index':
        return {
          kind: 'create index',
          ...base,
          index: {
            ...(indexName.value.trim() === '' ? {} : { name: indexName.value.trim() }),
            unique: indexUnique.value,
            columns: indexColumns.value
              .split(',')
              .map((item) => item.trim())
              .filter((item) => item.length > 0),
          },
          ifNotExists: ifNotExists.value,
        }
      case 'alter column': {
        const column: DdlAlterColumnPlanDto = { name: alter.value.name.trim() }
        const dataType = alter.value.dataType.trim()
        if (dataType.length > 0) column.dataType = dataType
        if (alter.value.nullableMode !== 'keep') column.nullable = alter.value.nullableMode === 'nullable'
        if (alter.value.defaultMode === 'drop') column.defaultValue = null
        if (alter.value.defaultMode === 'set') column.defaultValue = alter.value.defaultValue.trim()
        return { kind: 'alter column', ...base, column }
      }
      case 'drop table':
        return { kind: 'drop table', ...base, ifExists: ifExists.value }
    }
  }

  async function previewPlan(): Promise<void> {
    const value = plan()
    if (!value) return
    previewing.value = true
    error.value = null
    try {
      preview.value = await host.request('ddl.preview', value)
      confirmText.value = ''
    } catch (cause) {
      preview.value = null
      error.value = messageOf(cause)
    } finally {
      previewing.value = false
    }
  }

  async function apply(): Promise<DdlApplyDto | null> {
    const value = plan()
    if (!value || !preview.value || !canApply.value) return null
    applying.value = true
    error.value = null
    try {
      const result = await host.request('ddl.apply', {
        plan: value,
        ...(risky.value ? { confirm: confirmText.value } : {}),
      })
      open.value = false
      preview.value = null
      return result
    } catch (cause) {
      error.value = messageOf(cause)
      return null
    } finally {
      applying.value = false
    }
  }

  async function openInEditor(): Promise<void> {
    const value = plan()
    if (!value) return
    try {
      await host.request('ddl.openInEditor', value)
    } catch (cause) {
      error.value = messageOf(cause)
    }
  }

  function previewSql(): string {
    return preview.value?.statements.map((statement) => statement.sql).join('\n\n') ?? ''
  }

  return {
    open,
    mode,
    connectionId,
    database,
    schema,
    table,
    baseTable,
    columns,
    column,
    alter,
    indexName,
    indexUnique,
    indexColumns,
    ifNotExists,
    ifExists,
    preview,
    previewing,
    applying,
    confirmText,
    error,
    risky,
    canApply,
    openFor,
    close,
    chooseMode,
    addColumnRow,
    removeColumnRow,
    previewPlan,
    apply,
    openInEditor,
    previewSql,
  }
})
