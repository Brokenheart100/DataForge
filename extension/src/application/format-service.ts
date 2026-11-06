import { format } from 'sql-formatter'

import { DataForgeError } from '../domain/errors'

export interface FormatOptions {
  readonly tabWidth?: number
  readonly keywordCase?: 'preserve' | 'upper' | 'lower'
}

const DEFAULTS: Required<FormatOptions> = { tabWidth: 2, keywordCase: 'upper' }

/** Formats PostgreSQL SQL; throws {@link DataForgeError} for empty input. */
export function formatSql(sql: string, options: FormatOptions = {}): string {
  if (!sql.trim()) throw new DataForgeError('invalid_request', 'Nothing to format: the selection is empty.')
  return format(sql, {
    language: 'postgresql',
    tabWidth: options.tabWidth ?? DEFAULTS.tabWidth,
    keywordCase: options.keywordCase ?? DEFAULTS.keywordCase,
  })
}

/**
 * Formats without ever throwing, so a formatter bug cannot destroy the buffer.
 * `null` means "leave the document untouched".
 */
export function safeFormatSql(sql: string, formatter: (input: string) => string = formatSql): string | null {
  try {
    return formatter(sql)
  } catch {
    return null
  }
}

export class FormatService {
  format(sql: string, options?: FormatOptions): string {
    return formatSql(sql, options)
  }
}
