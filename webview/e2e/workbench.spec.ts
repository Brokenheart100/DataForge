import { test, expect } from '@playwright/test'

const DEMO_NOTICE = 'Demo data — no database is connected.'

function collectPageErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test('opens the demo relation and renders the data grid', async ({ page }) => {
  const errors = collectPageErrors(page)

  // The demo host pushes an `editor.prefill` event shortly after the handshake,
  // which switches the workbench to the Data tab and loads public.orders.
  await page.goto('/')
  await expect(page.getByRole('gridcell', { name: 'Customer 1', exact: true })).toBeVisible()
  await expect(page.getByText('24 row(s) · page 1 / 1')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible()

  expect(errors).toEqual([])
})

test('runs a statement and shows the result rows', async ({ page }) => {
  const errors = collectPageErrors(page)

  await page.goto('/')
  await expect(page.getByRole('gridcell', { name: 'Customer 1', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'SQL', exact: true }).click()
  await page.getByRole('button', { name: /^Run/ }).click()

  await expect(page.getByText('24 rows')).toBeVisible()
  await expect(page.getByText(DEMO_NOTICE)).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'customer' })).toBeVisible()

  expect(errors).toEqual([])
})

test('starts and commits a transaction', async ({ page }) => {
  const errors = collectPageErrors(page)

  await page.goto('/')
  await expect(page.getByRole('gridcell', { name: 'Customer 1', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'SQL', exact: true }).click()
  await page.getByRole('button', { name: 'Begin transaction' }).click()
  await expect(page.getByText('in transaction')).toBeVisible()

  await page.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Begin transaction' })).toBeVisible()

  expect(errors).toEqual([])
})
