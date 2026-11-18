import { CREDENTIAL_CARRIERS, CREDENTIAL_KEYS, LATCH_CREDENTIALS, escapeSecurityText } from '@latch/protocol'
import type {
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  BrowserPreset,
  BrowserRect,
  BrowserTabState,
  BrowserTarget,
  BrowserColorScheme,
} from '../../core/shell.ts'
import { readStorage } from '../../core/storageKeys.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    preset: {
      'phone-small': '小屏手机',
      phone: '手机',
      'phone-large': '大屏手机',
      android: 'Android 手机',
      tablet: '平板',
      desktop: '桌面',
    },
    scheme: { system: '跟随系统', light: '浅色', dark: '深色' },
    errors: (count: number) => `${formatNumber(count)} 个错误`,
    warnings: (count: number) => `${formatNumber(count)} 个警告`,
    newTab: '新标签',
    downloadBlocked: '页面想下载文件，已拦下',
    popupBlocked: '页面想打开新窗口，已拦下',
    certificateBlocked: '证书无效，已拒绝连接',
    permissionBlocked: '页面请求的权限已拒绝',
    hostBlocked: '页面想访问 Latch，已拦下',
    privateBlocked: '页面想去局域网或这台 Mac 的其他地址，已拦下',
    notLocalBlocked: 'Agent 操作后页面想离开这台 Mac，已拦下',
    addressBlocked: '页面想去的地址不能打开，已拦下',
    blocked: '已拦下页面的请求',
    invalid: '只能打开 http 或 https 地址',
    refusedHost: '不能在这里打开 Latch 自己的地址',
    refusedAddress: '不能打开这个地址',
    tabLimit: (limit: number) => `最多 ${formatNumber(limit)} 个标签`,
    projectLimit: '打开的项目太多了，请重启 Latch',
    unavailable: '窗口还没准备好，请重试',
    failed: '没有打开',
    console: '控制台',
    network: '网络',
    failedCount: (count: number) => `${formatNumber(count)} 个失败`,
  },
  {
    preset: {
      'phone-small': 'Small phone',
      phone: 'Phone',
      'phone-large': 'Large phone',
      android: 'Android phone',
      tablet: 'Tablet',
      desktop: 'Desktop',
    },
    scheme: { system: 'System', light: 'Light', dark: 'Dark' },
    errors: (count: number) => plural(count, { one: '{n} error', other: '{n} errors' }),
    warnings: (count: number) => plural(count, { one: '{n} warning', other: '{n} warnings' }),
    newTab: 'New tab',
    downloadBlocked: 'The page tried to download a file. Latch blocked it.',
    popupBlocked: 'The page tried to open a window. Latch blocked it.',
    certificateBlocked: 'Invalid certificate. Connection refused.',
    permissionBlocked: 'The page’s permission request was denied.',
    hostBlocked: 'The page tried to reach Latch. The request was blocked.',
    privateBlocked: 'The page tried to reach the local network or another address on this Mac. The request was blocked.',
    notLocalBlocked: 'After the agent acted, the page tried to leave this Mac. The request was blocked.',
    addressBlocked: 'The page tried to open a restricted address. The request was blocked.',
    blocked: 'The page’s request was blocked.',
    invalid: 'Only HTTP and HTTPS addresses can be opened',
    refusedHost: 'Latch’s own address can’t be opened here',
    refusedAddress: 'This address can’t be opened',
    tabLimit: (limit: number) => `Up to ${plural(limit, { one: '{n} tab', other: '{n} tabs' })}`,
    projectLimit: 'Too many projects are open. Restart Latch.',
    unavailable: 'The window isn’t ready. Try again.',
    failed: 'Couldn’t open the address',
    console: 'Console',
    network: 'Network',
    failedCount: (count: number) => `${formatNumber(count)} failed`,
  },
)

/** As main keeps them (browser.cjs `TAB_LIMIT`): every tab of the window counts. */
export const BROWSER_TAB_LIMIT = 8
/** 选取元素 takes up to this many elements before it ends. */
export const PICK_LIMIT = 5
/** While a local address refuses the connection and the panel shows: a reload this often, for at most a minute. */
export const RETRY_EVERY_MS = 2_000
export const RETRY_FOR_MS = 60_000
/** The caption under a preset's page. */
export const CAPTION_HEIGHT = 24
/** Room around a preset's page, inside the canvas. */
const PRESET_GAP = 16
const RECENT_LIMIT = 5
const DRAFT_ERRORS = 20

/**
 * As main lays them out (browser.cjs `VIEWPORTS`): size in CSS pixels upright, pixel ratio, and for a phone the safe
 * area Latch hints at on its frame (top and bottom insets upright), which the page itself is not told.
 */
export const PRESETS: ReadonlyArray<{
  id: Exclude<BrowserPreset, 'fit'>
  label: string
  width: number
  height: number
  ratio: number
  phone?: { top: number; bottom: number }
}> = [
  {
    id: 'phone-small',
    get label() {
      return COPY.preset['phone-small']
    },
    width: 375,
    height: 667,
    ratio: 2,
    phone: { top: 20, bottom: 0 },
  },
  {
    id: 'phone',
    get label() {
      return COPY.preset.phone
    },
    width: 390,
    height: 844,
    ratio: 3,
    phone: { top: 47, bottom: 34 },
  },
  {
    id: 'phone-large',
    get label() {
      return COPY.preset['phone-large']
    },
    width: 440,
    height: 956,
    ratio: 3,
    phone: { top: 62, bottom: 34 },
  },
  {
    id: 'android',
    get label() {
      return COPY.preset.android
    },
    width: 412,
    height: 915,
    ratio: 2.625,
    phone: { top: 24, bottom: 24 },
  },
  {
    id: 'tablet',
    get label() {
      return COPY.preset.tablet
    },
    width: 820,
    height: 1180,
    ratio: 2,
  },
  {
    id: 'desktop',
    get label() {
      return COPY.preset.desktop
    },
    width: 1280,
    height: 800,
    ratio: 1,
  },
]
/** The plain frame Latch draws around a phone preset's page, outside the view (a native view covers what is under it). */
export const PHONE_BEZEL = 10

export const SCHEMES: ReadonlyArray<{ id: BrowserColorScheme; label: string }> = [
  {
    id: 'system',
    get label() {
      return COPY.scheme.system
    },
  },
  {
    id: 'light',
    get label() {
      return COPY.scheme.light
    },
  },
  {
    id: 'dark',
    get label() {
      return COPY.scheme.dark
    },
  },
]

/** A preset's size in CSS pixels, turned when rotated; null for 适应面板. */
export function presetSize(preset: BrowserPreset, rotated: boolean): { width: number; height: number } | null {
  const found = PRESETS.find(item => item.id === preset)
  if (!found) return null
  return rotated ? { width: found.height, height: found.width } : { width: found.width, height: found.height }
}

/**
 * Where the tab's page goes in the canvas (CSS pixels of the page): the whole canvas for 适应面板; a preset's page fitted
 * to it, never enlarged, centered above its caption.
 */
export function placeView(
  canvas: BrowserRect,
  preset: BrowserPreset,
  rotated: boolean,
): { rect: BrowserRect; scale: number; size: { width: number; height: number } | null } {
  const size = presetSize(preset, rotated)
  if (!size) return { rect: canvas, scale: 1, size: null }
  // A phone's frame stands outside its page, so its room is taken first.
  const bezel = PRESETS.find(item => item.id === preset)?.phone ? PHONE_BEZEL : 0
  const roomWidth = Math.max(0, canvas.width - PRESET_GAP * 2 - bezel * 2)
  const roomHeight = Math.max(0, canvas.height - PRESET_GAP * 2 - CAPTION_HEIGHT - bezel * 2)
  const scale = Math.max(0, Math.min(1, roomWidth / size.width, roomHeight / size.height))
  const width = Math.floor(size.width * scale)
  const height = Math.floor(size.height * scale)
  const x = canvas.x + Math.round((canvas.width - width) / 2)
  const y = canvas.y + Math.max(PRESET_GAP + bezel, Math.round((canvas.height - CAPTION_HEIGHT - height) / 2))
  return { rect: { x, y, width, height }, scale, size }
}

/** 「390 × 844 @3x · 75%」 */
export function presetCaption(size: { width: number; height: number }, scale: number, ratio?: number): string {
  return `${size.width} × ${size.height}${ratio && ratio !== 1 ? ` @${ratio}x` : ''} · ${Math.round(scale * 100)}%`
}

/**
 * The safe-area hint of a phone preset, in CSS pixels of the panel: how far the top and bottom (or, turned, the left and
 * right) insets reach into the scaled page. Undefined for other presets.
 */
export function safeAreaHint(
  preset: BrowserPreset,
  rotated: boolean,
  scale: number,
): { side: 'vertical' | 'horizontal'; start: number; end: number } | undefined {
  const phone = PRESETS.find(item => item.id === preset)?.phone
  if (!phone) return undefined
  return { side: rotated ? 'horizontal' : 'vertical', start: Math.round(phone.top * scale), end: Math.round(phone.bottom * scale) }
}

function parsed(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/** This Mac under its usual names: localhost, `*.localhost`, 127/8 and ::1. */
export function isLoopbackUrl(url: string): boolean {
  const host = parsed(url)?.hostname.toLowerCase()
  if (!host) return false
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/u.test(host) || host === '[::1]'
}

/** `localhost:5173`: an address's host and port. */
export function hostLabel(url: string): string {
  return parsed(url)?.host ?? ''
}

/** `localhost:5173/settings`: host, port and path, without the query; what the draft names a screenshot after. */
export function pageLabel(url: string): string {
  const address = parsed(url)
  if (!address) return ''
  const path = address.pathname === '/' ? '' : address.pathname
  return `${address.host}${path}`
}

/** A tab's name in the strip: its title, else where it is, else 新标签. */
export function tabTitle(state: BrowserTabState | undefined): string {
  if (!state) return COPY.newTab
  const title = state.title.trim()
  if (title && title !== state.url && !/^https?:\/\//u.test(title)) return title
  return hostLabel(state.url) || COPY.newTab
}

const NET_ERRORS: Record<number, string> = {
  [-2]: 'ERR_FAILED',
  [-7]: 'ERR_TIMED_OUT',
  [-20]: 'ERR_BLOCKED_BY_CLIENT',
  [-21]: 'ERR_NETWORK_CHANGED',
  [-100]: 'ERR_CONNECTION_CLOSED',
  [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-104]: 'ERR_CONNECTION_FAILED',
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-107]: 'ERR_SSL_PROTOCOL_ERROR',
  [-109]: 'ERR_ADDRESS_UNREACHABLE',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-137]: 'ERR_NAME_RESOLUTION_FAILED',
  [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
  [-201]: 'ERR_CERT_DATE_INVALID',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID',
  [-310]: 'ERR_TOO_MANY_REDIRECTS',
  [-324]: 'ERR_EMPTY_RESPONSE',
}
export const CONNECTION_REFUSED = -102

/** Chromium's name for a network error code. */
export function errorName(code: number): string {
  return NET_ERRORS[code] ?? `ERR ${code}`
}

/** What the canvas says about a tab that is not showing a page. */
export type TabTrouble = { kind: 'crashed' } | { kind: 'waiting'; host: string } | { kind: 'failed'; host: string; reason: string }

/** The line under the toolbar when main refused something the page tried. */
export function noticeText(notice: string, detail?: string): string {
  switch (notice) {
    case 'download':
      return COPY.downloadBlocked
    case 'popup':
      return COPY.popupBlocked
    case 'certificate':
      return COPY.certificateBlocked
    case 'permission':
      return COPY.permissionBlocked
    case 'navigation':
      return detail === 'host'
        ? COPY.hostBlocked
        : detail === 'private'
          ? COPY.privateBlocked
          : detail === 'not-local'
            ? COPY.notLocalBlocked
            : COPY.addressBlocked
    default:
      return COPY.blocked
  }
}

/** What a refused open or navigate means, for the address field. */
export function refusalText(error: string, reason?: string): string {
  if (error === 'invalid-url' || error === 'invalid') return COPY.invalid
  if (error === 'blocked') return reason === 'host' ? COPY.refusedHost : COPY.refusedAddress
  if (error === 'tab-limit') return COPY.tabLimit(BROWSER_TAB_LIMIT)
  if (error === 'project-limit') return COPY.projectLimit
  if (error === 'unavailable') return COPY.unavailable
  return COPY.failed
}

/** The bottom row: counts in their tones; red only for errors, amber only for warnings. */
export function footerParts(logs: BrowserTabState['logs'] | undefined): Array<{ text: string; tone?: 'error' | 'warn' }> {
  const errors = logs?.errors ?? 0
  const warnings = logs?.warnings ?? 0
  const failed = logs?.failed ?? 0
  const console: Array<{ text: string; tone?: 'error' | 'warn' }> = []
  if (errors) console.push({ text: COPY.errors(errors), tone: 'error' })
  if (warnings) console.push({ text: COPY.warnings(warnings), tone: 'warn' })
  return [
    { text: COPY.console },
    ...console,
    { text: COPY.network },
    ...(failed ? [{ text: COPY.failedCount(failed), tone: 'error' as const }] : []),
  ]
}

const PATTERNS = [...LATCH_CREDENTIALS, ...CREDENTIAL_CARRIERS, ...CREDENTIAL_KEYS]

/** Credential-shaped text replaced before it goes into the draft, as the Host's logs redact it. */
export function redactText(text: string): { text: string; redacted: boolean } {
  let redacted = false
  let result = text
  for (const pattern of PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), () => {
      redacted = true
      return '[已隐藏]'
    })
  }
  return { text: result, redacted }
}

const time = (ms: number) => {
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toTimeString().slice(0, 8)
}

/**
 * Page text as the drawer shows it and the draft takes it: each line through `escapeSecurityText`, so a character that
 * could hide or reorder words is a visible `\u{XXXX}` in both, never only in one.
 */
export function visibleLines(text: string): string {
  return text
    .split(/\r\n|\n/u)
    .map(line => escapeSecurityText(line))
    .join('\n')
}

export function consoleLine(entry: BrowserConsoleEntry): string {
  const level = entry.level === 'warning' ? 'warn' : entry.level
  const where = entry.source ? ` (${entry.source}${entry.line ? `:${entry.line}` : ''})` : ''
  return visibleLines(`[${level}] ${entry.text}${where}`)
}

export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function networkStatus(entry: BrowserNetworkEntry): string {
  return entry.error ?? (entry.status === null ? '—' : String(entry.status))
}

export const failedRequest = (entry: BrowserNetworkEntry) => entry.error !== null || (entry.status !== null && entry.status >= 400)

export function networkLine(entry: BrowserNetworkEntry): string {
  return `${entry.method} ${escapeSecurityText(entry.url)} ${networkStatus(entry)} ${entry.duration === null ? '—' : `${entry.duration} ms`} ${sizeLabel(entry.size)}`
}

/**
 * 「加入对话」 from the drawer: the chosen entries, or the latest 20 errors; a fenced block under a heading that says where
 * it came from, redacted first. Undefined when there is nothing to add.
 */
export function logsDraft(input: {
  kind: 'console' | 'network'
  page: string
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  /** Main's sequence IDs of the chosen entries; empty for the latest errors. */
  selected: readonly number[]
}): { text: string; redacted: boolean } | undefined {
  const chosen = new Set(input.selected)
  const lines =
    input.kind === 'console'
      ? (chosen.size
          ? input.console.filter(entry => chosen.has(entry.id))
          : input.console.filter(entry => entry.level === 'error').slice(-DRAFT_ERRORS)
        ).map(entry => `${time(entry.time)} ${consoleLine(entry)}`)
      : (chosen.size ? input.network.filter(entry => chosen.has(entry.id)) : input.network.filter(failedRequest).slice(-DRAFT_ERRORS)).map(
          networkLine,
        )
  if (!lines.length) return undefined
  const { text, redacted } = redactText(lines.join('\n').replaceAll('```', "'''"))
  const heading = `${input.kind === 'console' ? '浏览器控制台' : '浏览器网络'} · ${escapeSecurityText(input.page)}（页面提供的内容）`
  return { text: `${heading}\n\n\`\`\`text\n${text}\n\`\`\``, redacted }
}

/** 选取元素 in the draft: the page, the selector, the tag, its words and size, marked as what the page presents. */
export function elementDraft(target: Pick<BrowserTarget, 'url' | 'tag' | 'selector' | 'text' | 'rect'>): {
  text: string
  redacted: boolean
} {
  const words = redactText(visibleLines(target.text.trim()))
  const selector = redactText(escapeSecurityText(target.selector))
  const facts = [
    `页面：${escapeSecurityText(pageLabel(target.url) || target.url)}`,
    `选择器：${selector.text}`,
    `标签：${target.tag}`,
    ...(words.text ? [`文字：${words.text}`] : []),
    `尺寸：${Math.round(target.rect.width)} × ${Math.round(target.rect.height)}`,
  ]
  // The heading's excerpt is escaped like the rest: 24 characters of what is already visible.
  const points = [...words.text.replace(/\n/gu, ' ')]
  const name = words.text ? `${target.tag}「${points.slice(0, 24).join('')}${points.length > 24 ? '…' : ''}」` : target.tag
  const text = `元素 · ${name}（页面提供的内容）\n\n\`\`\`text\n${facts.join('\n').replaceAll('```', "'''")}\n\`\`\``
  return { text, redacted: words.redacted || selector.redacted }
}

/** A file name for a screenshot or an element crop: what it shows, safe as a file name. */
export function imageName(kind: '截图' | '元素', url: string): string {
  const place = (pageLabel(url) || 'blank').replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/-+$/u, '')
  return `${kind}-${place}`.slice(0, 96) + '.png'
}

/** A crop of a frame (image pixels), from a box in the frame's own CSS pixels; the frame is `viewWidth` CSS pixels wide. */
export function cropBox(rect: BrowserRect, frame: { width: number; height: number }, viewWidth: number, pad = 8): BrowserRect | null {
  if (viewWidth <= 0) return null
  const ratio = frame.width / viewWidth
  const x = Math.max(0, Math.floor((rect.x - pad) * ratio))
  const y = Math.max(0, Math.floor((rect.y - pad) * ratio))
  const right = Math.min(frame.width, Math.ceil((rect.x + rect.width + pad) * ratio))
  const bottom = Math.min(frame.height, Math.ceil((rect.y + rect.height + pad) * ratio))
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

const recentKey = (deviceId: string, projectId: string) => `latch.browser-recent.${deviceId}.${projectId}`

/** The project's last five addresses on this device: origin and path only, never the query. */
export function readRecent(deviceId: string, projectId: string): string[] {
  try {
    const value = JSON.parse(readStorage('localStorage', recentKey(deviceId, projectId)) ?? '[]') as unknown
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && /^https?:\/\//u.test(item)).slice(0, RECENT_LIMIT)
      : []
  } catch {
    return []
  }
}

/** The list with `url` (origin and path) first. */
export function withRecent(list: readonly string[], url: string): string[] {
  const address = parsed(url)
  if (!address || (address.protocol !== 'http:' && address.protocol !== 'https:')) return [...list]
  const entry = `${address.origin}${address.pathname}`
  return [entry, ...list.filter(item => item !== entry)].slice(0, RECENT_LIMIT)
}

export function saveRecent(deviceId: string, projectId: string, list: readonly string[]): void {
  try {
    localStorage.setItem(recentKey(deviceId, projectId), JSON.stringify(list.slice(0, RECENT_LIMIT)))
  } catch {
    /* Storage full or off: the list lives as long as the page. */
  }
}

/** A tab of the window as the page knows it: whose it is and how it stands. */
export interface KnownTab {
  tabId: string
  sessionId: string
  projectId: string
  state: BrowserTabState
  /** When a local address first refused the connection in a row of tries; cleared once a load succeeds. */
  refusedSince?: number
}

/** The window's tabs in the order they opened, after main's event. */
export function withEvent(
  tabs: readonly KnownTab[],
  event:
    | { type: 'state'; tabId: string; state: BrowserTabState }
    | { type: 'closed'; tabId: string }
    | { type: 'opened'; tabId: string; projectId: string; sessionId: string; state: BrowserTabState },
  now: number,
): KnownTab[] {
  if (event.type === 'closed') return tabs.filter(tab => tab.tabId !== event.tabId)
  // A tab another page or the Agent opened joins the list; one this page opened is already in it.
  if (event.type === 'opened')
    return tabs.some(tab => tab.tabId === event.tabId)
      ? [...tabs]
      : [
          ...tabs,
          withState({ tabId: event.tabId, sessionId: event.sessionId, projectId: event.projectId, state: event.state }, event.state, now),
        ]
  return tabs.map(tab => (tab.tabId === event.tabId ? withState(tab, event.state, now) : tab))
}

/** A tab with a new state; a refused local load starts (or keeps) the retry window, a success or another error ends it. */
export function withState(tab: KnownTab, state: BrowserTabState, now: number): KnownTab {
  const refused = state.error === CONNECTION_REFUSED && isLoopbackUrl(state.url)
  const settledOk = !state.loading && state.error === null
  const { refusedSince, ...rest } = tab
  if (refused) return { ...rest, state, refusedSince: refusedSince ?? now }
  if (settledOk || (state.error !== null && !state.loading) || state.crashed) return { ...rest, state }
  return { ...rest, state, ...(refusedSince === undefined ? {} : { refusedSince }) }
}

/** What the canvas shows for a tab that is not showing its page; null when the page shows. */
export function troubleOf(tab: KnownTab | undefined, now: number): TabTrouble | null {
  if (!tab) return null
  const { state, refusedSince } = tab
  if (state.crashed) return { kind: 'crashed' }
  const host = hostLabel(state.url) || state.url
  if (refusedSince !== undefined && now - refusedSince < RETRY_FOR_MS && isLoopbackUrl(state.url)) return { kind: 'waiting', host }
  if (state.loading || state.error === null) return null
  return { kind: 'failed', host, reason: errorName(state.error) }
}

/** A tab with nothing loaded yet: the blank page stands in for it. */
export const isBlank = (state: BrowserTabState | undefined) => !state || state.url === '' || state.url === 'about:blank'

/**
 * Tabs whose session the Host reports archived, or deleted: missing from a whole listing this device sees all of. A
 * partial listing closes nothing for being absent from it.
 */
export function endedTabs(
  tabs: ReadonlyArray<{ tabId: string; sessionId: string }>,
  snapshot: { tasks: ReadonlyArray<{ id: string; archived?: boolean }>; tasksComplete?: true },
  seesAll: boolean,
): string[] {
  const listed = new Map(snapshot.tasks.map(task => [task.id, task]))
  const whole = snapshot.tasksComplete === true && seesAll
  return tabs
    .filter(tab => {
      const task = listed.get(tab.sessionId)
      return task ? task.archived === true : whole
    })
    .map(tab => tab.tabId)
}

/** Whether a point (CSS pixels of the page from the tab's corner) lies in a box, give or take `slack`. */
export function pointInside(rect: BrowserRect, point: { x: number; y: number }, slack = 0): boolean {
  return (
    point.x >= rect.x - slack
    && point.x <= rect.x + rect.width + slack
    && point.y >= rect.y - slack
    && point.y <= rect.y + rect.height + slack
  )
}
