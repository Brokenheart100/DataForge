/**
 * Minimal typing for `pg-cursor`, which ships no declarations.
 *
 * Only the surface DataForge uses is described; extend it when a new call site
 * needs more.
 */
declare module 'pg-cursor' {
  class Cursor {
    constructor(text: string, values?: readonly unknown[], config?: { rowMode?: 'array' })
    read(rowCount: number): Promise<unknown[][]>
    close(): Promise<void>
  }

  export default Cursor
}
