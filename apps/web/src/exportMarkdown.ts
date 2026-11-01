import type { FileDiff, Message, TaskDetail } from '@latch/protocol'
import {
  appliedDiffs,
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

const toolStates: Record<ShownToolState, string> = {
  queued: '等待执行',
  'awaiting-approval': '待批准',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  rejected: '已拒绝',
  expired: '已过期',
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
    const turn = ATX_TURN.test(line) || (SETEXT_UNDERLINE.test(line) && TURN_NAME.test(previous.trim()))
    previous = line
    return turn ? `\\${inertInline(line.trimStart())}` : inertInline(line)
  })
  if (fence !== null) lines.push(fence)
  return lines.join('\n')
}

const OLD_SIDE_HEADER = { none: '--- /dev/null', unavailable: '--- （原内容未显示）', unknown: '--- （原内容未知）' } as const

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
  const state = message.state ? `（${toolStates[shownToolState(message)]}）` : ''
  const out = ['<details>', `<summary>工具：${escapeHtml(title)}${escapeHtml(state)}</summary>`, '']
  if (message.toolName && message.toolName !== title) out.push(`工具名：${code(message.toolName)}`, '')
  // How its approval ended, with the full time and where it was decided (never which device).
  const decision = message.tool?.decision
  if (decision) {
    const record = decisionLine(decision, Date.now()).full
    out.push(`审批：${escapeHtml(ranDespite(message) ? `${record} · ${DECISION_COPY.ranDespite}` : record)}`, '')
  }
  if (message.tool?.input) out.push('参数：', '', fence(message.tool.input, 'json'), '')
  // The diff of a call its approval kept from running changed nothing; one that started keeps its changes.
  for (const diff of appliedDiffs(message)) out.push(`改动：${code(diff.path)}`, '', fence(unifiedDiff(diff), 'diff'), '')
  const output = shownToolOutput(message)
  if (output) out.push('输出：', '', fence(output), '')
  out.push('</details>', '')
  return out
}

/** Readable Markdown transcript; tool calls fold into `<details>` blocks. */
export function transcriptMarkdown(detail: TaskDetail, meta: { harness?: string; exportedAt?: Date } = {}): string {
  const { summary } = detail
  const facts = [
    meta.harness && `Harness：${meta.harness}`,
    summary.model && `模型：${summary.model}`,
    `模式：${summary.mode === 'chat' ? '对话' : 'Agent'}`,
    summary.cwd && `项目：${code(summary.cwd)}`,
    summary.usage && `用量：${tokenText(summary.usage)}`,
    `导出于：${dateTime((meta.exportedAt ?? new Date()).toISOString())}`,
  ].filter((fact): fact is string => typeof fact === 'string' && fact.length > 0)
  const out = [`# ${summary.title.trim() || '未命名会话'}`, '', ...facts.map(fact => `- ${fact}`), '']
  for (const message of detail.messages) {
    if (message.role === 'user') out.push('## 你', '', message.text, '')
    else if (message.role === 'assistant') {
      out.push('## Agent', '')
      if (message.reasoning)
        out.push(
          '<details>',
          '<summary>思考过程</summary>',
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
      if (message.state === 'cancelled') out.push(kept ? '_已停止，保留了部分回复。_' : '_已停止。_', '')
      else if (message.state === 'failed') out.push(kept ? '_回复中断，保留了部分内容。_' : '_回复中断。_', '')
      if (message.usage) out.push(`_用量：${tokenText(message.usage)}_`, '')
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
  if (detail.liveText) out.push('## Agent（生成中）', '', inertMarkdown(detail.liveText), '')
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
