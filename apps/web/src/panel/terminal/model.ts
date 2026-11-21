import type { LocalService, TerminalSummary, TerminalTarget, TerminalText } from '@latch/protocol'
import { defineCopy, formatNumber } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    tab: (number: number) => `终端 ${formatNumber(number)}`,
    unexpected: '终端意外结束',
    signal: (value1: string | number) => `已结束 · ${value1}`,
    exited: (code: number) => `已退出 · 代码 ${formatNumber(code)}`,
  },
  {
    tab: (number: number) => `Terminal ${formatNumber(number)}`,
    unexpected: 'Terminal ended unexpectedly',
    signal: (value1: string | number) => `Ended · ${value1}`,
    exited: (code: number) => `Exited · Code ${formatNumber(code)}`,
  },
)

/** One call to `…/input` carries at most this much once decoded. */
export const INPUT_CHUNK_BYTES = 64 * 1024
/** Output handed to xterm and not yet parsed; past this the stream stops reading, so the Host stops writing. */
export const PARSE_HIGH_WATER = 256 * 1024
/** Without a selection, 「加入对话」 takes this many of the last lines. */
export const ATTACH_LAST_LINES = 40

export interface TerminalTab {
  id: string
  /** 终端 1, 2…: the lowest number free when this page first saw it. */
  number: number
  summary: TerminalSummary
}

/** A tab's name: the Harness whose login command runs in it, else 终端 N. */
export const tabName = (tab: Pick<TerminalTab, 'number' | 'summary'>) => tab.summary.login?.name ?? COPY.tab(tab.number)

/**
 * The Host's list in tab order. A terminal keeps the number it was first shown with; a new one takes the lowest number
 * free, in the order the Host opened them, so a page that loads again names them 1, 2… once more.
 */
export function nameTabs(previous: readonly TerminalTab[], terminals: readonly TerminalSummary[], wanted?: ReadonlyMap<string, number>) {
  const known = new Map(previous.map(tab => [tab.id, tab.number]))
  const used = new Set<number>()
  const tabs: TerminalTab[] = []
  const fresh: TerminalSummary[] = []
  for (const summary of terminals) {
    const number = known.get(summary.id)
    if (number === undefined) fresh.push(summary)
    else {
      used.add(number)
      tabs.push({ id: summary.id, number, summary })
    }
  }
  for (const summary of fresh.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    let number = wanted?.get(summary.id)
    if (number === undefined || used.has(number)) {
      number = 1
      while (used.has(number)) number++
    }
    used.add(number)
    tabs.push({ id: summary.id, number, summary })
  }
  return tabs.toSorted((a, b) => a.number - b.number)
}

/**
 * The terminal that stays focused: the same one while it exists, else `successor`'s pick (a sibling pane of the same
 * tab), else its neighbour by number, else the first.
 */
export function keepActive(
  tabs: readonly TerminalTab[],
  active: string | undefined,
  before: readonly TerminalTab[] = tabs,
  successor?: (id: string) => string | undefined,
) {
  if (active && tabs.some(tab => tab.id === active)) return active
  const next = active === undefined ? undefined : successor?.(active)
  if (next !== undefined && tabs.some(tab => tab.id === next)) return next
  const at = before.findIndex(tab => tab.id === active)
  const neighbour = at >= 0 ? (tabs.find(tab => tab.number > before[at]!.number) ?? tabs.at(-1)) : tabs[0]
  return neighbour?.id
}

/**
 * Whether the surface starts a terminal now: it is on screen and wants one, the Host listed none, and this showing has
 * not tried yet (a failed try leaves its reason and 重试 instead of trying again by itself).
 */
export function opensFirstTerminal(state: {
  shown: boolean
  wanted: boolean
  read: 'loading' | 'ready' | 'failed'
  tabs: number
  tried: boolean
}): boolean {
  return state.shown && state.wanted && state.read === 'ready' && state.tabs === 0 && !state.tried
}

/** How a terminal ended, for the line under its output; undefined while it runs. */
export function endedText(summary: TerminalSummary): string | undefined {
  if (summary.status === 'running') return undefined
  if (summary.status === 'failed') return COPY.unexpected
  if (summary.exitSignal) return COPY.signal(summary.exitSignal)
  return COPY.exited(summary.exitCode ?? 0)
}

/** `localhost:5173`, for a link that opens the whole origin. */
export const serviceLabel = (service: LocalService) => service.origin.replace(/^https?:\/\//u, '')

const encoder = new TextEncoder()

/** What xterm hands over (a keystroke, or a whole paste with its brackets), as the Host's input calls, in order. */
export function inputChunks(data: string): Uint8Array[] {
  const bytes = encoder.encode(data)
  const chunks: Uint8Array[] = []
  for (let start = 0; start < bytes.length; start += INPUT_CHUNK_BYTES) chunks.push(bytes.subarray(start, start + INPUT_CHUNK_BYTES))
  return chunks
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

interface KeyStroke {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

/**
 * While the terminal has focus every key is the shell's, but ⌘ chords: those stay Latch's and the system's (⌘C and ⌘V
 * copy and paste, ⌘K searches, ⌘L goes back to the composer). Ctrl, ⌥ and Esc reach the program in the terminal.
 */
export const keyLeavesTerminal = (event: KeyStroke) => event.metaKey

/** The extract as Markdown for the draft: the terminal's name, then the text in a fence longer than any it holds. */
export function draftText(label: string, extract: TerminalText): string {
  const longest = Math.max(2, ...[...extract.text.matchAll(/`+/gu)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return [`${label}${extract.truncated ? '（较早的输出未包含）' : ''}`, `${fence}text`, extract.text.replace(/\n+$/u, ''), fence].join('\n')
}

export function terminalPath(target: TerminalTarget | string): string {
  if (typeof target === 'string') return `tasks/${encodeURIComponent(target)}/terminals`
  return target.workspaceId === undefined
    ? `tasks/${encodeURIComponent(target.sessionId)}/terminals`
    : `workspaces/${encodeURIComponent(target.workspaceId)}/terminals`
}

/** The path of a terminal's stream; `from` continues after what this page already shows. */
export function streamPath(target: TerminalTarget | string, terminalId: string, from?: number): string {
  const base = `${terminalPath(target)}/${encodeURIComponent(terminalId)}/stream`
  return from === undefined ? base : `${base}?from=${from}`
}
