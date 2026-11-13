import type { Message, RunLive, TaskDetail } from '@latch/protocol'
import type { PermissionView } from '../composer/permission.ts'
import { livePhase, turnsOf, type LivePhaseOptions } from '../conversation.ts'
import { MODE_COPY } from '../core/securityCopy.ts'
import { toolKind } from '../icons.tsx'

/**
 * What a helper is doing, in a person's words, only from events the Host already reports (docs/CUSTOM-AGENTS.md#状态词).
 * Nothing reported, nothing said: there is no word that only says time passes. The rows themselves (the command, the
 * file, the diff) stay as they are; only who acts and what it is doing read as a person.
 */
export interface PersonWord {
  words: string
  /** `waiting`: amber, the run waits on the person. */
  tone: 'running' | 'waiting'
}

const running = (words: string): PersonWord => ({ words, tone: 'running' })
export const WAITS_ON_YOU: PersonWord = { words: '等你点头', tone: 'waiting' }

/** The built-in Harness's own reads, whose names say nothing a kind would. */
const READ_TOOLS = new Set(['read_file', 'list_files', 'list_folders'])

/**
 * The MCP server of a tool, by the names Latch and agents give such tools: the built-in Harness registers
 * `mcp__<server>__<tool>_<hash>`, and agents report `mcp__<server>__<tool>`.
 */
export function mcpServer(name: string | undefined): string | undefined {
  const found = /^mcp__(.+?)__./u.exec(name ?? '')
  return found?.[1]
}

/** One tool call in a person's words: what kind of work it is, never the tool's own name (an MCP server's excepted). */
export function toolWord(message: Pick<Message, 'tool' | 'toolName' | 'subagent'>): string {
  if (message.subagent) return '在分头做'
  const name = message.toolName ?? ''
  const server = mcpServer(name) ?? mcpServer(message.tool?.title)
  if (server) return `在用 ${server}`
  if (name.startsWith('browser_')) return '在看网页'
  if (READ_TOOLS.has(name)) return '在看文件'
  switch (toolKind(message)) {
    case 'read':
      return '在看文件'
    case 'search':
      return '在找东西'
    case 'fetch':
      return '在查资料'
    case 'edit':
    case 'delete':
    case 'move':
      return '在写文件'
    case 'execute':
      return '在跑命令'
    case 'think':
      return '在想'
    default:
      return '在动手'
  }
}

/**
 * The fine word for the conversation's running line, from the session's detail: the latest running tool row says what
 * it does; otherwise the reply streams (在回复), reasoning streams or the model is asked (在想), the Harness starts (在准备),
 * a stop settles (在停下), or it waits on the person (等你点头).
 */
export function personStatus(detail: TaskDetail, opts: LivePhaseOptions): PersonWord {
  const phase = livePhase(detail, opts)
  switch (phase.kind) {
    case 'cancelling':
      return running('在停下')
    case 'approval':
    case 'question':
      return WAITS_ON_YOU
    case 'tool': {
      const call = opts.messageFacts
        ? opts.messageFacts.trailing
        : turnsOf(detail.messages)
            .at(-1)
            ?.replies.findLast(message => message.role === 'tool' && message.state === 'running')
      return running(call ? toolWord(call) : toolWord({ toolName: detail.activity?.toolName }))
    }
    case 'reply':
      return running('在回复')
    case 'starting':
      return running('在准备')
    case 'thinking':
    case 'model':
      return running('在想')
  }
}

const COARSE: Record<RunLive['activity'], PersonWord> = {
  starting: running('在准备'),
  model: running('在想'),
  command: running('在跑命令'),
  tool: running('在动手'),
  approval: WAITS_ON_YOU,
  cancelling: running('在停下'),
}

/**
 * The coarse word for the lists and the header, which have only the summary's `RunLive.activity`: a tool there is any
 * tool, so it is 在动手. Absent while nothing runs.
 */
export function personActivity(live: RunLive | undefined): PersonWord | undefined {
  return live ? COARSE[live.activity] : undefined
}

/** 「思考了 6 秒」 as a person says it: 「想了 6 秒」; while it streams, 「在想」. */
export const THOUGHT_WORDS = { live: '在想', settled: (time: string) => `想了 ${time}`, untimed: '想法' } as const

/** What the frame says of a helper's permission: a few words, their reason behind ⓘ, amber or neutral. */
export interface PermissionNoteValue {
  words: string
  detail: string
  tone: 'warn' | 'neutral'
}

/**
 * What must stay said once the permission chip is gone from a helper's input: 「不先问你」 when it does not ask before it
 * acts (a mode or Harness that does not ask), 「权限没确认」 when Latch cannot read its mode back,
 * and a mode Latch has no word for by its own name, neutral. Asking first, the default, says nothing. `detail` goes
 * behind ⓘ, names no Harness, and says that Latch does not isolate it either.
 */
/** The Host expected a verifiable mode, but its current report does not establish it. Unreadable native modes alone are not a lock. */
export function helperPermissionBlocked(detail: TaskDetail | null | undefined): boolean {
  if (!detail || (!detail.summary.agent && !detail.summary.generalChat) || detail.summary.mode === 'chat') return false
  const expected = detail.permission?.expectedMode
  return (
    detail.permission?.readback === 'mode'
    && expected !== undefined
    && detail.config?.find(option => option.category === 'mode')?.currentValue !== expected
  )
}

export function permissionNote(view: PermissionView | undefined, unconfirmed = false): PermissionNoteValue | undefined {
  if (unconfirmed || (view?.amber && view.label === MODE_COPY.unverifiable))
    return {
      words: '权限没确认',
      detail: `${MODE_COPY.unverifiableLine}：Latch 说不准它动手前会不会问你。Latch 也不隔离它。`,
      tone: 'warn',
    }
  if (!view) return undefined
  if (view.amber) return { words: '不先问你', detail: '它动手前不问你。Latch 也不隔离它。', tone: 'warn' }
  const unnamed = view.rows?.find(row => row.current && !row.tier)
  if (unnamed)
    return {
      words: view.label,
      detail: 'Latch 不认识这一档，它是这个 Agent 自己的设置。Latch 也不隔离它。',
      tone: 'neutral',
    }
  return undefined
}
