import type { FileDiff, Message, TaskDetail } from '@latch/protocol'
import {
  appliedDiffs,
  blockedLine,
  decisionLine,
  ranDespite,
  shownToolOutput,
  shownToolState,
  toolHeading,
  type ShownToolState,
} from './conversation.ts'
import { DECISION_COPY } from './core/securityCopy.ts'
import { diffLines, knowsOldSide, previousState } from './diff.ts'
import { dateTime, tokenText } from './format.ts'
import { currentLocale, defineCopy } from './core/i18n.ts'

const COPY = defineCopy(
  {
    queued: '等待执行',
    awaiting: '待批准',
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
    rejected: '已拒绝',
    expired: '已过期',
    blocked: '拦下',
    interrupted: 'Latch 重启时中断',
    unknown: '结果未知',
    oldUnavailable: '--- （原内容未显示）',
    oldUnknown: '--- （原内容未知）',
    tool: (title: string, state: string) => `<summary>工具：${title}${state}</summary>`,
    toolName: (name: string) => `工具名：${name}`,
    approval: (decision: string) => `审批：${decision}`,
    parameters: '参数：',
    changes: (path: string) => `改动：${path}`,
    output: '输出：',
    model: (model: string) => `模型：${model}`,
    harness: (name: string) => `Harness：${name}`,
    mode: (mode: string) => `模式：${mode}`,
    toolState: (state: string) => `（${state}）`,
    chat: '对话',
    project: (path: string) => `项目：${path}`,
    usage: (usage: string) => `用量：${usage}`,
    exported: (date: string) => `导出于：${date}`,
    untitled: '未命名会话',
    you: '## 你',
    reasoning: '<summary>思考过程</summary>',
    stoppedPartial: '_已停止，保留了部分回复。_',
    stoppedLine: '_已停止。_',
    interruptedPartial: '_回复中断，保留了部分内容。_',
    interruptedLine: '_回复中断。_',
    messageUsage: (usage: string) => `_用量：${usage}_`,
    live: '## Agent（生成中）',
  },
  {
    queued: 'Queued',
    awaiting: 'Awaiting approval',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
    rejected: 'Rejected',
    expired: 'Expired',
    blocked: 'Blocked',
    interrupted: 'Interrupted when Latch restarted',
    unknown: 'Outcome unknown',
    oldUnavailable: '--- (Original content unavailable)',
    oldUnknown: '--- (Original content unknown)',
    tool: (title: string, state: string) => `<summary>Tool: ${title}${state}</summary>`,
    toolName: (name: string) => `Tool name: ${name}`,
    approval: (decision: string) => `Approval: ${decision}`,
    parameters: 'Arguments:',
    changes: (path: string) => `Changes: ${path}`,
    output: 'Output:',
    model: (model: string) => `Model: ${model}`,
    harness: (name: string) => `Harness: ${name}`,
    mode: (mode: string) => `Mode: ${mode}`,
    toolState: (state: string) => ` (${state})`,
    chat: 'Chat',
    project: (path: string) => `Project: ${path}`,
    usage: (usage: string) => `Usage: ${usage}`,
    exported: (date: string) => `Exported: ${date}`,
    untitled: 'Untitled session',
    you: '## You',
    reasoning: '<summary>Reasoning</summary>',
    stoppedPartial: '_Stopped. Partial reply kept._',
    stoppedLine: '_Stopped._',
    interruptedPartial: '_Reply interrupted. Partial content kept._',
    interruptedLine: '_Reply interrupted._',
    messageUsage: (usage: string) => `_Usage: ${usage}_`,
    live: '## Agent (generating)',
  },
)

const toolStates: Record<ShownToolState, string> = {
  get queued() {
    return COPY.queued
  },
  get 'awaiting-approval'() {
    return COPY.awaiting
  },
  get running() {
    return COPY.running
  },
  get completed() {
    return COPY.completed
  },
  get failed() {
    return COPY.failed
  },
  get cancelled() {
    return COPY.stopped
  },
  get rejected() {
    return COPY.rejected
  },
  get expired() {
    return COPY.expired
  },
  get blocked() {
    return COPY.blocked
  },
  get interrupted() {
    return COPY.interrupted
  },
  get unknown() {
    return COPY.unknown
  },
}

/** A fence longer than any backtick run inside, so content can never close it early. */
function fence(text: string, language = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  const marks = '`'.repeat(Math.max(3, longest + 1))
  return `${marks}${language}\n${text.replace(/\n$/, '')}\n${marks}`
}

/** An inline code span that the value's own backticks cannot close. */
function code(text: string): string {
  const value = text.replace(/\r?\n/g, ' ')
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length))
  const marks = '`'.repeat(longest + 1)
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${marks}${pad}${value}${pad}${marks}`
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The export's own turn headings; the same heading inside model text is escaped so it cannot pose as a turn. */
const TURN_NAME = /^(?:你|Agent(?:（生成中）)?)$/
const ATX_TURN = /^ {0,3}#{1,6}[ \t]+(?:你|Agent(?:（生成中）)?)[ \t#\r]*$/
const EN_TURN_NAME = /^(?:You|Agent(?: \(generating\))?)$/
const EN_ATX_TURN = /^ {0,3}#{1,6}[ \t]+(?:You|Agent(?: \(generating\))?)[ \t#\r]*$/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t\r]*$/
/** Only fences at the start of a line are tracked: an indented one may belong to a list item that ends without closing it. */
const FENCE_OPEN = /^(?:(`{3,})[^`]*|(~{3,}).*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/

/** Outside inline code: images become plain links and HTML tags plain text, so a Markdown viewer loads nothing. */
function inertInline(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const run = /`+/.exec(text.slice(index))
    const end = run ? index + run.index : text.length
    out += text.slice(index, end).replace(/!\[/g, '\\![').replace(/</g, '&lt;')
    if (!run) break
    // An escaped or unmatched backtick run is literal text, not the start of code.
    const close = text[end - 1] === '\\' ? -1 : text.indexOf(run[0], end + run[0].length)
    const stop = close === -1 ? end + run[0].length : close + run[0].length
    out += text.slice(end, stop)
    index = stop
  }
  return out
}

/**
 * Model-written Markdown for a file that other viewers will open: outside fenced code, remote images and raw HTML
 * are made inert and headings that would read as one of the export's turns are escaped. A fence left open is closed
 * so it cannot swallow the turns that follow.
 */
function inertMarkdown(text: string): string {
  let fence: string | null = null
  let previous = ''
  const turnName = currentLocale() === 'en' ? EN_TURN_NAME : TURN_NAME
  const turnHeading = currentLocale() === 'en' ? EN_ATX_TURN : ATX_TURN
  const lines = text.split('\n').map(line => {
    if (fence !== null) {
      const marker = FENCE_CLOSE.exec(line)?.[1]
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      previous = ''
      return line
    }
    const opened = FENCE_OPEN.exec(line)
    if (opened) {
      fence = opened[1] ?? opened[2]!
      previous = ''
      return line
    }
    const turn = turnHeading.test(line) || (SETEXT_UNDERLINE.test(line) && turnName.test(previous.trim()))
    previous = line
    return turn ? `\\${inertInline(line.trimStart())}` : inertInline(line)
  })
  if (fence !== null) lines.push(fence)
  return lines.join('\n')
}

const OLD_SIDE_HEADER = {
  none: '--- /dev/null',
  get unavailable() {
    return COPY.oldUnavailable
  },
  get unknown() {
    return COPY.oldUnknown
  },
} as const

function unifiedDiff(diff: FileDiff): string {
  const { path, newText } = diff
  const lines = diffLines(diff.oldText, newText)
  const previous = previousState(diff)
  // Only a file the producer reported as missing is new; without previous text it may still exist.
  const out = [previous === 'text' ? `--- a/${path}` : OLD_SIDE_HEADER[previous], `+++ b/${path}`]
  for (const hunk of lines.hunks) {
    out.push(
      knowsOldSide(previous)
        ? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
        : `@@ +${hunk.newStart},${hunk.newLines} @@`,
    )
    for (const line of hunk.lines) out.push(`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`)
  }
  return out.join('\n')
}

function toolBlock(message: Message): string[] {
  const title = toolHeading(message.tool, message.toolName)
  const state = message.state ? COPY.toolState(toolStates[shownToolState(message)]) : ''
  const out = ['<details>', COPY.tool(escapeHtml(title), escapeHtml(state)), '']
  if (message.toolName && message.toolName !== title) out.push(COPY.toolName(code(message.toolName)), '')
  // How its approval ended, with the full time and where it was decided (never which device).
  const decision = message.tool?.decision
  if (decision) {
    const record = decisionLine(decision, Date.now()).full
    out.push(COPY.approval(escapeHtml(ranDespite(message) ? `${record} · ${DECISION_COPY.ranDespite}` : record)), '')
  }
  if (message.tool?.blocked) out.push(escapeHtml(blockedLine(message.tool.blocked)), '')
  if (message.tool?.input) out.push(COPY.parameters, '', fence(message.tool.input, 'json'), '')
  // The diff of a call its approval kept from running changed nothing; one that started keeps its changes.
  for (const diff of appliedDiffs(message)) out.push(COPY.changes(code(diff.path)), '', fence(unifiedDiff(diff), 'diff'), '')
  const output = shownToolOutput(message)
  if (output) out.push(COPY.output, '', fence(output), '')
  out.push('</details>', '')
  return out
}

/** Readable Markdown transcript; tool calls fold into `<details>` blocks. */
export function transcriptMarkdown(detail: TaskDetail, meta: { harness?: string; exportedAt?: Date } = {}): string {
  const { summary } = detail
  const facts = [
    meta.harness && COPY.harness(meta.harness),
    summary.model && COPY.model(summary.model),
    COPY.mode(summary.mode === 'chat' ? COPY.chat : 'Agent'),
    summary.cwd && COPY.project(code(summary.cwd)),
    summary.usage && COPY.usage(tokenText(summary.usage)),
    COPY.exported(dateTime((meta.exportedAt ?? new Date()).toISOString())),
  ].filter((fact): fact is string => typeof fact === 'string' && fact.length > 0)
  const out = [`# ${summary.title.trim() || COPY.untitled}`, '', ...facts.map(fact => `- ${fact}`), '']
  for (const message of detail.messages) {
    if (message.role === 'user') out.push(COPY.you, '', message.text, '')
    else if (message.role === 'assistant') {
      out.push('## Agent', '')
      if (message.reasoning)
        out.push(
          '<details>',
          COPY.reasoning,
          '',
          inertMarkdown(message.reasoning)
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n'),
          '',
          '</details>',
          '',
        )
      if (message.text) out.push(inertMarkdown(message.text), '')
      // Say what was kept only when something was.
      const kept = message.text.trim().length > 0
      if (message.state === 'cancelled') out.push(kept ? COPY.stoppedPartial : COPY.stoppedLine, '')
      else if (message.state === 'failed') out.push(kept ? COPY.interruptedPartial : COPY.interruptedLine, '')
      if (message.usage) out.push(COPY.messageUsage(tokenText(message.usage)), '')
    } else if (message.role === 'tool') out.push(...toolBlock(message))
    else
      out.push(
        inertMarkdown(message.text)
          .split('\n')
          .map(line => `> ${line}`)
          .join('\n'),
        '',
      )
  }
  if (detail.liveText) out.push(COPY.live, '', inertMarkdown(detail.liveText), '')
  return `${out.join('\n').trimEnd()}\n`
}

export function exportFileName(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/^[-. ]+|[-. ]+$/g, '')
  return `${safe || 'latch-session'}.md`
}

/** Shares on touch devices that support files, otherwise downloads. */
export async function saveText(name: string, text: string): Promise<void> {
  const file = new File([text], name, { type: 'text/markdown;charset=utf-8' })
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
