import type { Message, RunLive, TaskDetail } from '@latch/protocol'
import type { PermissionView } from '../composer/permission.ts'
import { livePhase, turnsOf, type LivePhaseOptions } from '../conversation.ts'
import { defineCopy } from '../core/i18n.ts'
import { MODE_COPY } from '../core/securityCopy.ts'
import { toolKind } from '../icons.tsx'

/**
 * What a helper is doing, in a person's words, only from events the Host already reports.
 * Nothing reported, nothing said: there is no word that only says time passes. The rows themselves (the command, the
 * file, the diff) stay as they are; only who acts and what it is doing read as a person.
 */
export interface PersonWord {
  words: string
  /** `waiting`: amber, the run waits on the person. */
  tone: 'running' | 'waiting'
}

const running = (words: string): PersonWord => ({ words, tone: 'running' })
const COPY = defineCopy(
  {
    waits: '等你点头',
    delegates: '在分头做',
    usingServer: (server: string) => `在用 ${server}`,
    browser: '在看网页',
    readsFiles: '在看文件',
    search: '在找东西',
    fetch: '在查资料',
    writesFiles: '在写文件',
    command: '在跑命令',
    thinking: '在想',
    tool: '在动手',
    cancelling: '在停下',
    replying: '在回复',
    starting: '在准备',
    unconfirmed: '权限没确认',
    unconfirmedDetail: (note: string) => `${note}：Latch 说不准它动手前会不会问你。Latch 也不隔离它。`,
    noAsk: '不先问你',
    noAskDetail: '它动手前不问你。Latch 也不隔离它。',
    unknownMode: 'Latch 不认识这一档，它是这个 Agent 自己的设置。Latch 也不隔离它。',
  },
  {
    waits: 'Waiting for you',
    delegates: 'Delegating',
    usingServer: (server: string) => `Using ${server}`,
    browser: 'Browsing',
    readsFiles: 'Reading files',
    search: 'Searching',
    fetch: 'Looking things up',
    writesFiles: 'Editing files',
    command: 'Running a command',
    thinking: 'Thinking',
    tool: 'Working',
    cancelling: 'Stopping',
    replying: 'Replying',
    starting: 'Getting ready',
    unconfirmed: 'Permissions unconfirmed',
    unconfirmedDetail: (note: string) => `${note}. Latch can’t tell whether the Agent will ask before acting. Latch does not isolate it.`,
    noAsk: 'Acts without asking',
    noAskDetail: 'The Agent acts without asking first. Latch does not isolate it.',
    unknownMode: 'This mode belongs to the Agent and is unfamiliar to Latch. Latch does not isolate the Agent.',
  },
)

export const WAITS_ON_YOU: PersonWord = {
  get words() {
    return COPY.waits
  },
  tone: 'waiting',
}

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
  if (message.subagent) return COPY.delegates
  const name = message.toolName ?? ''
  const server = mcpServer(name) ?? mcpServer(message.tool?.title)
  if (server) return COPY.usingServer(server)
  if (name.startsWith('browser_')) return COPY.browser
  if (READ_TOOLS.has(name)) return COPY.readsFiles
  switch (toolKind(message)) {
    case 'read':
      return COPY.readsFiles
    case 'search':
      return COPY.search
    case 'fetch':
      return COPY.fetch
    case 'edit':
    case 'delete':
    case 'move':
      return COPY.writesFiles
    case 'execute':
      return COPY.command
    case 'think':
      return COPY.thinking
    default:
      return COPY.tool
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
      return running(COPY.cancelling)
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
      return running(COPY.replying)
    case 'starting':
      return running(COPY.starting)
    case 'thinking':
    case 'model':
      return running(COPY.thinking)
  }
}

const COARSE: Record<Exclude<RunLive['activity'], 'approval'>, 'starting' | 'thinking' | 'command' | 'tool' | 'cancelling'> = {
  starting: 'starting',
  model: 'thinking',
  command: 'command',
  tool: 'tool',
  cancelling: 'cancelling',
}

/**
 * The coarse word for the lists and the header, which have only the summary's `RunLive.activity`: a tool there is any
 * tool, so it is 在动手. Absent while nothing runs.
 */
export function personActivity(live: RunLive | undefined): PersonWord | undefined {
  if (!live) return undefined
  return live.activity === 'approval' ? WAITS_ON_YOU : running(COPY[COARSE[live.activity]])
}

/** 「思考了 6 秒」 as a person says it: 「想了 6 秒」; while it streams, 「在想」. */
export const THOUGHT_WORDS = defineCopy(
  { live: '在想', settled: (time: string) => `想了 ${time}`, untimed: '想法' },
  { live: 'Thinking', settled: (time: string) => `Thought for ${time}`, untimed: 'Thoughts' },
)

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
export function helperPermissionBlocked(detail: TaskDetail | null | undefined, pendingMode?: string): boolean {
  if (!detail || (!detail.summary.agent && !detail.summary.generalChat) || detail.summary.mode === 'chat') return false
  const mode = detail.config?.find(option => option.category === 'mode')
  if (pendingMode && mode?.id === pendingMode) return true
  const expected = detail.permission?.expectedMode
  return detail.permission?.readback === 'mode' && expected !== undefined && mode?.currentValue !== expected
}

export function permissionNote(view: PermissionView | undefined, unconfirmed = false): PermissionNoteValue | undefined {
  if (unconfirmed || (view?.amber && view.label === MODE_COPY.unverifiable))
    return {
      words: COPY.unconfirmed,
      detail: COPY.unconfirmedDetail(MODE_COPY.unverifiableLine),
      tone: 'warn',
    }
  if (!view) return undefined
  if (view.amber) return { words: COPY.noAsk, detail: COPY.noAskDetail, tone: 'warn' }
  const unnamed = view.rows?.find(row => row.current && !row.tier)
  if (unnamed)
    return {
      words: view.label,
      detail: COPY.unknownMode,
      tone: 'neutral',
    }
  return undefined
}
