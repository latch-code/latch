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
