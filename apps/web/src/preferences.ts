import { useSyncExternalStore } from 'react'
import { switchTheme } from '@latch/ui'
import { readStorage } from './core/storageKeys.ts'
import {
  parseRightPanelPreference,
  parseSidebarPreference,
  type RightPanelPreference,
  type SidebarPreference,
} from './shell/panelLayout.ts'

/** Per-viewer conveniences. Browser storage can be missing or throw; every read has a default. */
export type ThemePreference = 'system' | 'light' | 'dark'
export type SendKey = 'enter' | 'mod-enter'
export type WorkbenchLayout = 'overview' | 'triage'
/** How much of a turn's work the conversation shows: every row, only what went wrong, or one folded row. */
export type WorkDisplay = 'all' | 'failures' | 'folded'
export interface Preferences {
  autoOpenDocuments: boolean
  diffLayout: 'unified' | 'split'
  diffScope: 'run' | 'history'
  /** 自动, 上下 or 左右 in the 改动 tab; this device only. */
  diffMode: 'auto' | 'stacked' | 'split'
  /** 自动换行 in the 改动 tab; off by default. */
  diffWrap: boolean
  /** 文件树 in the 改动 tab; absent until the person chooses, so it opens by itself where it fits. */
  diffTree?: boolean
  theme: ThemePreference
  workbenchLayout: WorkbenchLayout
  /** 工作过程: this device only. Approvals, questions, failures and unknown results show at every level. */
  workDisplay: WorkDisplay
  /** Desktop only; touch keyboards always insert a newline on Enter. */
  sendKey: SendKey
  /** The right panel: whether it is open and its dragged width (local only). */
  rightPanel: RightPanelPreference
  /** The panel next to the rail: its dragged width and whether it is shut (local only, never sent to the Host). */
  sidebar: SidebarPreference
  /** The terminal dock's dragged height; absent means the default. */
  dockHeight?: number
  /** Shelves of the session list the person folded, by ID. */
  foldedShelves: string[]
}

const KEY = 'latch.preferences'
const defaults: Preferences = {
  autoOpenDocuments: true,
  diffLayout: 'unified',
  diffScope: 'history',
  diffMode: 'auto',
  diffWrap: false,
  theme: 'system',
  workbenchLayout: 'overview',
  workDisplay: 'all',
  sendKey: 'enter',
  rightPanel: { open: true },
  sidebar: { collapsed: false },
  foldedShelves: [],
}

/** Reads `key`, first moving a value saved under its name from before the rename (`readStorage`). */
export function storageGet(key: string): string | null {
  return readStorage('localStorage', key)
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
      autoOpenDocuments: typeof item.autoOpenDocuments === 'boolean' ? item.autoOpenDocuments : defaults.autoOpenDocuments,
      diffLayout: item.diffLayout === 'split' ? 'split' : 'unified',
      diffScope: item.diffScope === 'run' ? 'run' : 'history',
      diffMode: item.diffMode === 'stacked' || item.diffMode === 'split' ? item.diffMode : 'auto',
      diffWrap: item.diffWrap === true,
      ...(typeof item.diffTree === 'boolean' ? { diffTree: item.diffTree } : {}),
      theme: item.theme === 'light' || item.theme === 'dark' ? item.theme : 'system',
      workbenchLayout: item.workbenchLayout === 'triage' ? 'triage' : 'overview',
      workDisplay: item.workDisplay === 'failures' || item.workDisplay === 'folded' ? item.workDisplay : 'all',
      sendKey: item.sendKey === 'mod-enter' ? 'mod-enter' : 'enter',
      rightPanel: item.rightPanel === undefined ? { open: item.workbenchLayout !== 'triage' } : parseRightPanelPreference(item.rightPanel),
      sidebar: parseSidebarPreference(item.sidebar),
      ...(typeof item.dockHeight === 'number' && Number.isInteger(item.dockHeight) && item.dockHeight >= 140 && item.dockHeight <= 680
        ? { dockHeight: item.dockHeight }
        : {}),
      foldedShelves: Array.isArray(item.foldedShelves)
        ? [...new Set(item.foldedShelves.filter((shelf): shelf is string => typeof shelf === 'string'))].slice(0, 256)
        : [],
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
 * The browser bar takes the sidebar's grey (--sidebar), the window's own colour, at every width: from 768px the canvas
 * is inset on it, and a phone's pages put their headers on it.
 */
const themeColors = { light: '#ebebef', dark: '#09090b' }

/** The colour for one theme-color meta, read from its media query (index.html qualifies each by scheme). */
export function themeColorFor(media: string, theme: ThemePreference): string {
  const scheme = theme === 'system' ? (media.includes('dark') ? 'dark' : 'light') : theme
  return themeColors[scheme]
}

/**
 * `system` leaves the media query in charge; explicit choices pin `data-theme`. The colours switch at once, without
 * the transitions of hover fills and fields.
 */
export function applyTheme(theme: ThemePreference): void {
  switchTheme(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.dataset.theme = theme
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
      meta.content = themeColorFor(meta.media, theme)
  })
}
