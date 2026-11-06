import { describe, expect, it } from 'vitest'

import type { DdlColumnPlanDto, DdlPlanDto } from '@shared/protocol'

import {
  columnProblems,
  expectedConfirmation,
  identifierProblem,
  indexProblems,
  isAllowedDefault,
  isSupportedColumnType,
  needsConfirmation,
  validateDdlPlan,
} from '../ddl'

function column(overrides: Partial<DdlColumnPlanDto> = {}): DdlColumnPlanDto {
  return { name: 'id', dataType: 'integer', nullable: false, primaryKey: true, ...overrides }
}

function createTable(overrides: Partial<Extract<DdlPlanDto, { kind: 'create table' }>> = {}): DdlPlanDto {
  return {
    kind: 'create table',
    connectionId: 'c1',
    schema: 'public',
    table: 'orders',
    columns: [column()],
    ...overrides,
  }
}

describe('identifierProblem', () => {
  it('accepts ordinary and quoted identifiers', () => {
    expect(identifierProblem('orders')).toBeNull()
    expect(identifierProblem('Order Items')).toBeNull()
    expect(identifierProblem('order"items')).toBeNull()
  })

  it('rejects empty, padded, too long and control-character names', () => {
    expect(identifierProblem('   ')).toContain('empty')
    expect(identifierProblem(' orders')).toContain('whitespace')
    expect(identifierProblem('x'.repeat(64))).toContain('63')
    expect(identifierProblem('bad\u0000name')).toContain('control')
  })
})

describe('type and default checks', () => {
  it('accepts simple PostgreSQL types', () => {
    expect(isSupportedColumnType('text')).toBe(true)
    expect(isSupportedColumnType('numeric(10,2)')).toBe(true)
    expect(isSupportedColumnType('timestamp with time zone')).toBe(true)
    expect(isSupportedColumnType('text[]')).toBe(true)
  })

  it('rejects schema-qualified and free-form types', () => {
    expect(isSupportedColumnType('public.mytype')).toBe(false)
    expect(isSupportedColumnType('text; drop table users')).toBe(false)
    expect(isSupportedColumnType('')).toBe(false)
  })

  it('accepts literals and allow-listed functions only', () => {
    expect(isAllowedDefault('42')).toBe(true)
    expect(isAllowedDefault('12.5')).toBe(true)
    expect(isAllowedDefault("'draft'")).toBe(true)
    expect(isAllowedDefault('now()')).toBe(true)
    expect(isAllowedDefault('gen_random_uuid()')).toBe(true)
    expect(isAllowedDefault('CURRENT_TIMESTAMP')).toBe(true)
    expect(isAllowedDefault('(select 1)')).toBe(false)
    expect(isAllowedDefault("'; drop table users; --")).toBe(false)
  })
})

describe('columnProblems', () => {
  it('accepts a valid column', () => {
    expect(columnProblems(column())).toEqual([])
  })

  it('reports a nullable primary key', () => {
    expect(columnProblems(column({ nullable: true }))).toEqual([
      'Column "id" is part of the primary key and cannot be nullable.',
    ])
  })

  it('reports unsupported type and default', () => {
    const problems = columnProblems(column({ dataType: 'mode; drop', defaultValue: '(select 1)' }))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('unsupported type')
    expect(problems[1]).toContain('unsupported default')
  })
})

describe('indexProblems', () => {
  it('needs columns and rejects duplicates', () => {
    expect(indexProblems({ columns: [] })[0]).toContain('at least one column')
    expect(indexProblems({ columns: ['a', 'A'] })).toContain('Column "A" appears twice in the index.')
    expect(indexProblems({ columns: ['a', 'b'], name: '' })[0]).toContain('empty')
  })
})

describe('validateDdlPlan', () => {
  it('accepts a table with a primary key', () => {
    const result = validateDdlPlan(createTable())
    expect(result.problems).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('warns about a missing primary key', () => {
    const result = validateDdlPlan(createTable({ columns: [column({ primaryKey: false })] }))
    expect(result.warnings[0]).toContain('no primary key')
  })

  it('rejects duplicates and multiple inline primary keys', () => {
    const result = validateDdlPlan(
      createTable({
        columns: [column(), column({ name: 'ID' }), column({ name: 'second', primaryKey: true })],
      }),
    )
    expect(result.problems).toContain('Column "ID" is defined twice.')
    expect(result.problems.some((problem) => problem.includes('composite key'))).toBe(true)
  })

  it('warns when adding NOT NULL without a default', () => {
    const plan: DdlPlanDto = {
      kind: 'add column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'total', dataType: 'numeric(10,2)', nullable: false },
    }
    const result = validateDdlPlan(plan)
    expect(result.problems).toEqual([])
    expect(result.warnings[0]).toContain('NOT NULL without a default')
  })

  it('warns when dropping a table', () => {
    const plan: DdlPlanDto = {
      kind: 'drop table',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
    }
    expect(validateDdlPlan(plan).warnings[0]).toContain('removes its rows')
  })

  it('checks the target identifiers first', () => {
    const result = validateDdlPlan(createTable({ schema: '', table: 'orders ' }))
    expect(result.problems).toHaveLength(2)
    expect(result.problems[0]).toContain('Schema name')
    expect(result.problems[1]).toContain('Table name')
  })

  it('validates alter column changes', () => {
    const unchanged: DdlPlanDto = {
      kind: 'alter column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'total' },
    }
    expect(validateDdlPlan(unchanged).problems[0]).toContain('Choose a type')

    const nulls: DdlPlanDto = {
      kind: 'alter column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'total', nullable: false },
    }
    const result = validateDdlPlan(nulls)
    expect(result.problems).toEqual([])
    expect(result.warnings.some((warning) => warning.includes('contain null'))).toBe(true)

    const changedType: DdlPlanDto = {
      kind: 'alter column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'total', dataType: 'text', defaultValue: 'none' },
    }
    expect(validateDdlPlan(changedType).problems[0]).toContain('unsupported default')
  })
})

describe('confirmation rules', () => {
  it('drops need the table name, other dangerous plans need CONFIRM', () => {
    const drop: DdlPlanDto = {
      kind: 'drop table',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
    }
    expect(expectedConfirmation(drop, [{ risk: 'dangerous' }])).toBe('orders')

    const add: DdlPlanDto = {
      kind: 'add column',
      connectionId: 'c1',
      schema: 'public',
      table: 'orders',
      column: { name: 'total', dataType: 'numeric', nullable: false },
    }
    expect(expectedConfirmation(add, [{ risk: 'dangerous' }])).toBe('CONFIRM')
  })

  it('safe and caution statements need nothing', () => {
    expect(expectedConfirmation(createTable(), [{ risk: 'safe' }])).toBeNull()
    expect(needsConfirmation([{ risk: 'safe' }, { risk: 'caution' }])).toBe(false)
    expect(needsConfirmation([{ risk: 'caution' }, { risk: 'dangerous' }])).toBe(true)
  })
})
