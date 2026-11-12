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

export const PRESETS: ReadonlyArray<{ id: Exclude<BrowserPreset, 'fit'>; label: string; width: number; height: number }> = [
  { id: 'phone', label: '手机', width: 390, height: 844 },
  { id: 'tablet', label: '平板', width: 820, height: 1180 },
  { id: 'desktop', label: '桌面', width: 1280, height: 800 },
]

export const SCHEMES: ReadonlyArray<{ id: BrowserColorScheme; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
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
  const roomWidth = Math.max(0, canvas.width - PRESET_GAP * 2)
  const roomHeight = Math.max(0, canvas.height - PRESET_GAP * 2 - CAPTION_HEIGHT)
  const scale = Math.max(0, Math.min(1, roomWidth / size.width, roomHeight / size.height))
  const width = Math.floor(size.width * scale)
  const height = Math.floor(size.height * scale)
  const x = canvas.x + Math.round((canvas.width - width) / 2)
  const y = canvas.y + Math.max(PRESET_GAP, Math.round((canvas.height - CAPTION_HEIGHT - height) / 2))
  return { rect: { x, y, width, height }, scale, size }
}

/** 「390 × 844 · 75%」 */
export function presetCaption(size: { width: number; height: number }, scale: number): string {
  return `${size.width} × ${size.height} · ${Math.round(scale * 100)}%`
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
  if (!state) return '新标签'
  const title = state.title.trim()
  if (title && title !== state.url && !/^https?:\/\//u.test(title)) return title
  return hostLabel(state.url) || '新标签'
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
      return '页面想下载文件，已拦下'
    case 'popup':
      return '页面想打开新窗口，已拦下'
    case 'certificate':
      return '证书无效，已拒绝连接'
    case 'permission':
      return '页面请求的权限已拒绝'
    case 'navigation':
      return detail === 'host'
        ? '页面想访问 Latch，已拦下'
        : detail === 'private'
          ? '页面想去局域网或这台 Mac 的其他地址，已拦下'
          : '页面想去的地址不能打开，已拦下'
    default:
      return '已拦下页面的请求'
  }
}

/** What a refused open or navigate means, for the address field. */
export function refusalText(error: string, reason?: string): string {
  if (error === 'invalid-url' || error === 'invalid') return '只能打开 http 或 https 地址'
  if (error === 'blocked') return reason === 'host' ? '不能在这里打开 Latch 自己的地址' : '不能打开这个地址'
  if (error === 'tab-limit') return `最多 ${BROWSER_TAB_LIMIT} 个标签`
  if (error === 'project-limit') return '打开的项目太多了，请重启 Latch'
  if (error === 'unavailable') return '窗口还没准备好，请重试'
  return '没有打开'
}

/** The bottom row: counts in their tones; red only for errors, amber only for warnings. */
export function footerParts(logs: BrowserTabState['logs'] | undefined): Array<{ text: string; tone?: 'error' | 'warn' }> {
  const errors = logs?.errors ?? 0
  const warnings = logs?.warnings ?? 0
  const failed = logs?.failed ?? 0
  const console: Array<{ text: string; tone?: 'error' | 'warn' }> = []
  if (errors) console.push({ text: `${errors} 个错误`, tone: 'error' })
  if (warnings) console.push({ text: `${warnings} 个警告`, tone: 'warn' })
  return [{ text: '控制台' }, ...console, { text: '网络' }, ...(failed ? [{ text: `${failed} 个失败`, tone: 'error' as const }] : [])]
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
  event: { type: 'state'; tabId: string; state: BrowserTabState } | { type: 'closed'; tabId: string },
  now: number,
): KnownTab[] {
  if (event.type === 'closed') return tabs.filter(tab => tab.tabId !== event.tabId)
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
