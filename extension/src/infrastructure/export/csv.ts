import type { CellValue } from '@shared/protocol'

/** Field delimiter; RFC 4180 uses a comma, semicolons suit some locales. */
export type CsvDelimiter = ',' | ';' | '\t'

export interface CsvOptions {
  readonly delimiter?: CsvDelimiter
  readonly lineEnding?: '\n' | '\r\n'
}

const NEEDS_QUOTE = /[",\r\n\t]/

/**
 * Escapes one field following RFC 4180.
 *
 * `null` becomes an empty field: a NULL and an empty string are indistinguishable
 * in CSV, which is the usual expectation for spreadsheet imports.
 */
export function escapeCsvField(value: CellValue, delimiter: CsvDelimiter = ','): string {
  if (value === null) return ''

  const text = stringify(value)
  const needsQuotes = text.includes(delimiter) || NEEDS_QUOTE.test(text)
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Builds CSV text one row at a time so callers can stream a large export
 * without ever holding the whole file in memory.
 */
export class CsvWriter {
  private readonly delimiter: CsvDelimiter
  private readonly lineEnding: '\n' | '\r\n'

  constructor(options: CsvOptions = {}) {
    this.delimiter = options.delimiter ?? ','
    this.lineEnding = options.lineEnding ?? '\r\n'
  }

  writeRow(values: readonly CellValue[]): string {
    return values.map((value) => escapeCsvField(value, this.delimiter)).join(this.delimiter) + this.lineEnding
  }

  writeRows(rows: readonly (readonly CellValue[])[]): string {
    return rows.map((row) => this.writeRow(row)).join('')
  }
}

function stringify(value: Exclude<CellValue, null>): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return value
}
