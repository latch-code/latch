import { escapeSecurityText, type TerminalSummary } from '@latch/protocol'
import type { TerminalTab } from './model.ts'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    streaming: '还在生成',
    empty: '没有命令',
    multiline: '多行命令，请复制',
    long: '命令过长，请复制',
    control: '含控制、不可见或改变方向的字符',
    backslash: '以反斜杠结尾，请复制',
  },
  {
    streaming: 'Still generating',
    empty: 'No command',
    multiline: 'Copy this multi-line command',
    long: 'Copy this long command',
    control: 'Contains control, invisible or direction-changing characters',
    backslash: 'Ends with a backslash. Copy it instead.',
  },
)

/**
 * 「在终端里打开」: a command typed in at the shell's prompt for the person, who presses Enter. Text a model wrote reaches
 * their own login shell, so it goes in only as one plain line, only as a bracketed paste, and never with a line break.
 */

/** Longer than any command a person reads before pressing Enter. */
export const FILL_MAX_CHARS = 1000

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** The line to type: a code block's text without the one line break its fence ends with; nothing else is changed. */
export function fillCommand(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/**
 * Why this text is not typed in, or undefined when it may be. Each reason is the few words the action's tooltip shows.
 * Line breaks, tabs, controls, invisible and direction-changing characters all fail the security text check.
 */
export function fillRefusal(text: string, streaming = false): string | undefined {
  if (streaming) return COPY.streaming
  const command = fillCommand(text)
  if (!command.trim()) return COPY.empty
  if (/[\r\n\u2028\u2029]/u.test(command)) return COPY.multiline
  if (command.length > FILL_MAX_CHARS) return COPY.long
  if (escapeSecurityText(command) !== command) return COPY.control
  if (command.trimEnd().endsWith('\\')) return COPY.backslash
  return undefined
}

/**
 * The bytes for the terminal: the line between the paste brackets. Undefined for anything `fillRefusal` turns down, so
 * no caller can send one; the result never holds a line break, and no escape but the two brackets.
 */
export function pasteData(text: string): string | undefined {
  if (fillRefusal(text) !== undefined) return undefined
  return `${PASTE_START}${fillCommand(text)}${PASTE_END}`
}

/**
 * The shell itself reads input at its prompt and takes a bracketed paste: nothing else runs there. `filled`: the prompt
 * of each terminal a command was already typed at, which takes no second one until the person ends that line.
 */
export function atPrompt(summary: TerminalSummary, filled?: ReadonlyMap<string, number>): boolean {
  return (
    summary.status === 'running'
    && !summary.busy
    && summary.prompt !== undefined
    && summary.login === undefined
    && filled?.get(summary.id) !== summary.prompt
  )
}

/** The active tab when its shell waits at a fresh prompt; otherwise a new terminal is opened for the command. */
export function fillTab(
  tabs: readonly TerminalTab[],
  active: string | undefined,
  filled?: ReadonlyMap<string, number>,
): TerminalTab | undefined {
  const tab = tabs.find(item => item.id === active)
  return tab && atPrompt(tab.summary, filled) ? tab : undefined
}

/** Shell code blocks: what a reply means to be typed at a prompt. */
const SHELL_LANGUAGES = new Set(['sh', 'bash', 'zsh', 'fish', 'shell'])

export const isShellLanguage = (language: string | undefined) => language !== undefined && SHELL_LANGUAGES.has(language.toLowerCase())
