import { describe, expect, it } from 'vitest'

import {
  buildCountQuery,
  buildDelete,
  buildInsert,
  buildOrderBy,
  buildPageQuery,
  buildUpdate,
  buildWhere,
  quoteIdentifier,
  quoteQualified,
} from '../sql-builder'
import { DataForgeError } from '../../../domain/errors'

function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof DataForgeError) return error.message
    throw error
  }
  throw new Error('expected the call to throw')
}

describe('quoteIdentifier', () => {
  it('quotes plain and mixed-case names', () => {
    expect(quoteIdentifier('orders')).toBe('"orders"')
    expect(quoteIdentifier('Order Lines')).toBe('"Order Lines"')
  })

  it('escapes embedded double quotes', () => {
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"')
  })

  it('rejects empty, NUL and over-long identifiers', () => {
    expect(messageOf(() => quoteIdentifier(''))).toContain('empty identifier')
    expect(messageOf(() => quoteIdentifier('bad\0name'))).toContain('NUL')
    expect(messageOf(() => quoteIdentifier('x'.repeat(64)))).toContain('longer than 63')
  })

  it('quotes a qualified name', () => {
    expect(quoteQualified('public', 'orders')).toBe('"public"."orders"')
  })
})

describe('buildCountQuery', () => {
  it('counts without parameters', () => {
    expect(buildCountQuery('public', 'orders')).toEqual({
      text: 'select count(*)::bigint as total from "public"."orders"',
      values: [],
    })
  })
})

describe('parameterised writes', () => {
  it('binds insert values in column order', () => {
    const statement = buildInsert('public', 'orders', [
      { column: 'name', value: 'first' },
      { column: 'total', value: 12 },
    ])
    expect(statement.text).toBe('insert into "public"."orders" ("name", "total") values ($1, $2)')
    expect(statement.values).toEqual(['first', 12])
  })

  it('adds a returning clause for requested columns', () => {
    const statement = buildInsert('public', 'orders', [{ column: 'name', value: 'x' }], ['id'])
    expect(statement.text).toContain('returning "id"')
  })

  it('rejects an insert without columns', () => {
    expect(messageOf(() => buildInsert('public', 'orders', []))).toContain('at least one column')
  })

  it('binds updates before the identity predicate', () => {
    const statement = buildUpdate(
      'public',
      'orders',
      [{ column: 'name', value: 'changed' }],
      [
        { column: 'id', value: 7 },
        { column: 'tenant', value: 'acme' },
      ],
      '42',
      ['id'],
    )
    expect(statement.text).toBe(
      'update "public"."orders" set "name" = $1 where "id" = $2 and "tenant" = $3 and xmin::text = $4 returning "id"',
    )
    expect(statement.values).toEqual(['changed', 7, 'acme', '42'])
  })

  it('omits the version predicate when the version is unknown', () => {
    const statement = buildUpdate('public', 'orders', [{ column: 'name', value: 'changed' }], [{ column: 'id', value: 1 }], null)
    expect(statement.text).not.toContain('xmin')
    expect(statement.values).toEqual(['changed', 1])
  })

  it('builds a parameterised delete', () => {
    const statement = buildDelete('public', 'orders', [{ column: 'id', value: 5 }], '9', ['id'])
    expect(statement.text).toBe('delete from "public"."orders" where "id" = $1 and xmin::text = $2 returning "id"')
    expect(statement.values).toEqual([5, '9'])
  })

  it('rejects a write without an identity predicate', () => {
    expect(messageOf(() => buildWhere([], null))).toContain('without a primary key')
  })

  it('offsets the predicate placeholders', () => {
    const where = buildWhere([{ column: 'id', value: 3 }], '11', 2)
    expect(where.clause).toBe('"id" = $3 and xmin::text = $4')
    expect(where.values).toEqual([3, '11'])
  })
})

describe('ordering', () => {
  it('accepts known columns in both directions', () => {
    expect(
      buildOrderBy(
        [
          { column: 'name', direction: 'asc' },
          { column: 'id', direction: 'desc' },
        ],
        ['id', 'name'],
      ),
    ).toBe('order by "name" asc, "id" desc')
  })

  it('rejects a column that is not selected', () => {
    expect(messageOf(() => buildOrderBy([{ column: 'secret', direction: 'asc' }], ['id']))).toContain('unknown column "secret"')
  })

  it('returns no clause for an empty sort', () => {
    expect(buildOrderBy([], ['id'])).toBe('')
  })
})

describe('buildPageQuery', () => {
  it('selects columns plus xmin and binds paging values', () => {
    const statement = buildPageQuery({
      schema: 'public',
      relation: 'orders',
      columns: ['id', 'name'],
      orderBy: [{ column: 'id', direction: 'asc' }],
      limit: 50,
      offset: 100,
      withVersion: true,
    })
    expect(statement.text).toBe(
      'select "id", "name", xmin::text from "public"."orders" order by "id" asc limit $1 offset $2',
    )
    expect(statement.values).toEqual([50, 100])
  })

  it('omits xmin for relations without a row version', () => {
    const statement = buildPageQuery({
      schema: 'public',
      relation: 'orders_view',
      columns: ['id'],
      orderBy: [],
      limit: 10,
      offset: 0,
    })
    expect(statement.text).toBe('select "id" from "public"."orders_view" limit $1 offset $2')
  })

  it('clamps negative paging values', () => {
    const statement = buildPageQuery({
      schema: 'public',
      relation: 'orders',
      columns: ['id'],
      orderBy: [],
      limit: -5,
      offset: Number.NaN,
    })
    expect(statement.values).toEqual([0, 0])
  })

  it('rejects a page without columns', () => {
    expect(
      messageOf(() =>
        buildPageQuery({ schema: 'public', relation: 'orders', columns: [], orderBy: [], limit: 10, offset: 0 }),
      ),
    ).toContain('at least one selected column')
  })
})
