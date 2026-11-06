import { describe, expect, it } from 'vitest'

import { formatSql, safeFormatSql } from '../format-service'

describe('formatSql', () => {
  it('uppercases keywords and indents the statement', () => {
    const formatted = formatSql('select id,name from public.orders where id = 1')
    expect(formatted).toContain('SELECT')
    expect(formatted).toContain('\n  id,')
    expect(formatted).toContain('public.orders')
    expect(formatted).toContain('WHERE')
  })

  it('rejects empty input', () => {
    expect(() => formatSql('   ')).toThrowError(/Nothing to format/)
  })
})

describe('safeFormatSql', () => {
  it('returns null instead of throwing when the formatter fails', () => {
    const failing = (): string => {
      throw new Error('boom')
    }
    expect(safeFormatSql('select 1', failing)).toBeNull()
  })

  it('never mutates the source when formatting fails', () => {
    const source = 'select 1'
    safeFormatSql(source, () => {
      throw new Error('boom')
    })
    expect(source).toBe('select 1')
  })
})
