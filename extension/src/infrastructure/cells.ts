import type { CellValue } from '@shared/protocol'

/**
 * Normalises a driver-specific cell into the JSON-safe shape the protocol
 * promises. Shared by every adapter so the webview only ever sees one dialect
 * of values, no matter which database produced them.
 */
export function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) {
    const head = value.subarray(0, 32).toString('hex')
    return `\\x${head}${value.length > 32 ? '…' : ''}`
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
