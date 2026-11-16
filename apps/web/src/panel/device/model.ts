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
}

export interface SimulatorList {
  xcode: boolean
  devices: SimulatorView[]
  /** An agent holds a device session through Xcode whose device no call named. */
  agentUnnamed?: true
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u
const STATES = new Set(['booted', 'shutdown', 'booting', 'shutting-down', 'unknown'])

/** The Host's answer, checked: anything malformed is left out. */
export function parseSimulators(value: unknown): SimulatorList {
  if (!value || typeof value !== 'object') return { xcode: false, devices: [] }
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
    devices.push({
      udid,
      name: name.slice(0, 120),
      os: os.slice(0, 40),
      state: state as SimulatorView['state'],
      ours: Reflect.get(item, 'ours') === true,
      ...(Reflect.get(item, 'shown') === true ? { shown: true as const } : {}),
      ...(Reflect.get(item, 'agent') === true ? { agent: true as const } : {}),
    })
  }
  return { xcode, devices, ...(Reflect.get(value, 'agentUnnamed') === true ? { agentUnnamed: true as const } : {}) }
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
export function shotName(device: Pick<SimulatorView, 'name'>, at = new Date()): string {
  const safe = device.name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || '设备'
  const stamp = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}-${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}${String(at.getSeconds()).padStart(2, '0')}`
  return `${safe}-${stamp}.png`
}
