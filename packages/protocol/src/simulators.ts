// What the Host and the 设备 panel share about this Mac's iOS simulators beyond the list: the fixed sets a request may
// name and the bounds the Host keeps. The Host checks every request body with zod against these; the panel reads the
// answers defensively. See docs/DEVICE-PREVIEW.md.

import type { ApprovalOption, ToolDetail } from './sessions.ts'

/** The services `simctl privacy` may change for one listed app. `all` is left out: one app, one service at a time. */
export const SIMULATOR_PRIVACY_SERVICES = [
  'calendar',
  'contacts-limited',
  'contacts',
  'location',
  'location-always',
  'photos-add',
  'photos',
  'media-library',
  'microphone',
  'motion',
  'reminders',
  'siri',
] as const
export type SimulatorPrivacyService = (typeof SIMULATOR_PRIVACY_SERVICES)[number]

export const SIMULATOR_PRIVACY_ACTIONS = ['grant', 'revoke', 'reset'] as const
export type SimulatorPrivacyAction = (typeof SIMULATOR_PRIVACY_ACTIONS)[number]

/** A recording ends by itself at whichever comes first. The size is the draft's file attachment bound. */
export const SIMULATOR_RECORD_LIMITS = { seconds: 60, bytes: 25 * 1024 * 1024 } as const
/** What the logs pane keeps, and the longest line it shows. */
export const SIMULATOR_LOG_LIMITS = { lines: 1000, lineChars: 1000 } as const
/** A new device's name: what the person types, checked the same on both sides. */
export const SIMULATOR_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()'-]{0,63}$/u
/** A bundle identifier as `simctl listapps` names one; never option-shaped. */
export const SIMULATOR_BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/u

export type SimulatorOrientation = 'portrait' | 'portraitUpsideDown' | 'landscapeLeft' | 'landscapeRight'

/** `GET /simulators/:udid/orientation`: whether this device can be rotated, and how it is turned now. */
export interface SimulatorOrientationView {
  supported: boolean
  orientation: SimulatorOrientation | null
}

/** One app on a device, as `simctl listapps` lists it. */
export interface SimulatorAppView {
  bundleId: string
  name: string
  /** Installed by the person or a build (`User`), or part of the system. */
  kind: 'user' | 'system'
}

/** `GET /simulators/catalog`: what a new device may be made of. */
export interface SimulatorCatalogView {
  deviceTypes: Array<{ id: string; name: string; family: string }>
  runtimes: Array<{ id: string; name: string; deviceTypes: string[] }>
}

/** `GET /simulators/:udid/record`: a recording of this device, if one runs or waits to be taken. */
export interface SimulatorRecordingView {
  state: 'none' | 'recording' | 'ready'
  /** Seconds since it started; for the timer. */
  seconds?: number
  /** Why it ended by itself: its time or its size ran out. */
  ended?: 'time' | 'size'
}

/** The events of `GET /simulators/:udid/logs`, a text/event-stream read with fetch. */
export interface SimulatorLogEvents {
  /** Lines of `log stream --style compact`, control characters removed, each at most `lineChars`. */
  lines: { lines: string[] }
  /** Lines left out because the page read slower than the device wrote. */
  dropped: { count: number }
  /** The stream ended: the device stopped, the Host stopped, or `log` exited. */
  closed: { reason: 'device' | 'host' | 'exited' }
}

// ── The live picture and input (docs/DEVICE-PREVIEW.md) ──

/**
 * `GET /simulators/:udid/stream?codec=&fps=&size=`: application/octet-stream of messages, each a 13-byte header (type,
 * microseconds since the stream began as an unsigned 64-bit integer, payload length as an unsigned 32-bit integer, all
 * big-endian) and the payload. A description comes before the first frame and again whenever the picture changes form.
 */
export const SIMULATOR_STREAM = {
  headerBytes: 13,
  /** JSON `SimulatorLiveDescription`. */
  description: 0x01,
  /** One H.264 access unit in AVCC form. */
  delta: 0x02,
  key: 0x03,
  /** One JPEG. */
  jpeg: 0x04,
  /** JSON `{ reason }`: the stream ends here. */
  end: 0x05,
  /** One byte, the index into SIMULATOR_INPUT_OWNERS, for the device watching this stream. */
  control: 0x06,
} as const

/** What a live stream may ask for; the Host refuses anything outside. */
export const SIMULATOR_STREAM_LIMITS = { fps: { min: 1, max: 60 }, size: { min: 160, max: 4096 } } as const

export interface SimulatorLiveDescription {
  codec: 'h264' | 'jpeg'
  /** For `VideoDecoder.configure`: `avc1.xxxxxx` and the avcC record (base64). */
  codecString?: string
  config?: string
  /** The encoded picture in pixels: always the screen's own (portrait) framebuffer. */
  width: number
  height: number
  /** The framebuffer in points, and in the device's own pixels (what 1:1 zoom shows). */
  points: { width: number; height: number }
  source: { width: number; height: number }
  /**
   * How the screen's content is turned in the framebuffer: 1 upright, 2 upside down, 3 turned so its top is at the
   * framebuffer's left, 4 at its right. Input points are in the content's own frame.
   */
  orientation: 1 | 2 | 3 | 4
}

export type SimulatorLiveEnd = 'device' | 'host' | 'closed' | 'failed'

/** Single named keys the panel and agents may press. Printable text has its own checked input event. */
export const SIMULATOR_KEYS = ['return', 'delete', 'tab', 'escape', 'left', 'right', 'up', 'down'] as const
export type SimulatorKey = (typeof SIMULATOR_KEYS)[number]
/** Hardware buttons. Apple Pay is not offered: idb answers it is not implemented on this transport. */
export const SIMULATOR_BUTTONS = ['home', 'lock', 'side', 'siri'] as const
export type SimulatorButton = (typeof SIMULATOR_BUTTONS)[number]

/** `POST /simulators/:udid/input`: at most this many events, in order, in device points; text per event; text per agent call. */
export const SIMULATOR_INPUT_LIMITS = { events: 64, textChars: 64, agentTextChars: 1000 } as const

export const SIMULATOR_INPUT_TOOLS = ['device_tap', 'device_swipe', 'device_type_text', 'device_press_key', 'device_press_button'] as const
export type SimulatorInputTool = (typeof SIMULATOR_INPUT_TOOLS)[number]

function qualifiedSimulatorInput(label: string | undefined): SimulatorInputTool | undefined {
  const name = label?.trim()
  return SIMULATOR_INPUT_TOOLS.find(
    tool => name === `mcp__latch-browser__${tool}` || name === `latch-browser.${tool}` || name === `latch-browser: ${tool}`,
  )
}

/**
 * The simulator input tool a qualified name refers to, by name alone: a call's identity, never whether its row may be
 * shown as counts (`simulatorInputTool` decides that from its arguments).
 */
export function simulatorInputName(label: string | undefined): SimulatorInputTool | undefined {
  return qualifiedSimulatorInput(label)
}

const SIMULATOR_INPUT_TITLES: Record<SimulatorInputTool, string> = {
  device_tap: '模拟器点按',
  device_swipe: '模拟器滑动',
  device_type_text: '模拟器输入文字',
  device_press_key: '模拟器按键',
  device_press_button: '模拟器按按钮',
}

function recordedObject(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === 'string' && input.length <= 65_536) {
    try {
      input = JSON.parse(input)
    } catch {
      return undefined
    }
  }
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

/** A call's own arguments match the simulator tool's exact shape: only then may a row show counts in their place. */
function hasSimulatorArguments(tool: SimulatorInputTool, input: Record<string, unknown> | undefined): boolean {
  if (typeof input?.udid !== 'string' || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/u.test(input.udid)) return false
  const only = (...fields: string[]) => Object.keys(input).every(key => key === 'udid' || fields.includes(key))
  const point = (value: unknown) => typeof value === 'number' && value >= 0 && value <= 10_000
  const duration = (value: unknown, min: number) =>
    value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 5_000)
  switch (tool) {
    case 'device_tap':
      return only('x', 'y', 'holdMs') && point(input.x) && point(input.y) && duration(input.holdMs, 0)
    case 'device_swipe':
      return (
        only('fromX', 'fromY', 'toX', 'toY', 'durationMs')
        && [input.fromX, input.fromY, input.toX, input.toY].every(point)
        && duration(input.durationMs, 50)
      )
    case 'device_type_text':
      return only('text') && typeof input.text === 'string' && input.text.length <= SIMULATOR_INPUT_LIMITS.agentTextChars
    case 'device_press_key':
      return only('key') && SIMULATOR_KEYS.some(key => key === input.key)
    case 'device_press_button':
      return only('button') && SIMULATOR_BUTTONS.some(button => button === input.button)
  }
}

/** A row saved earlier already holds only the counts `simulatorInputDetail` made: nothing of the call is left to hide. */
function summarisedSimulatorInput(tool: SimulatorInputTool, rawInput: unknown): boolean {
  if (typeof rawInput !== 'string') return false
  if (tool === 'device_tap') return rawInput === '1 个触点'
  if (tool === 'device_swipe') return rawInput === '2 个触点'
  if (tool === 'device_type_text') return rawInput === '输入文字' || /^\d{1,8} 个字符$/u.test(rawInput)
  return rawInput === '1 次'
}

/**
 * Whether a call's row shows as simulator input (counts in place of its arguments). Structured call identity comes
 * first; some ACP agents put their only qualified name in the title. Whatever names it, its arguments must have the
 * tool's exact shape: a call named so with other arguments shows them, as any other tool does.
 */
export function simulatorInputTool(
  name: string | undefined,
  kind?: string,
  rawInput?: unknown,
  title?: string,
): SimulatorInputTool | undefined {
  if (kind !== undefined && kind !== 'other' && kind !== 'think') return undefined
  const input = recordedObject(rawInput)
  if (input?.command !== undefined) return undefined
  const shaped = (tool: SimulatorInputTool | undefined, args: Record<string, unknown> | undefined) =>
    tool && (hasSimulatorArguments(tool, args) || summarisedSimulatorInput(tool, rawInput)) ? tool : undefined
  const named = qualifiedSimulatorInput(name)
  if (typeof input?.server === 'string' && typeof input.tool === 'string') {
    const qualified = `${input.server}.${input.tool}`
    const declared = qualifiedSimulatorInput(qualified)
    const agrees = name === undefined || named === declared || name === input.tool || name === `调用 ${qualified}`
    return agrees ? shaped(declared, recordedObject(input.arguments)) : undefined
  }
  if (named) return shaped(named, input)
  const titled = qualifiedSimulatorInput(title)
  if (!titled || (kind !== undefined && kind !== 'other') || (name !== undefined && name !== titled)) return undefined
  return shaped(titled, input)
}

/** Only operation, counts and trusted status fields are stored or sent to a device. Raw arguments stay in execution. */
export function simulatorInputDetail(
  tool: SimulatorInputTool,
  rawInput: unknown,
  state: Pick<ToolDetail, 'kind' | 'output' | 'decision' | 'judged' | 'blocked'> = {},
): ToolDetail & { title: string; input: string } {
  let input = '1 次'
  if (tool === 'device_tap' || tool === 'device_swipe') input = tool === 'device_tap' ? '1 个触点' : '2 个触点'
  if (tool === 'device_type_text') {
    const parsed = recordedObject(rawInput)
    const text = parsed?.text ?? recordedObject(parsed?.arguments)?.text
    input = typeof text === 'string' ? `${text.length} 个字符` : '输入文字'
    // Device projection sees counts already produced when a tool row was saved.
    if (typeof rawInput === 'string' && /^\d{1,8} 个字符$/u.test(rawInput)) input = rawInput
  }
  const output = state.output?.includes('TOOL_OUTCOME_UNKNOWN:')
    ? 'TOOL_OUTCOME_UNKNOWN: 结果未知，请先核对它做了什么。Latch 不会自动重做。'
    : state.output?.includes('TOOL_NOT_STARTED:')
      ? 'TOOL_NOT_STARTED: 本轮已结束，工具没有开始执行。'
      : undefined
  return {
    kind: state.kind ?? 'other',
    title: SIMULATOR_INPUT_TITLES[tool],
    input,
    ...(output ? { output } : {}),
    ...(state.decision ? { decision: state.decision } : {}),
    ...(state.judged ? { judged: { by: state.judged.by, outcome: state.judged.outcome } } : {}),
    ...(state.blocked ? { blocked: { by: state.blocked.by, source: state.blocked.source } } : {}),
  }
}

export function simulatorInputOptions(options: ApprovalOption[]): ApprovalOption[] {
  const labels: Record<ApprovalOption['kind'], string> = {
    allow_once: '允许一次',
    allow_always: '始终允许',
    reject_once: '拒绝',
    reject_always: '始终拒绝',
  }
  return options.map(option => ({ id: option.id, kind: option.kind, label: labels[option.kind] }))
}
export type SimulatorInputEvent =
  /** One finger: down, moves while down, up. A second finger is not available. */
  | { type: 'touch'; phase: 'down' | 'move' | 'up'; x: number; y: number }
  | { type: 'key'; key: SimulatorKey }
  | { type: 'button'; button: SimulatorButton }
  /**
   * Printable ASCII typed key by key, only while the device's own keyboard is English (US) QWERTY: anything else is
   * refused with the reason, never typed half.
   */
  | { type: 'text'; text: string }

/** The device's input lease or the active Agent gesture, from the viewing device's point of view. */
export const SIMULATOR_INPUT_OWNERS = ['none', 'you', 'other', 'agent'] as const
export type SimulatorInputOwner = (typeof SIMULATOR_INPUT_OWNERS)[number]

/** `POST /simulators/:udid/input`: events put on the companion stream, before its delivery status. */
export interface SimulatorInputReceipt {
  written: number
  /** Index of the last written touch in this request. A lift or move without a finger can be ignored. */
  touchIndex?: number
}

/** Why a kind of input is unavailable; the panel shows it in a hover. */
export type SimulatorInputReason =
  /** idb_companion is not installed (the person installs it; Latch never does). */
  | 'idb-missing'
  /** It did not start, or stopped. */
  | 'companion-failed'
  /** It started but did not answer. */
  | 'no-answer'
  /** The private socket's path is too long for this Mac. */
  | 'socket-path'
  /** Text is typed only on the English (US) QWERTY keyboard (checked when it is typed): this keyboard is another. */
  | 'keyboard'
  /** idb's touch carries one point and no finger number. */
  | 'single-touch'
  /** This Host was started without input (tests, or not macOS). */
  | 'unsupported'

export type SimulatorInputKind = { available: true } | { available: false; reason: SimulatorInputReason }

/** `POST /simulators/:udid/control`: what this device's input can do now. */
export interface SimulatorControlView {
  touch: SimulatorInputKind
  keys: SimulatorInputKind
  buttons: SimulatorInputKind
  text: SimulatorInputKind
  twoFingers: SimulatorInputKind
}
