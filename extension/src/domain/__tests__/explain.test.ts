import { describe, expect, it } from 'vitest'

import { parsePlanTree } from '../explain'

const PLAN = [
  {
    Plan: {
      'Node Type': 'Nested Loop',
      'Join Type': 'Inner',
      'Startup Cost': 0.15,
      'Total Cost': 31.2,
      'Plan Rows': 24,
      'Plan Width': 42,
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          'Alias': 'o',
          'Filter': "(status = 'paid')",
          'Startup Cost': 0,
          'Total Cost': 24.5,
          'Plan Rows': '24',
          'Plan Width': 42,
        },
        {
          'Node Type': 'Index Scan',
          'Relation Name': 'customers',
          'Index Name': 'customers_pkey',
          'Startup Cost': 0.15,
          'Total Cost': 6.7,
          'Plan Rows': 1,
          'Plan Width': 8,
          'Actual Rows': 3,
          'Actual Total Time': 0.04,
          'Loops': 1,
        },
      ],
    },
  },
]

describe('parsePlanTree', () => {
  it('parses the JSON text returned by EXPLAIN (FORMAT JSON)', () => {
    const root = parsePlanTree(JSON.stringify(PLAN))
    expect(root?.nodeType).toBe('Nested Loop')
    expect(root?.joinType).toBe('Inner')
    expect(root?.totalCost).toBe(31.2)
    expect(root?.children).toHaveLength(2)
    expect(root?.children[0]).toMatchObject({
      nodeType: 'Seq Scan',
      relation: 'orders',
      alias: 'o',
      filter: "(status = 'paid')",
      planRows: 24,
    })
    expect(root?.children[1]).toMatchObject({
      nodeType: 'Index Scan',
      indexName: 'customers_pkey',
      actualRows: 3,
      actualTotalTime: 0.04,
      loops: 1,
    })
  })

  it('accepts the plan object directly and unwraps Plan', () => {
    const root = parsePlanTree({ Plan: { 'Node Type': 'Result' } } as never)
    expect(root).toEqual({ nodeType: 'Result', children: [] })
  })

  it('returns undefined when the value is not a plan', () => {
    expect(parsePlanTree(undefined)).toBeUndefined()
    expect(parsePlanTree('not json')).toBeUndefined()
    expect(parsePlanTree('42')).toBeUndefined()
    expect(parsePlanTree(null)).toBeUndefined()
  })

  it('skips non-numeric cost fields', () => {
    const root = parsePlanTree(
      JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', 'Total Cost': 'unknown', 'Plan Rows': null } }]),
    )
    expect(root?.totalCost).toBeUndefined()
    expect(root?.planRows).toBeUndefined()
  })
})
