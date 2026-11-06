import { describe, expect, it } from 'vitest'

import { createProfile } from '../../../domain/connection'
import { isReadOnlySql, SqlServerDriver } from '../sqlserver-driver'

describe('isReadOnlySql', () => {
  it('accepts plain selects and CTEs', () => {
    expect(isReadOnlySql('select 1')).toBe(true)
    expect(isReadOnlySql('  -- comment\nselect * from sys.tables')).toBe(true)
    expect(isReadOnlySql('/* note */ with x as (select 1 as n) select n from x')).toBe(true)
  })

  it('rejects writes, exec and SELECT INTO', () => {
    expect(isReadOnlySql('insert into t values (1)')).toBe(false)
    expect(isReadOnlySql('update t set x = 1')).toBe(false)
    expect(isReadOnlySql('delete from t')).toBe(false)
    expect(isReadOnlySql('exec sp_who')).toBe(false)
    expect(isReadOnlySql('select * into copy from t')).toBe(false)
  })

  it('is enforced before the driver ever opens a socket', async () => {
    const driver = new SqlServerDriver(
      {
        profile: createProfile('mssql', {
          kind: 'sqlserver',
          host: 'localhost',
          database: 'master',
          user: 'sa',
          readOnly: true,
        }, Date.now()),
        credentials: { password: 'secret' },
      },
      { connectTimeoutMs: 50, statementTimeoutMs: 50 },
    )

    await expect(driver.query({ sql: 'drop table t', maxRows: 10 })).rejects.toMatchObject({
      code: 'invalid_request',
    })
  })
})
