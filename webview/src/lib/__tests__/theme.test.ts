import { beforeEach, describe, expect, it } from 'vitest'

import { applyTheme, nextTheme, readTheme, saveTheme } from '../theme'

describe('webview theme preference', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.body.dataset.dfTheme
  })

  it('defaults to following the editor theme', () => {
    expect(readTheme()).toBe('system')
  })

  it('persists and restores a choice', () => {
    saveTheme('light')
    expect(readTheme()).toBe('light')
    saveTheme('dark')
    expect(readTheme()).toBe('dark')
  })

  it('applies explicit themes and clears the override for system', () => {
    applyTheme('light')
    expect(document.body.dataset.dfTheme).toBe('light')
    applyTheme('dark')
    expect(document.body.dataset.dfTheme).toBe('dark')
    applyTheme('system')
    expect(document.body.dataset.dfTheme).toBeUndefined()
  })

  it('cycles auto, light, dark and back', () => {
    expect(nextTheme('system')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
  })
})
