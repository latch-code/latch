import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { crossFade, setReducedMotion, switchTheme } from '@latch/ui'
import { defineCopy, isLocalePreference, type LocalePreference } from './core/i18n.ts'
import { readStorage } from './core/storageKeys.ts'
import {
  parseRightPanelPreference,
  parseSidebarPreference,
  DOCK_MAX,
  DOCK_MIN,
  type RightPanelPreference,
  type SidebarPreference,
} from './shell/panelLayout.ts'

/** Per-viewer conveniences. Browser storage can be missing or throw; every read has a default. */
export type ThemePreference = 'system' | 'light' | 'dark'
export type PalettePreference = 'mono' | 'graphite' | 'cool' | 'warm'
export type AccentPreference = 'workbench' | 'navy' | 'teal' | 'iris'
export type FloatingMaterialPreference = 'solid' | 'frosted' | 'clear'
export type SendKey = 'enter' | 'mod-enter'
export type FollowUpDefault = 'steer' | 'queue'
/** 对话 (the sessions, the composer and the panels) or 看板 (every session as a card in its group). */
export type WorkView = 'chat' | 'board'
/** How much of a turn's work the conversation shows: every row, only what went wrong, or one folded row. */
export type WorkDisplay = 'all' | 'failures' | 'folded'
export const VIEW_NAMES = defineCopy<Record<WorkView, string>>({ chat: '对话', board: '看板' }, { chat: 'Chat', board: 'Board' })
/** 背景效果: 关, 轻 or 标准. */
export type BackdropPreference = 'off' | 'light' | 'standard'
/** 背景效果's look: 粒子 (`field`) or 01 (`digits`). */
export type BackdropStyle = 'field' | 'digits'
/**
 * 动效: 跟随系统 or 减弱. Forcing motion on against a system that asks for less is not offered until every older
 * reduced-motion rule follows the setting; a stored value other than these two reads as 跟随系统.
 */
export type MotionPreference = 'system' | 'reduce'
/** 密度: 标准 or 紧凑. */
export type DensityPreference = 'standard' | 'compact'
const APPEARANCE_COPY = defineCopy(
  {
    mono: '黑白',
    graphite: '墨灰',
    cool: '雾蓝',
    warm: '暖灰',
    workbench: '跟随工作台',
    navy: '深蓝',
    teal: '青绿',
    iris: '鸢尾紫',
    solid: '实色',
    frosted: '磨砂',
    clear: '通透',
    off: '关',
    light: '轻',
    standard: '标准',
    system: '跟随系统',
    reduce: '减弱',
    compact: '紧凑',
    field: '粒子',
    digits: '01',
  },
  {
    mono: 'Monochrome',
    graphite: 'Graphite',
    cool: 'Mist blue',
    warm: 'Warm grey',
    workbench: 'Follow workbench',
    navy: 'Deep blue',
    teal: 'Teal',
    iris: 'Iris',
    solid: 'Solid',
    frosted: 'Frosted',
    clear: 'Clear',
    off: 'Off',
    light: 'Light',
    standard: 'Standard',
    system: 'System',
    reduce: 'Reduced',
    compact: 'Compact',
    field: 'Particles',
    digits: '01',
  },
)

function appearanceOptions<T extends keyof typeof APPEARANCE_COPY>(values: readonly T[]) {
  return values.map(value => ({
    value,
    get label() {
      return APPEARANCE_COPY[value]
    },
  }))
}

export const BACKDROP_CHOICES = appearanceOptions<BackdropPreference>(['off', 'light', 'standard'])
export const BACKDROP_STYLE_CHOICES = appearanceOptions<BackdropStyle>(['field', 'digits'])
export const MOTION_CHOICES = appearanceOptions<MotionPreference>(['system', 'reduce'])
export const DENSITY_CHOICES = appearanceOptions<DensityPreference>(['standard', 'compact'])
export const PALETTE_CHOICES = appearanceOptions<PalettePreference>(['mono', 'graphite', 'cool', 'warm'])
export const ACCENT_CHOICES = appearanceOptions<AccentPreference>(['workbench', 'navy', 'teal', 'iris'])
export const FLOATING_MATERIAL_CHOICES = appearanceOptions<FloatingMaterialPreference>(['solid', 'frosted', 'clear'])

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
  palette: PalettePreference
  accent: AccentPreference
  floatingMaterial: FloatingMaterialPreference
  locale: LocalePreference
  /** 对话 or 看板 on this device. */
  workView: WorkView
  /** 工作过程: this device only. Approvals, questions, failures and unknown results show at every level. */
  workDisplay: WorkDisplay
  /** 背景效果 on this device; absent until the person chooses, so the palette and viewport set the default. */
  backdrop?: BackdropPreference
  /** 粒子 or 01 behind the page, on this device. */
  backdropStyle: BackdropStyle
  /** 动效 on this device. */
  motion: MotionPreference
  /** 密度 on this device. */
  density: DensityPreference
  /** Desktop only; touch keyboards always insert a newline on Enter. */
  sendKey: SendKey
  followUpDefault: FollowUpDefault
  /** The right panel: whether it is open and its dragged width (local only). */
  rightPanel: RightPanelPreference
  /** The panel next to the rail: its dragged width and whether it is shut (local only, never sent to the Host). */
  sidebar: SidebarPreference
  /** The terminal dock's dragged height; absent means the default. */
  dockHeight?: number
  dockOpen: boolean
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
  palette: 'mono',
  accent: 'workbench',
  floatingMaterial: 'frosted',
  locale: 'system',
  workView: 'chat',
  workDisplay: 'all',
  backdropStyle: 'field',
  motion: 'system',
  density: 'standard',
  sendKey: 'enter',
  followUpDefault: 'steer',
  rightPanel: { open: true },
  sidebar: { collapsed: false },
  dockOpen: false,
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

/**
 * The view a device opens on: its own choice, else 看板 where it had chosen the old 顶栏 layout (stored as
 * `workbenchLayout: 'triage'`), else 对话. The old key is dropped by the next write of the preferences.
 */
function storedView(item: Record<string, unknown>): WorkView {
  if (item.workView === 'chat' || item.workView === 'board') return item.workView
  return item.workbenchLayout === 'triage' ? 'board' : 'chat'
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
      palette: item.palette === 'graphite' || item.palette === 'cool' || item.palette === 'warm' ? item.palette : defaults.palette,
      accent: item.accent === 'navy' || item.accent === 'teal' || item.accent === 'iris' ? item.accent : defaults.accent,
      floatingMaterial:
        item.floatingMaterial === 'solid' || item.floatingMaterial === 'clear' ? item.floatingMaterial : defaults.floatingMaterial,
      locale: isLocalePreference(item.locale) ? item.locale : 'system',
      workView: storedView(item),
      workDisplay: item.workDisplay === 'failures' || item.workDisplay === 'folded' ? item.workDisplay : 'all',
      ...(item.backdrop === 'off' || item.backdrop === 'light' || item.backdrop === 'standard' ? { backdrop: item.backdrop } : {}),
      backdropStyle: item.backdropStyle === 'digits' ? 'digits' : 'field',
      motion: item.motion === 'reduce' ? 'reduce' : 'system',
      density: item.density === 'compact' ? 'compact' : 'standard',
      sendKey: item.sendKey === 'mod-enter' ? 'mod-enter' : 'enter',
      followUpDefault: item.followUpDefault === 'queue' ? 'queue' : defaults.followUpDefault,
      rightPanel: item.rightPanel === undefined ? { open: item.workbenchLayout !== 'triage' } : parseRightPanelPreference(item.rightPanel),
      sidebar: parseSidebarPreference(item.sidebar),
      dockOpen: item.dockOpen === true,
      ...(typeof item.dockHeight === 'number'
      && Number.isInteger(item.dockHeight)
      && item.dockHeight >= DOCK_MIN
      && item.dockHeight <= DOCK_MAX
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

/** The preferences as they stand now, outside a render. */
export function readPreferences(): Preferences {
  return snapshot()
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  current = { ...snapshot(), [key]: value }
  storageSet(KEY, JSON.stringify(current))
  for (const listener of listeners) listener()
}

/**
 * Changes between 对话 and 看板 on this device; nothing is sent to the Host. 对话 stays mounted under 看板, so the window
 * cross-fades as a whole (160ms) where the browser can do that. Reduced motion or an open security surface skips the
 * cross-fade.
 */
export function switchWorkView(view: WorkView): void {
  if (snapshot().workView === view) return
  const apply = () => {
    setPreference('workView', view)
  }
  void crossFade(() => {
    flushSync(apply)
  }, 'viewSwitch')
}

/** The monochrome workspace starts plain. Other palettes keep the lighter default on phones. */
export function backdropLevel({ backdrop, palette }: Pick<Preferences, 'backdrop' | 'palette'>, phone: boolean): BackdropPreference {
  if (backdrop !== undefined) return backdrop
  if (palette === 'mono') return 'off'
  return phone ? 'light' : 'standard'
}

export function applyAppearance({
  motion,
  density,
  palette,
  accent,
  floatingMaterial,
}: Pick<Preferences, 'motion' | 'density' | 'palette' | 'accent' | 'floatingMaterial'>): void {
  const { dataset } = document.documentElement
  setReducedMotion(motion === 'reduce')
  if (density === 'compact') dataset.density = 'compact'
  else delete dataset.density
  dataset.palette = palette
  dataset.deviceAccent = accent
  dataset.floatingMaterial = floatingMaterial
}

export function toggleWorkView(): void {
  switchWorkView(snapshot().workView === 'board' ? 'chat' : 'board')
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
