import { describe, expect, it } from 'vitest'

import { CsvWriter, escapeCsvField } from '../csv'

describe('escapeCsvField', () => {
  it('keeps plain values unquoted', () => {
    expect(escapeCsvField('acme')).toBe('acme')
    expect(escapeCsvField(42)).toBe('42')
    expect(escapeCsvField(true)).toBe('true')
    expect(escapeCsvField(false)).toBe('false')
  })

  it('writes NULL as an empty field', () => {
    expect(escapeCsvField(null)).toBe('')
  })

  it('doubles embedded quotes', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField('"')).toBe('""""')
  })

  it('quotes values containing the delimiter', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('a;b', ';')).toBe('"a;b"')
    expect(escapeCsvField('a\tb', '\t')).toBe('"a\tb"')
    expect(escapeCsvField('a;b')).toBe('a;b')
  })

  it('quotes values with line breaks', () => {
    expect(escapeCsvField('line\nbreak')).toBe('"line\nbreak"')
    expect(escapeCsvField('line\r\nbreak')).toBe('"line\r\nbreak"')
  })

  it('keeps spaces unquoted', () => {
    expect(escapeCsvField(' padded ')).toBe(' padded ')
  })
})

describe('CsvWriter', () => {
  it('joins fields with a comma and rows with CRLF', () => {
    const writer = new CsvWriter()
    expect(writer.writeRow(['id', 'name'])).toBe('id,name\r\n')
    expect(writer.writeRow([1, null])).toBe('1,\r\n')
  })

  it('supports a custom delimiter and line ending', () => {
    const writer = new CsvWriter({ delimiter: ';', lineEnding: '\n' })
    expect(writer.writeRow(['a', 'b'])).toBe('a;b\n')
  })

  it('writes several rows in one call', () => {
    const writer = new CsvWriter({ lineEnding: '\n' })
    expect(writer.writeRows([[1, 'a'], [2, 'b']])).toBe('1,a\n2,b\n')
  })

  it('escapes each field independently', () => {
    const writer = new CsvWriter({ lineEnding: '\n' })
    expect(writer.writeRow(['a,b', 'say "hi"', null])).toBe('"a,b","say ""hi""",\n')
  })
})
