// What the Host and the 设备 panel share about this Mac's iOS simulators beyond the list: the fixed sets a request may
// name and the bounds the Host keeps. The Host checks every request body with zod against these; the panel reads the
// answers defensively. See docs/DEVICE-PREVIEW.md.

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

/** Single keys the panel and agents may press; text is not typed through the device keyboard. */
export const SIMULATOR_KEYS = ['return', 'delete', 'tab', 'escape', 'left', 'right', 'up', 'down'] as const
export type SimulatorKey = (typeof SIMULATOR_KEYS)[number]
/** Hardware buttons. Apple Pay is not offered: idb answers it is not implemented on this transport. */
export const SIMULATOR_BUTTONS = ['home', 'lock', 'side', 'siri'] as const
export type SimulatorButton = (typeof SIMULATOR_BUTTONS)[number]

/** `POST /simulators/:udid/input`: at most this many events, in order, in device points. */
export const SIMULATOR_INPUT_LIMITS = { events: 64 } as const
export type SimulatorInputEvent =
  /** One finger: down, moves while down, up. A second finger is not available. */
  | { type: 'touch'; phase: 'down' | 'move' | 'up'; x: number; y: number }
  | { type: 'key'; key: SimulatorKey }
  | { type: 'button'; button: SimulatorButton }

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
  /** The device refuses pasted text from outside it (checked on iOS 27.2). */
  | 'paste-refused'
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
