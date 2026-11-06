import type {
  DdlAlterColumnPlanDto,
  DdlColumnPlanDto,
  DdlIndexPlanDto,
  DdlPlanDto,
  DdlRisk,
} from '@shared/protocol'

/**
 * Structural-change validation. The webview sends intent; this module is the
 * first gate before any statement text exists, so every identifier, type and
 * default value is checked here rather than trusted from the UI.
 */

export const MAX_IDENTIFIER_LENGTH = 63

/**
 * PostgreSQL type text as a user would type it: a name, optional `(n[,m])`
 * precision and an optional array suffix. Schema-qualified custom types are
 * deliberately rejected: they would need their own quoting path.
 */
export const COLUMN_TYPE_PATTERN =
  /^[a-z][a-z0-9 ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?(\[\])?$/i

const DEFAULT_LITERAL = /^(?:null|true|false|-?\d+(?:\.\d+)?|'(?:[^']|'')*')$/i
const DEFAULT_FUNCTION =
  /^(?:now\(\)|current_timestamp|current_date|current_time|localtimestamp|gen_random_uuid\(\)|uuid_generate_v4\(\)|nextval\('(?:[^']|'')*'(?:::regclass)?\))$/i

export const DDL_KINDS = [
  'create table',
  'add column',
  'drop table',
  'create index',
] as const

export function identifierProblem(name: string): string | null {
  if (name.trim().length === 0) return 'is empty.'
  if (name !== name.trim()) return 'has leading or trailing whitespace.'
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    return `is longer than ${MAX_IDENTIFIER_LENGTH} characters.`
  }
  // Control characters break quoting and make statement text unreadable.
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return 'contains a control character.'
  }
  return null
}

export function isSupportedColumnType(dataType: string): boolean {
  return COLUMN_TYPE_PATTERN.test(dataType.trim())
}

export function isAllowedDefault(value: string): boolean {
  const text = value.trim()
  return DEFAULT_LITERAL.test(text) || DEFAULT_FUNCTION.test(text)
}

/** Problems that make a column definition unbuildable. */
export function columnProblems(column: DdlColumnPlanDto): string[] {
  const problems: string[] = []
  const nameProblem = identifierProblem(column.name)
  if (nameProblem) problems.push(`Column name "${column.name}" ${nameProblem}`)
  if (!isSupportedColumnType(column.dataType)) {
    problems.push(
      `Column "${column.name}" has an unsupported type "${column.dataType}". Use a simple PostgreSQL type such as text, integer, numeric(10,2) or timestamptz.`,
    )
  }
  if (column.defaultValue !== undefined && column.defaultValue !== null) {
    const value = String(column.defaultValue)
    if (!isAllowedDefault(value)) {
      problems.push(
        `Column "${column.name}" has an unsupported default "${value}". Use a literal, null, now(), current_timestamp or gen_random_uuid().`,
      )
    }
  }
  if (column.primaryKey === true && column.nullable === true) {
    problems.push(`Column "${column.name}" is part of the primary key and cannot be nullable.`)
  }
  return problems
}

/** Problems that make an alter-column plan unbuildable. */
export function alterColumnProblems(column: DdlAlterColumnPlanDto): string[] {
  const problems: string[] = []
  const nameProblem = identifierProblem(column.name)
  if (nameProblem) problems.push(`Column name "${column.name}" ${nameProblem}`)
  if (column.dataType === undefined && column.nullable === undefined && column.defaultValue === undefined) {
    problems.push(`Choose a type, a nullability change or a default for "${column.name}".`)
  }
  if (column.dataType !== undefined && !isSupportedColumnType(column.dataType)) {
    problems.push(
      `Column "${column.name}" has an unsupported type "${column.dataType}". Use a simple PostgreSQL type such as text, integer, numeric(10,2) or timestamptz.`,
    )
  }
  if (column.defaultValue !== undefined && column.defaultValue !== null) {
    const value = String(column.defaultValue)
    if (!isAllowedDefault(value)) {
      problems.push(
        `Column "${column.name}" has an unsupported default "${value}". Use a literal, null, now(), current_timestamp or gen_random_uuid().`,
      )
    }
  }
  return problems
}

/** Problems that make the index definition unbuildable. */
export function indexProblems(index: DdlIndexPlanDto): string[] {
  const problems: string[] = []
  if (index.name !== undefined) {
    const nameProblem = identifierProblem(index.name)
    if (nameProblem) problems.push(`Index name "${index.name}" ${nameProblem}`)
  }
  if (index.columns.length === 0) problems.push('An index needs at least one column.')
  const seen = new Set<string>()
  for (const column of index.columns) {
    const nameProblem = identifierProblem(column)
    if (nameProblem) problems.push(`Index column "${column}" ${nameProblem}`)
    const key = column.toLowerCase()
    if (seen.has(key)) problems.push(`Column "${column}" appears twice in the index.`)
    seen.add(key)
  }
  return problems
}

export interface DdlValidation {
  problems: string[]
  warnings: string[]
}

/**
 * Validates a plan before the dialect builds statements. Warnings are shown in
 * the preview; problems abort with `invalid_request`.
 */
export function validateDdlPlan(plan: DdlPlanDto): DdlValidation {
  const problems: string[] = []
  const warnings: string[] = []

  const schemaProblem = identifierProblem(plan.schema)
  if (schemaProblem) problems.push(`Schema name "${plan.schema}" ${schemaProblem}`)
  const tableProblem = identifierProblem(plan.table)
  if (tableProblem) problems.push(`Table name "${plan.table}" ${tableProblem}`)

  if (plan.kind === 'create table') {
    if (plan.columns.length === 0) problems.push('A new table needs at least one column.')
    const seen = new Set<string>()
    let primaryKeys = 0
    for (const column of plan.columns) {
      const key = column.name.toLowerCase()
      if (seen.has(key)) problems.push(`Column "${column.name}" is defined twice.`)
      seen.add(key)
      problems.push(...columnProblems(column))
      if (column.primaryKey === true) primaryKeys += 1
    }
    if (primaryKeys > 1) {
      problems.push('Only one inline primary key column is supported; create a composite key with SQL instead.')
    }
    if (primaryKeys === 0) {
      warnings.push(
        'The table has no primary key, so its rows cannot be edited in the data grid.',
      )
    }
  }

  if (plan.kind === 'add column') {
    problems.push(...columnProblems(plan.column))
    if (plan.column.nullable !== true && (plan.column.defaultValue ?? null) === null) {
      warnings.push(
        `Adding NOT NULL without a default fails on a table that already has rows ("${plan.table}").`,
      )
    }
  }

  if (plan.kind === 'drop table') {
    warnings.push(
      `Dropping "${plan.schema}"."${plan.table}" removes its rows and affects dependent objects.`,
    )
  }

  if (plan.kind === 'create index') {
    problems.push(...indexProblems(plan.index))
  }

  if (plan.kind === 'alter column') {
    problems.push(...alterColumnProblems(plan.column))
    if (plan.column.nullable === false) {
      warnings.push(
        `Setting NOT NULL on "${plan.table}"."${plan.column.name}" fails when existing rows contain null.`,
      )
    }
    if (plan.column.dataType !== undefined) {
      warnings.push(
        `Changing the type of "${plan.column.name}" may rewrite the table and locks it for the duration.`,
      )
    }
  }

  return { problems, warnings }
}

/** The text a user must type before an irreversible DDL plan can run. */
export function expectedConfirmation(
  plan: DdlPlanDto,
  statements: readonly { risk: DdlRisk }[],
): string | null {
  if (plan.kind === 'drop table') return plan.table
  return statements.some((statement) => statement.risk === 'dangerous') ? 'CONFIRM' : null
}

/** True when the plan needs an extra typed confirmation. */
export function needsConfirmation(statements: readonly { risk: DdlRisk }[]): boolean {
  return statements.some((statement) => statement.risk === 'dangerous')
}
