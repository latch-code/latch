import {
  SIMULATOR_BUNDLE_ID,
  SIMULATOR_INPUT_OWNERS,
  SIMULATOR_LOG_LIMITS,
  type SimulatorAppView,
  type SimulatorCatalogView,
  type SimulatorInputOwner,
  type SimulatorOrientationView,
  type SimulatorRecordingView,
} from '@latch/protocol'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    device: '设备',
  },
  {
    device: 'Device',
  },
)

/** A simulator as the Host lists it (`GET /simulators`). */
export interface SimulatorView {
  udid: string
  name: string
  os: string
  state: 'booted' | 'shutdown' | 'booting' | 'shutting-down' | 'unknown'
  /** Booted by this Host: only these get 关机. */
  ours: boolean
  /** The device this panel last showed a frame of. */
  shown?: true
  /** An agent's device session through Xcode's tools holds it. */
  agent?: true
  inputOwner?: SimulatorInputOwner
}

export interface SimulatorList {
  xcode: boolean
  devices: SimulatorView[]
  /** An agent holds a device session through Xcode whose device no call named. */
  agentUnnamed?: true
  /** What this Host can do beyond simctl's own commands: rotate (devicectl), record and stream logs (long children). */
  abilities: { rotate: boolean; record: boolean; logs: boolean }
}

const NO_ABILITIES = { rotate: false, record: false, logs: false }

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u
const STATES = new Set(['booted', 'shutdown', 'booting', 'shutting-down', 'unknown'])

/** The Host's answer, checked: anything malformed is left out. */
export function parseSimulators(value: unknown): SimulatorList {
  if (!value || typeof value !== 'object') return { xcode: false, devices: [], abilities: NO_ABILITIES }
  const xcode = Reflect.get(value, 'xcode') === true
  const raw: unknown = Reflect.get(value, 'devices')
  const devices: SimulatorView[] = []
  for (const item of Array.isArray(raw) ? raw.slice(0, 200) : []) {
    if (!item || typeof item !== 'object') continue
    const udid: unknown = Reflect.get(item, 'udid')
    const name: unknown = Reflect.get(item, 'name')
    const os: unknown = Reflect.get(item, 'os')
    const state: unknown = Reflect.get(item, 'state')
    if (typeof udid !== 'string' || !UDID.test(udid) || typeof name !== 'string' || typeof os !== 'string') continue
    if (typeof state !== 'string' || !STATES.has(state)) continue
    const owner: unknown = Reflect.get(item, 'inputOwner')
    const inputOwner = SIMULATOR_INPUT_OWNERS.find(value => value === owner)
    devices.push({
      udid,
      name: name.slice(0, 120),
      os: os.slice(0, 40),
      state: state as SimulatorView['state'],
      ours: Reflect.get(item, 'ours') === true,
      ...(Reflect.get(item, 'shown') === true ? { shown: true as const } : {}),
      ...(Reflect.get(item, 'agent') === true ? { agent: true as const } : {}),
      ...(inputOwner ? { inputOwner } : {}),
    })
  }
  const abilities: unknown = Reflect.get(value, 'abilities')
  const able = (key: string) => !!abilities && typeof abilities === 'object' && Reflect.get(abilities, key) === true
  return {
    xcode,
    devices,
    ...(Reflect.get(value, 'agentUnnamed') === true ? { agentUnnamed: true as const } : {}),
    abilities: { rotate: able('rotate'), record: able('record'), logs: able('logs') },
  }
}

const ORIENTATIONS = new Set(['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight'])

export function parseOrientation(value: unknown): SimulatorOrientationView {
  if (!value || typeof value !== 'object') return { supported: false, orientation: null }
  const orientation: unknown = Reflect.get(value, 'orientation')
  return {
    supported: Reflect.get(value, 'supported') === true,
    orientation:
      typeof orientation === 'string' && ORIENTATIONS.has(orientation) ? (orientation as SimulatorOrientationView['orientation']) : null,
  }
}

export function parseApps(value: unknown): SimulatorAppView[] {
  const raw: unknown = value && typeof value === 'object' ? Reflect.get(value, 'apps') : undefined
  const apps: SimulatorAppView[] = []
  for (const item of Array.isArray(raw) ? raw.slice(0, 500) : []) {
    if (!item || typeof item !== 'object') continue
    const bundleId: unknown = Reflect.get(item, 'bundleId')
    const name: unknown = Reflect.get(item, 'name')
    if (typeof bundleId !== 'string' || !SIMULATOR_BUNDLE_ID.test(bundleId) || typeof name !== 'string') continue
    apps.push({ bundleId, name: name.slice(0, 80), kind: Reflect.get(item, 'kind') === 'user' ? 'user' : 'system' })
  }
  return apps
}

export function parseCatalog(value: unknown): SimulatorCatalogView {
  const list = (key: string): unknown[] => {
    const raw: unknown = value && typeof value === 'object' ? Reflect.get(value, key) : undefined
    return Array.isArray(raw) ? raw.slice(0, 300) : []
  }
  const text = (item: unknown, key: string) => {
    const field: unknown = item && typeof item === 'object' ? Reflect.get(item, key) : undefined
    return typeof field === 'string' ? field : undefined
  }
  const deviceTypes = list('deviceTypes').flatMap(item => {
    const id = text(item, 'id')
    const name = text(item, 'name')
    return id && name ? [{ id, name: name.slice(0, 80), family: (text(item, 'family') ?? '').slice(0, 40) }] : []
  })
  const runtimes = list('runtimes').flatMap(item => {
    const id = text(item, 'id')
    const name = text(item, 'name')
    const types: unknown = item && typeof item === 'object' ? Reflect.get(item, 'deviceTypes') : undefined
    return id && name
      ? [{ id, name: name.slice(0, 80), deviceTypes: Array.isArray(types) ? types.filter(type => typeof type === 'string') : [] }]
      : []
  })
  return { deviceTypes, runtimes }
}

export function parseRecording(value: unknown): SimulatorRecordingView {
  if (!value || typeof value !== 'object') return { state: 'none' }
  const state: unknown = Reflect.get(value, 'state')
  const seconds: unknown = Reflect.get(value, 'seconds')
  const ended: unknown = Reflect.get(value, 'ended')
  return {
    state: state === 'recording' || state === 'ready' ? state : 'none',
    ...(typeof seconds === 'number' && Number.isFinite(seconds) ? { seconds } : {}),
    ...(ended === 'time' || ended === 'size' ? { ended } : {}),
  }
}

/** The logs pane's lines: the newest `SIMULATOR_LOG_LIMITS.lines`, oldest dropped first. */
export function appendLines(kept: readonly string[], lines: readonly string[]): string[] {
  const all = [...kept, ...lines.map(line => line.slice(0, SIMULATOR_LOG_LIMITS.lineChars))]
  return all.length > SIMULATOR_LOG_LIMITS.lines ? all.slice(-SIMULATOR_LOG_LIMITS.lines) : all
}

/** The device types a runtime takes, iPhone first, then iPad, then the rest, each by name. */
export function typesFor(catalog: SimulatorCatalogView, runtime: string | undefined): SimulatorCatalogView['deviceTypes'] {
  const ids = new Set(catalog.runtimes.find(item => item.id === runtime)?.deviceTypes ?? [])
  const rank = (family: string) => (family === 'iPhone' ? 0 : family === 'iPad' ? 1 : 2)
  return catalog.deviceTypes
    .filter(type => ids.has(type.id))
    .toSorted((a, b) => rank(a.family) - rank(b.family) || a.name.localeCompare(b.name))
}

/**
 * Which device the panel shows: the one chosen here while it still exists, else the one already running (the person's
 * own first), else none, so nothing boots by itself.
 */
export function chooseDevice(devices: readonly SimulatorView[], chosen: string | undefined): SimulatorView | undefined {
  const kept = chosen ? devices.find(device => device.udid === chosen) : undefined
  return kept ?? devices.find(device => device.state === 'booted')
}

/** The order of the list: running first, then by name. */
export function sortDevices(devices: readonly SimulatorView[]): SimulatorView[] {
  const rank = (device: SimulatorView) => (device.state === 'booted' ? 0 : device.state === 'booting' ? 1 : 2)
  return devices.toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** Between frames while the panel shows a running device: the next is asked for once the last arrived. */
const FRAME_GAP_MS = 250
const FRAME_BACKOFF_MS = 8_000

/** The wait before the next frame: the gap, doubling after each failure in a row up to 8 s. */
export function frameDelay(failures: number): number {
  return failures === 0 ? FRAME_GAP_MS : Math.min(FRAME_BACKOFF_MS, FRAME_GAP_MS * 2 ** Math.min(failures, 6))
}
/** How often the list is read while the panel shows. */
export const LIST_EVERY_MS = 5_000

/** 「iPhone 18 Pro · iOS 27.2」 */
export function deviceLabel(device: Pick<SimulatorView, 'name' | 'os'>): string {
  return `${device.name} · ${device.os}`
}

/** A screenshot's file name: the device and the time. */
export function shotName(device: Pick<SimulatorView, 'name'>, at = new Date(), extension: 'png' | 'mp4' = 'png'): string {
  const safe = device.name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || COPY.device
  const stamp = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}-${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}${String(at.getSeconds()).padStart(2, '0')}`
  return `${safe}-${stamp}.${extension}`
}

/** 「0:07」 */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * The panel's own shortcuts while focus is inside it: ⌘S screenshot, ⇧⌘R record, ⌘← and ⌘→ rotate. None while a text
 * field, a select or an editable region has focus, and none with another modifier, so the field's and the system's keys
 * stay. Record is ⇧⌘R, not ⌘R: the desktop app's menu gives ⌘R to 重新载入, which a real key press may reach first.
 */
export function panelShortcut(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  editable: boolean
}): 'shot' | 'record' | 'rotate-left' | 'rotate-right' | undefined {
  if (event.editable || !event.metaKey || event.ctrlKey || event.altKey) return
  if (event.shiftKey) return event.key === 'r' || event.key === 'R' ? 'record' : undefined
  if (event.key === 's' || event.key === 'S') return 'shot'
  if (event.key === 'ArrowLeft') return 'rotate-left'
  if (event.key === 'ArrowRight') return 'rotate-right'
  return
}

/** Whether focus is somewhere that takes typing. */
export function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const element = target as HTMLElement
  return (
    element.isContentEditable === true
    || element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null
  )
}
