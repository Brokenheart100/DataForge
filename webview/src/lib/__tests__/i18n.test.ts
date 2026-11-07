import { beforeEach, describe, expect, it } from 'vitest'

import { activeLocale, localeMode, nextLocaleMode, setHostLocale, setLocaleMode, t } from '../i18n'

describe('webview i18n', () => {
  beforeEach(() => {
    localStorage.clear()
    setLocaleMode('auto')
    setHostLocale('en-US')
  })

  it('defaults to Auto and English without a Chinese host locale', () => {
    expect(localeMode.value).toBe('auto')
    expect(activeLocale.value).toBe('en')
  })

  it('translates and interpolates values', () => {
    setLocaleMode('en')
    expect(t('app.connectedCount', { count: 2 })).toBe('2 connected')
    setLocaleMode('zh')
    expect(t('app.connectedCount', { count: 2 })).toBe('已连接 2 个')
    expect(t('toast.openedRelation', { name: 'public.orders' })).toBe('已打开 public.orders。')
  })

  it('follows the host language in Auto mode', () => {
    setHostLocale('zh-cn')
    expect(activeLocale.value).toBe('zh')
    setLocaleMode('en')
    expect(activeLocale.value).toBe('en')
  })

  it('persists the chosen mode and sets the document language', () => {
    setLocaleMode('zh')
    expect(localStorage.getItem('dataforge.locale')).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    setLocaleMode('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('cycles Auto, English and Chinese', () => {
    expect(nextLocaleMode('auto')).toBe('en')
    expect(nextLocaleMode('en')).toBe('zh')
    expect(nextLocaleMode('zh')).toBe('auto')
  })
})
