import { useEffect, useState } from 'react'
import { Layers, Smartphone } from 'lucide-react'
import { CommitGlyph, DiffGlyph, FolderGlyph, GlobeGlyph, OverviewGlyph, PluginsGlyph, TerminalGlyph, type IconComponent } from '@latch/ui'
import type { UiPanelInfo } from '@latch/protocol'
import { defineCopy } from '../core/i18n.ts'
import { storageGet, storageSet } from '../preferences.ts'

/**
 * What a tab of the right panel holds. 概要, 改动, 交付, 文件 and each plugin panel stand once; the browser and the
 * terminal are one tab each whose own strip holds several pages or terminals. Opened files are tabs of their own
 * (`useFileTabs`), after these.
 */
export type PanelKey = 'overview' | 'context' | 'changes' | 'files' | 'browser' | 'device' | 'terminal' | 'delivery' | `plugin:${string}`

declare const __LATCH_CONTEXT_PANEL_HASH__: string
const bundledContextHash = typeof __LATCH_CONTEXT_PANEL_HASH__ === 'string' ? __LATCH_CONTEXT_PANEL_HASH__ : ''

/** Only the build's own Context module can use the existing Context tab and its remembered position. */
export function isBundledContextPanel(panel: UiPanelInfo, hash = bundledContextHash): boolean {
  return !!hash && panel.id === 'context-insights:insights' && panel.context === true && panel.moduleHash === hash
}

/** The open tabs in order and the one selected; absent from storage until the person first opens or closes one. */
export interface PanelMemory {
  tabs: PanelKey[]
  active?: PanelKey
}

const FIXED: ReadonlySet<string> = new Set(['overview', 'context', 'changes', 'files', 'browser', 'device', 'terminal', 'delivery'])
const MAX_TABS = 24
const MAX_CONTEXTS = 40

function isPanelKey(value: unknown): value is PanelKey {
  if (typeof value !== 'string') return false
  if (FIXED.has(value)) return true
  const id = value.startsWith('plugin:') ? value.slice(7) : ''
  return id.length > 0 && id.length <= 200 && ![...id].some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
}

/** Opening a tab that stands already selects it; otherwise it joins the end of the strip. */
export function openPanelTab(memory: PanelMemory, key: PanelKey): PanelMemory {
  return { tabs: memory.tabs.includes(key) ? memory.tabs : [...memory.tabs, key], active: key }
}

/** The tab after the closed one takes over, or the one before it at the end of the strip. */
export function closePanelTab(memory: PanelMemory, key: PanelKey): PanelMemory {
  const at = memory.tabs.indexOf(key)
  if (at < 0) return memory
  const tabs = memory.tabs.filter(item => item !== key)
  const active = memory.active === key ? (tabs[at] ?? tabs[at - 1]) : memory.active
  return active === undefined ? { tabs } : { tabs, active }
}

/** What this session shows of what was remembered: only what it can open here, the selection falling to the first. */
export function shownPanelTabs(memory: PanelMemory, available: (key: PanelKey) => boolean): PanelMemory {
  const tabs = memory.tabs.filter(available)
  const active = memory.active !== undefined && tabs.includes(memory.active) ? memory.active : tabs[0]
  return active === undefined ? { tabs } : { tabs, active }
}

/** A session never arranged on this device starts on its 概要 where it has one, else with nothing open. */
export function freshPanelMemory(overview: boolean): PanelMemory {
  return overview ? { tabs: ['overview'], active: 'overview' } : { tabs: [] }
}

export function parsePanelMemory(value: unknown): PanelMemory | undefined {
  if (!value || typeof value !== 'object') return undefined
  const tabs: unknown = Reflect.get(value, 'tabs')
  if (!Array.isArray(tabs)) return undefined
  const valid = [...new Set(tabs.filter(isPanelKey))].slice(0, MAX_TABS)
  const active: unknown = Reflect.get(value, 'active')
  return isPanelKey(active) && valid.includes(active) ? { tabs: valid, active } : { tabs: valid }
}

function restore(key: string): Record<string, PanelMemory> {
  const result: Record<string, PanelMemory> = Object.create(null)
  try {
    const raw = storageGet(key)
    if (!raw || raw.length > 64_000) return result
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return result
    for (const item of value.slice(-MAX_CONTEXTS)) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || item[0].length > 512) continue
      const memory = parsePanelMemory(item[1])
      if (memory) result[item[0]] = memory
    }
  } catch {
    /* Unreadable: every session starts fresh. */
  }
  return result
}

const keyFor = (deviceId: string) => `latch.panel-tabs.${location.origin}.${deviceId}`

/**
 * The right panel's tabs for each session or project files context, kept per device in this browser like the panel's
 * width; never sent to the Host.
 */
export function usePanelTabs(deviceId: string, contextKey: string) {
  const key = keyFor(deviceId)
  const [bank, setBank] = useState(() => ({ key, contexts: restore(key) }))
  const contexts = bank.key === key ? bank.contexts : restore(key)
  if (bank.key !== key) setBank({ key, contexts })
  useEffect(() => {
    storageSet(key, JSON.stringify(Object.entries(contexts).slice(-MAX_CONTEXTS)))
  }, [key, contexts])
  const memory = contextKey && Object.hasOwn(contexts, contextKey) ? contexts[contextKey] : undefined
  const change = (fresh: PanelMemory, next: (memory: PanelMemory) => PanelMemory) => {
    if (!contextKey) return
    setBank(previous => {
      if (previous.key !== key) return previous
      const before = Object.hasOwn(previous.contexts, contextKey) ? previous.contexts[contextKey]! : fresh
      const rest = Object.entries(previous.contexts).filter(([id]) => id !== contextKey)
      return { key, contexts: Object.fromEntries([...rest.slice(-(MAX_CONTEXTS - 1)), [contextKey, next(before)]]) }
    })
  }
  return { memory, change }
}

export interface PanelChoice {
  key: PanelKey
  label: string
  icon: IconComponent
  /** The letter that opens it while the menu or the empty panel has the keys. */
  letter?: string
}

const LABELS = defineCopy(
  {
    browser: '浏览器',
    device: '设备',
    terminal: '终端',
    files: '文件',
    changes: '改动',
    delivery: '交付',
    overview: '概要',
    context: '上下文',
  },
  {
    browser: 'Browser',
    device: 'Devices',
    terminal: 'Terminal',
    files: 'Files',
    changes: 'Changes',
    delivery: 'Delivery',
    overview: 'Overview',
    context: 'Context',
  },
)

const FACES: Record<Exclude<PanelKey, `plugin:${string}`>, Pick<PanelChoice, 'icon' | 'letter'>> = {
  browser: { icon: GlobeGlyph, letter: 'B' },
  device: { icon: Smartphone, letter: 'V' },
  terminal: { icon: TerminalGlyph, letter: 'T' },
  files: { icon: FolderGlyph, letter: 'F' },
  changes: { icon: DiffGlyph, letter: 'D' },
  delivery: { icon: CommitGlyph, letter: 'P' },
  overview: { icon: OverviewGlyph, letter: 'O' },
  context: { icon: Layers, letter: 'C' },
}

/** A tab's name and glyph; a plugin panel's name is its own title. */
export function panelFace(key: PanelKey, title = ''): Omit<PanelChoice, 'key'> {
  if (key.startsWith('plugin:')) return { label: title, icon: PluginsGlyph }
  const builtin = key as keyof typeof FACES
  return { label: LABELS[builtin], ...FACES[builtin] }
}

/** Everything this session can open in the panel here, in one order for the 「+」 menu and the empty panel. */
export function panelChoices(input: {
  browser?: boolean
  device?: boolean
  terminal?: boolean
  files?: boolean
  changes?: boolean
  delivery?: boolean
  overview?: boolean
  context?: boolean
  plugins?: ReadonlyArray<{ id: string; title: string }>
}): PanelChoice[] {
  const order = ['browser', 'device', 'terminal', 'files', 'changes', 'delivery', 'overview', 'context'] as const
  return [
    ...order.filter(key => input[key]).map(key => ({ key, ...panelFace(key) })),
    ...(input.plugins ?? []).map(plugin => ({ key: `plugin:${plugin.id}` as const, ...panelFace(`plugin:${plugin.id}`, plugin.title) })),
  ]
}
