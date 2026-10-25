import { useSyncExternalStore } from 'react'
import { parseInspectorPreference, type InspectorPreference } from './inspectorLayout.ts'
import { parseSidebarPreference, type SidebarPreference } from './sidebarLayout.ts'

/** Per-viewer conveniences. Browser storage can be missing or throw; every read has a default. */
export type ThemePreference = 'system' | 'light' | 'dark'
export type SendKey = 'enter' | 'mod-enter'
export interface Preferences {
  autoOpenDocuments: boolean
  onboarding: 'auto' | 'show' | 'hidden'
  theme: ThemePreference
  /** Desktop only; touch keyboards always insert a newline on Enter. */
  sendKey: SendKey
  /** The session-information column: open per class of window, its dragged width and the blocks folded (local only). */
  inspector: InspectorPreference
  /** The sidebar's dragged width and whether it is shut, per breakpoint class (local only, never sent to the Host). */
  sidebar: SidebarPreference
}

const KEY = 'harness-link.preferences'
const defaults: Preferences = {
  autoOpenDocuments: false,
  onboarding: 'auto',
  theme: 'system',
  sendKey: 'enter',
  inspector: { open: {}, width: {}, collapsed: [] },
  sidebar: { width: {}, collapsed: {} },
}

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
      autoOpenDocuments: item.autoOpenDocuments === true,
      onboarding: item.onboarding === 'show' || item.onboarding === 'hidden' ? item.onboarding : 'auto',
      theme: item.theme === 'light' || item.theme === 'dark' ? item.theme : 'system',
      sendKey: item.sendKey === 'mod-enter' ? 'mod-enter' : 'enter',
      inspector: parseInspectorPreference(item.inspector),
      sidebar: parseSidebarPreference(item.sidebar),
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

/**
 * The browser bar takes the colour of the ground (bg-app) at every width: from 768px the page is paper inset on it, and
 * a phone's pages put their headers on it.
 */
const themeColors = { light: '#f2f1ee', dark: '#141413' }

/** The colour for one theme-color meta, read from its media query (index.html qualifies each by scheme). */
export function themeColorFor(media: string, theme: ThemePreference): string {
  const scheme = theme === 'system' ? (media.includes('dark') ? 'dark' : 'light') : theme
  return themeColors[scheme]
}

/** `system` leaves the media query in charge; explicit choices pin `data-theme`. */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = theme
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = themeColorFor(meta.media, theme)
}
