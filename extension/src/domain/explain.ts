import type { CellValue, ExplainPlanNodeDto } from '@shared/protocol'

/**
 * PostgreSQL returns `EXPLAIN (FORMAT JSON)` as a JSON value: either an object
 * (`Plan` plus timings) or an array with one such object. `toCellValue` turns it
 * into a string before it reaches the host, so both shapes are accepted here.
 */
export function parsePlanTree(value: CellValue | undefined): ExplainPlanNodeDto | undefined {
  if (value === undefined || value === null) return undefined
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!isRecord(entry)) return undefined
  const plan = isRecord(entry.Plan) ? entry.Plan : entry
  return toNode(plan)
}

function toNode(raw: Record<string, unknown>): ExplainPlanNodeDto {
  const node: ExplainPlanNodeDto = {
    nodeType: text(raw['Node Type']) ?? 'Unknown node',
    children: [],
  }
  const relation = text(raw['Relation Name'])
  if (relation !== undefined) node.relation = relation
  const alias = text(raw['Alias'])
  if (alias !== undefined) node.alias = alias
  const indexName = text(raw['Index Name'])
  if (indexName !== undefined) node.indexName = indexName
  const joinType = text(raw['Join Type'])
  if (joinType !== undefined) node.joinType = joinType
  const filter = text(raw.Filter) ?? text(raw['Index Cond']) ?? text(raw['Hash Cond'])
  if (filter !== undefined) node.filter = filter

  assignNumber(node, 'startupCost', raw['Startup Cost'])
  assignNumber(node, 'totalCost', raw['Total Cost'])
  assignNumber(node, 'planRows', raw['Plan Rows'])
  assignNumber(node, 'planWidth', raw['Plan Width'])
  assignNumber(node, 'actualRows', raw['Actual Rows'])
  assignNumber(node, 'actualTotalTime', raw['Actual Total Time'])
  assignNumber(node, 'loops', raw.Loops)

  const children = raw.Plans
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isRecord(child)) node.children.push(toNode(child))
    }
  }
  return node
}

type NumericKey = 'startupCost' | 'totalCost' | 'planRows' | 'planWidth' | 'actualRows' | 'actualTotalTime' | 'loops'

function assignNumber(node: ExplainPlanNodeDto, key: NumericKey, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    node[key] = value
    return
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) node[key] = parsed
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
