import type { StatusTone } from '@latch/ui'
import type {
  AgentActivityItem,
  AgentLibraryGroup,
  AppSnapshot,
  MemoryProposal,
  ScheduleResult,
  ScheduleResultOutcome,
} from '@latch/protocol'
import { RUN_WORDS, scheduleWords } from './model.ts'
import { NEW_SCHEDULE, type ScheduleDraft } from './scheduleModel.ts'

/**
 * What an Agent's result cards, schedule proposals, 动态 and 资料库 say, from the Host's records only: nothing here
 * invents an event or a file.
 */

/** How a run ended, in a word and its tone: red only for a real failure, amber where the result is not known. */
export function outcomeWord(outcome: ScheduleResultOutcome): { word: string; tone: StatusTone } {
  switch (outcome) {
    case 'completed':
      return { word: '已完成', tone: 'done' }
    case 'failed':
      return { word: '失败', tone: 'failed' }
    case 'cancelled':
      return { word: '已停止', tone: 'neutral' }
    case 'interrupted':
      return { word: '已中断', tone: 'warn' }
    default:
      return { word: '结果未知', tone: 'warn' }
  }
}

/** Rows the input field shows: all of a proposed input up to a screenful, so what the Agent wrote is read whole. */
export function inputRows(prompt: string): number {
  return Math.min(14, Math.max(4, prompt.split('\n').length + 1))
}

/** Lines and characters a card shows before 展开. */
const SHORT_LINES = 4
const SHORT_CHARS = 280

/** The start of a reply for a card: `more` when 展开 shows more, or the reply was cut by the Host. */
export function replyPreview(result: Pick<ScheduleResult, 'reply' | 'replyTruncated'>): { short: string; more: boolean } {
  const reply = result.reply ?? ''
  const lines = reply.split('\n')
  let short = lines.slice(0, SHORT_LINES).join('\n')
  if (short.length > SHORT_CHARS) short = `${short.slice(0, SHORT_CHARS - 1)}…`
  else if (lines.length > SHORT_LINES) short = `${short}…`
  return { short, more: short !== reply }
}

/** The schedule editor opened from a schedule proposal: saving it creates the schedule and marks the proposal. */
export interface SchedulePrefill {
  proposalId: string
  draft: ScheduleDraft
  /** It was proposed after the Agent may have read outside content. */
  external: boolean
}

/** 想定时：<name> · <when>. */
export function scheduleProposalLine(proposal: Pick<MemoryProposal, 'schedule'>): string {
  const schedule = proposal.schedule
  return schedule ? `${schedule.name} · ${scheduleWords(schedule.plan)}` : ''
}

/**
 * The editor's form for a schedule proposal: its name, when and input, at home unless the person chooses a project,
 * and no notification until the person turns it on.
 */
export function proposalDraft(proposal: Pick<MemoryProposal, 'schedule' | 'content'>): ScheduleDraft {
  const plan = proposal.schedule?.plan
  return {
    ...NEW_SCHEDULE,
    name: proposal.schedule?.name ?? '',
    kind: plan?.kind ?? NEW_SCHEDULE.kind,
    day: plan?.kind === 'weekly' ? plan.day : NEW_SCHEDULE.day,
    time: plan?.time ?? NEW_SCHEDULE.time,
    prompt: proposal.content,
  }
}

const PROPOSAL_STATE: Record<MemoryProposal['state'], string> = { pending: '等你决定', saved: '已保存', dismissed: '不要了' }
const MEMORY_WORDS = { added: '记忆 +1', updated: '记忆已修改', deleted: '记忆 −1' } as const

/** One 动态 row in words: a lead, what it is about, and a state with its tone. Never a memory's or a proposal's text. */
export function activityWords(item: AgentActivityItem): { lead: string; subject?: string; state?: { word: string; tone: StatusTone } } {
  switch (item.kind) {
    case 'topic':
      return { lead: '新话题', subject: item.title || '未命名会话' }
    case 'run':
      return {
        lead: '定时',
        subject: item.name,
        state: {
          word: RUN_WORDS[item.state],
          tone:
            item.state === 'running'
              ? 'running'
              : item.state === 'waiting' || item.state === 'missed' || item.state === 'skipped' || item.state === 'unknown'
                ? 'warn'
                : item.state === 'failed'
                  ? 'failed'
                  : item.state === 'completed'
                    ? 'done'
                    : 'neutral',
        },
      }
    case 'result':
      return { lead: '定时结果', subject: item.name, state: outcomeWord(item.outcome) }
    case 'memory':
      return { lead: MEMORY_WORDS[item.change] }
    case 'proposal':
      return {
        lead: item.proposal === 'schedule' ? '提议定时' : '提议记忆',
        state: { word: PROPOSAL_STATE[item.state], tone: item.state === 'pending' ? 'warn' : item.state === 'saved' ? 'done' : 'neutral' },
      }
  }
}

/** Where a 动态 row leads: a session to open, the memory section, or nowhere. */
export function activityTarget(item: AgentActivityItem): { session: string } | { memory: true } | undefined {
  switch (item.kind) {
    case 'topic':
      return { session: item.sessionId }
    case 'run':
      return item.sessionId ? { session: item.sessionId } : undefined
    case 'result':
      return item.topicId ? { session: item.topicId } : undefined
    case 'proposal':
      return { session: item.sessionId }
    case 'memory':
      return { memory: true }
  }
}

/** 今天 / 本周 / 更早, by this device's clock. */
export function dayBucket(at: string, now = Date.now()): '今天' | '本周' | '更早' {
  const date = new Date(at)
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (date.getTime() >= start) return '今天'
  if (date.getTime() >= start - 6 * 86_400_000) return '本周'
  return '更早'
}

/** Rows split into 今天 / 本周 / 更早, in their order; empty buckets are left out. */
export function bucketed<T extends { at: string }>(rows: readonly T[], now = Date.now()): Array<{ label: string; rows: T[] }> {
  const buckets: Array<{ label: string; rows: T[] }> = []
  for (const row of rows) {
    const label = dayBucket(row.at, now)
    const last = buckets.at(-1)
    if (last?.label === label) last.rows.push(row)
    else buckets.push({ label, rows: [row] })
  }
  return buckets
}

/** The 资料库 group's heading: the topic's title, or the schedule's name for a run. */
export function groupTitle(group: Pick<AgentLibraryGroup, 'title'>): string {
  return group.title || '未命名会话'
}

/** What the snapshot says of an owner's result cards, so its reads are made again when one arrives or moves. */
export function resultsVersion(snapshot: Pick<AppSnapshot, 'agentResults' | 'customAgents'>, owner: string): string {
  const state = snapshot.agentResults?.[owner]
  return `${state?.unbound ?? 0}:${state?.at ?? ''}:${snapshot.customAgents === undefined ? 'absent' : 'present'}`
}

/** 动态 and 资料库 are read again when the owner's topics, runs, cards, memories or proposals change. */
export function activityVersion(
  snapshot: Pick<AppSnapshot, 'agentResults' | 'agentProposals' | 'customAgents' | 'tasks' | 'automations'>,
  owner: string,
): string {
  const agent = snapshot.customAgents?.find(item => item.id === owner)
  const proposals = snapshot.agentProposals?.[owner]
  const topics = snapshot.tasks
    .filter(
      task =>
        (task.agent?.customAgentId ?? (task.generalChat ? 'general' : undefined)) === owner
        || (task.automationId
          && snapshot.automations?.some(item => item.id === task.automationId && (item.customAgentId ?? 'general') === owner)),
    )
    // A topic that is streaming changes all the time: read again when it settles, not on every token.
    .map(task => `${task.id}:${task.status === 'running' || task.status === 'waiting-approval' ? 'live' : task.updatedAt}`)
    .join()
  return [resultsVersion(snapshot, owner), agent?.revision ?? '', agent?.memoryCount ?? '', proposals?.at ?? '', topics].join('|')
}
