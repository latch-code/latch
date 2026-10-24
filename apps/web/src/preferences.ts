import { useSyncExternalStore } from 'react'

/** Per-viewer conveniences. Browser storage can be missing or throw; every read has a default. */
export type ThemePreference = 'system' | 'light' | 'dark'
export type SendKey = 'enter' | 'mod-enter'
export interface Preferences {
  theme: ThemePreference
  /** Desktop only; touch keyboards always insert a newline on Enter. */
  sendKey: SendKey
  /** Whether the desktop inspector pane is open. */
  inspector: boolean
}

const KEY = 'harness-link.preferences'
const defaults: Preferences = { theme: 'system', sendKey: 'enter', inspector: false }

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* A missing preference only resets to its default. */
  }
}

export function parsePreferences(raw: string | null): Preferences {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (typeof value !== 'object' || value === null) return { ...defaults }
    const item = value as Record<string, unknown>
    return {
      theme: item.theme === 'light' || item.theme === 'dark' ? item.theme : 'system',
      sendKey: item.sendKey === 'mod-enter' ? 'mod-enter' : 'enter',
      inspector: item.inspector === true,
    }
  } catch {
    return { ...defaults }
  }
}

let current: Preferences | null = null
const listeners = new Set<() => void>()

function snapshot(): Preferences {
  current ??= parsePreferences(storageGet(KEY))
  return current
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  current = { ...snapshot(), [key]: value }
  storageSet(KEY, JSON.stringify(current))
  for (const listener of listeners) listener()
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot,
    () => defaults,
  )
}

const themeColors = { light: '#f7f9fc', dark: '#0b0f17' }

/** `system` leaves the media query in charge; explicit choices pin `data-theme`. */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = theme
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes('dark') ? 'dark' : 'light'
    meta.content = themeColors[theme === 'system' ? scheme : theme]
  }
}
