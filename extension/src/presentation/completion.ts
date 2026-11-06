import * as vscode from 'vscode'

import type { RelationInfo } from '../domain/driver'
import type { SchemaService } from '../application/schema-service'
import type { Logger } from '../application/ports'

/** Reserved words offered before any metadata is loaded. */
export const SQL_KEYWORDS = [
  'select', 'from', 'where', 'group by', 'order by', 'limit', 'offset', 'having', 'distinct', 'as',
  'join', 'left join', 'right join', 'inner join', 'outer join', 'full join', 'cross join', 'on', 'using',
  'and', 'or', 'not', 'is null', 'is not null', 'in', 'exists', 'between', 'like', 'ilike', 'case', 'when',
  'then', 'else', 'end', 'cast', 'coalesce', 'nullif', 'union', 'union all', 'intersect', 'except',
  'insert into', 'values', 'returning', 'update', 'set', 'delete from', 'on conflict', 'do nothing',
  'create table', 'create view', 'alter table', 'drop table', 'drop view', 'truncate', 'primary key',
  'foreign key', 'references', 'not null', 'default', 'unique', 'check', 'index', 'schema',
  'begin', 'commit', 'rollback', 'explain', 'analyze', 'with', 'recursive', 'lateral', 'over', 'partition by',
  'count', 'sum', 'avg', 'min', 'max', 'array_agg', 'jsonb_agg', 'now', 'current_timestamp',
  'true', 'false', 'null',
] as const

export type CandidateKind = 'keyword' | 'schema' | 'relation' | 'column'

export interface CompletionCandidate {
  readonly label: string
  readonly kind: CandidateKind
}

export interface CandidateInput {
  readonly prefix: string
  readonly keywords: readonly string[]
  readonly schemas: readonly string[]
  readonly relations: readonly string[]
  readonly columns: readonly string[]
}

/**
 * Splits the text before the cursor into an optional `qualifier.prefix` pair.
 * Quoted identifiers are unquoted so candidates match the catalogue names.
 */
export function splitQualifier(textBeforeCursor: string): { qualifier?: string; prefix: string } {
  const tail = textBeforeCursor.slice(-160)
  const match = /(?:([\w$]+|"[^"]*")\.)?([\w$]*)$/.exec(tail)
  if (!match) return { prefix: '' }
  const rawQualifier = match[1]
  const prefix = match[2] ?? ''
  if (!rawQualifier) return { prefix }
  const qualifier = rawQualifier.startsWith('"') ? rawQualifier.slice(1, -1) : rawQualifier
  return { qualifier, prefix }
}

/** Case-insensitive prefix filter that keeps the first spelling of a duplicate. */
export function filterByPrefix(names: readonly string[], prefix: string, limit = 200): string[] {
  const needle = prefix.toLowerCase()
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    if (needle.length > 0 && !key.startsWith(needle)) continue
    seen.add(key)
    result.push(name)
    if (result.length >= limit) break
  }
  return result
}

/** Pure candidate list: keywords, then schemas, relations and columns. */
export function candidatesFor(input: CandidateInput): CompletionCandidate[] {
  const groups: readonly [CandidateKind, readonly string[]][] = [
    ['keyword', input.keywords],
    ['schema', input.schemas],
    ['relation', input.relations],
    ['column', input.columns],
  ]
  const result: CompletionCandidate[] = []
  for (const [kind, names] of groups) {
    for (const label of filterByPrefix(names, input.prefix)) result.push({ label, kind })
  }
  return result
}

export interface CompletionDeps {
  readonly schemas: SchemaService
  readonly logger: Logger
  /** Connection used by the most recent executed statement, when still open. */
  readonly activeConnectionId: () => string | undefined
}

const EMPTY = { schemas: [], relations: [], columns: [] } as const

/**
 * Completion for `sql` documents. It only reads metadata the schema cache has
 * already loaded, so typing never opens a connection on its own.
 */
export function createSqlCompletionProvider(deps: CompletionDeps): vscode.CompletionItemProvider {
  return {
    async provideCompletionItems(document, position) {
      const line = document.lineAt(position.line).text.slice(0, position.character)
      const { qualifier, prefix } = splitQualifier(line)
      if (prefix.length === 0 && !qualifier) return undefined

      const source = await resolveSource(deps, qualifier)
      const candidates = candidatesFor({ prefix, keywords: SQL_KEYWORDS, ...source })
      if (candidates.length === 0) return undefined

      const range = new vscode.Range(
        position.line,
        Math.max(0, position.character - prefix.length),
        position.line,
        position.character,
      )
      const items = candidates.map((candidate) => {
        const item = new vscode.CompletionItem(candidate.label, kindOf(candidate.kind))
        item.range = range
        if (candidate.kind !== 'keyword') item.detail = candidate.kind
        return item
      })
      return new vscode.CompletionList(items, true)
    },
  }
}

async function resolveSource(
  deps: CompletionDeps,
  qualifier: string | undefined,
): Promise<{ schemas: readonly string[]; relations: readonly string[]; columns: readonly string[] }> {
  const connectionId = deps.activeConnectionId()
  if (!connectionId) return EMPTY

  try {
    const schemas = (await deps.schemas.cachedSchemas(connectionId)) ?? []
    const loaded: { schema: string; relations: readonly RelationInfo[] }[] = []
    for (const schema of schemas.slice(0, 10)) {
      const cached = deps.schemas.cachedRelations(connectionId, schema)
      if (!cached) continue
      loaded.push({ schema, relations: await cached })
    }

    if (!qualifier) {
      return { schemas, relations: loaded.flatMap((entry) => entry.relations.map((relation) => relation.name)), columns: [] }
    }

    const schemaMatch = loaded.find((entry) => entry.schema.toLowerCase() === qualifier.toLowerCase())
    if (schemaMatch) {
      return { schemas: [], relations: schemaMatch.relations.map((relation) => relation.name), columns: [] }
    }

    for (const entry of loaded) {
      const relation = entry.relations.find((item) => item.name.toLowerCase() === qualifier.toLowerCase())
      if (!relation) continue
      const cached = deps.schemas.cachedColumns(connectionId, entry.schema, relation.name)
      const columns = cached ? (await cached).map((column) => column.name) : []
      return { schemas: [], relations: [], columns }
    }
    return EMPTY
  } catch (error) {
    deps.logger.warn(`SQL completion failed: ${error instanceof Error ? error.message : String(error)}`)
    return EMPTY
  }
}

function kindOf(kind: CandidateKind): vscode.CompletionItemKind {
  switch (kind) {
    case 'schema':
      return vscode.CompletionItemKind.Module
    case 'relation':
      return vscode.CompletionItemKind.Struct
    case 'column':
      return vscode.CompletionItemKind.Field
    default:
      return vscode.CompletionItemKind.Keyword
  }
}
