export type ThemeMode = 'system' | 'light' | 'dark'

/** Auto follows the VS Code theme; the other two override it inside the webview. */
export const THEME_LABELS: Record<ThemeMode, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
}

const STORAGE_KEY = 'dataforge.theme'

export function readTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Sandboxed frames can deny storage; fall back to the editor theme.
  }
  return 'system'
}

export function applyTheme(mode: ThemeMode): void {
  if (mode === 'system') delete document.body.dataset.dfTheme
  else document.body.dataset.dfTheme = mode
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // A denied write only costs the preference across reloads.
  }
}

export function nextTheme(mode: ThemeMode): ThemeMode {
  if (mode === 'system') return 'light'
  return mode === 'light' ? 'dark' : 'system'
}
