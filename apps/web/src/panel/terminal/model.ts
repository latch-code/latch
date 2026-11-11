import type { LocalService, TerminalSummary, TerminalText } from '@latch/protocol'

/** One call to `…/input` carries at most this much once decoded (docs/TERMINAL.md). */
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

export const tabLabel = (number: number) => `终端 ${number}`

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

/** The tab that stays selected: the same one while it exists, else its neighbour, else the first. */
export function keepActive(tabs: readonly TerminalTab[], active: string | undefined, before: readonly TerminalTab[] = tabs) {
  if (active && tabs.some(tab => tab.id === active)) return active
  const at = before.findIndex(tab => tab.id === active)
  const neighbour = at >= 0 ? (tabs.find(tab => tab.number > before[at]!.number) ?? tabs.at(-1)) : tabs[0]
  return neighbour?.id
}

/** How a terminal ended, for the line under its output; undefined while it runs. */
export function endedText(summary: TerminalSummary): string | undefined {
  if (summary.status === 'running') return undefined
  if (summary.status === 'failed') return '终端意外结束'
  if (summary.exitSignal) return `已结束 · ${summary.exitSignal}`
  return `已退出 · 代码 ${summary.exitCode ?? 0}`
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

/** The path of a terminal's stream; `from` continues after what this page already shows. */
export function streamPath(sessionId: string, terminalId: string, from?: number): string {
  const base = `tasks/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/stream`
  return from === undefined ? base : `${base}?from=${from}`
}
