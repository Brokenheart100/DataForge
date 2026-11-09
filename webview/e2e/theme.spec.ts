import { test, expect, type Page } from '@playwright/test'

/**
 * The explicit Light/Dark choice must not inherit the editor's foreground when
 * the two disagree. Before the fix, Light inside a dark editor rendered #ccc
 * text on #f4f1e9 paper, which is effectively invisible.
 */
async function fakeEditorTheme(page: Page, kind: 'dark' | 'light'): Promise<void> {
  await page.evaluate((mode) => {
    const body = document.body
    body.classList.remove('vscode-dark', 'vscode-light')
    body.classList.add(mode === 'dark' ? 'vscode-dark' : 'vscode-light')
    const colors =
      mode === 'dark'
        ? {
            '--vscode-foreground': '#cccccc',
            '--vscode-editor-background': '#1e1e1e',
            '--vscode-editor-foreground': '#d4d4d4',
            '--vscode-input-background': '#3c3c3c',
            '--vscode-input-foreground': '#cccccc',
          }
        : {
            '--vscode-foreground': '#333333',
            '--vscode-editor-background': '#ffffff',
            '--vscode-editor-foreground': '#333333',
            '--vscode-input-background': '#ffffff',
            '--vscode-input-foreground': '#333333',
          }
    for (const [name, value] of Object.entries(colors)) body.style.setProperty(name, value)
  }, kind)
}

async function contrast(page: Page, selector: string): Promise<number> {
  return page.evaluate((target) => {
    const element = document.querySelector(target)
    if (!element) throw new Error(`Missing ${target}`)
    const style = getComputedStyle(element)
    const parse = (value: string): number[] =>
      value.match(/rgba?\(([^)]+)\)/)![1].split(',').slice(0, 3).map((part) => Number(part.trim()))
    const luminance = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((value) => {
        const channel = value / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const foreground = luminance(parse(style.color))
    const background = luminance(parse(style.backgroundColor))
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  }, selector)
}

test('explicit Light/Dark stays readable regardless of the editor theme', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('gridcell', { name: 'Customer 1', exact: true })).toBeVisible()

  await fakeEditorTheme(page, 'dark')
  const themeButton = page.locator('header button[title^="Theme"]')
  await themeButton.click()
  await expect(themeButton).toHaveText(/Light/)

  await expect(page.locator('body')).toHaveCSS('color', 'rgb(20, 18, 26)')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 241, 233)')
  expect(await contrast(page, 'body')).toBeGreaterThan(7)
  expect(await contrast(page, '.df-input')).toBeGreaterThan(7)

  await fakeEditorTheme(page, 'light')
  await themeButton.click()
  await expect(themeButton).toHaveText(/Dark/)

  await expect(page.locator('body')).toHaveCSS('color', 'rgb(244, 240, 230)')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 22, 28)')
  expect(await contrast(page, 'body')).toBeGreaterThan(7)
})
