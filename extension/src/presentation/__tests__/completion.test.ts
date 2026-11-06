import { describe, expect, it } from 'vitest'

import { candidatesFor, filterByPrefix, splitQualifier } from '../completion'

describe('splitQualifier', () => {
  it('returns the bare prefix', () => {
    expect(splitQualifier('select * from ord')).toEqual({ prefix: 'ord' })
  })

  it('recognises a quoted qualifier and empty prefix', () => {
    expect(splitQualifier('select * from "public".')).toEqual({ qualifier: 'public', prefix: '' })
  })

  it('keeps the prefix after a qualifier', () => {
    expect(splitQualifier('select id from public.custo')).toEqual({ qualifier: 'public', prefix: 'custo' })
  })

  it('ignores trailing punctuation', () => {
    expect(splitQualifier('select * from t where id = 1 ')).toEqual({ prefix: '' })
    expect(splitQualifier('select t.')).toEqual({ qualifier: 't', prefix: '' })
  })
})

describe('filterByPrefix', () => {
  it('filters case-insensitively and keeps the first spelling', () => {
    expect(filterByPrefix(['Orders', 'orders', 'order_items', 'customers'], 'ORD')).toEqual(['Orders', 'order_items'])
  })

  it('returns everything for an empty prefix', () => {
    expect(filterByPrefix(['a', 'b'], '')).toEqual(['a', 'b'])
  })

  it('respects the limit', () => {
    expect(filterByPrefix(['a1', 'a2', 'a3'], 'a', 2)).toEqual(['a1', 'a2'])
  })
})

describe('candidatesFor', () => {
  const input = {
    prefix: 'o',
    keywords: ['order by', 'on'],
    schemas: ['public'],
    relations: ['orders', 'order_items'],
    columns: ['order_id', 'owner'],
  }

  it('returns matching candidates grouped by kind', () => {
    expect(candidatesFor(input)).toEqual([
      { label: 'order by', kind: 'keyword' },
      { label: 'on', kind: 'keyword' },
      { label: 'orders', kind: 'relation' },
      { label: 'order_items', kind: 'relation' },
      { label: 'order_id', kind: 'column' },
      { label: 'owner', kind: 'column' },
    ])
  })

  it('drops candidates that do not match the prefix', () => {
    const labels = candidatesFor({ ...input, prefix: 'own' }).map((candidate) => candidate.label)
    expect(labels).toEqual(['owner'])
  })

  it('returns nothing when the prefix matches nothing', () => {
    expect(candidatesFor({ ...input, prefix: 'zzz' })).toEqual([])
  })
})
