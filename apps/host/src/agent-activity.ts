import {
  GENERAL_AGENT_ID,
  type AgentActivityItem,
  type AgentActivityPage,
  type AgentLibraryGroup,
  type AgentLibraryItem,
  type AgentLibraryPage,
  type AgentMemory,
  type AgentMemoryChange,
  type Automation,
  type AutomationRun,
  type ChangedFile,
  type MemoryProposal,
  type ScheduleResult,
  type ScheduleResultFile,
  type TaskDetail,
  type TaskSummary,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { RESULT_LIMITS, type ResultContent } from './automations.ts'

/**
 * An Agent's 动态 and 资料库, and what a schedule's result card says: all read from records the Host already keeps
 * (sessions, schedule runs, result cards, memories, proposals, each session's changes and observed outputs). Nothing here
 * is stored, and nothing is made up.
 */

/** The owner a session has in 我的 Agent: one of yours, `general` for a conversation with 通用, or none (Code). */
export function sessionOwner(task: Pick<TaskSummary, 'agent' | 'generalChat'>): string | undefined {
  return task.agent?.customAgentId ?? (task.generalChat ? GENERAL_AGENT_ID : undefined)
}

/**
 * The topic a message to the owner continues, as the page picks it: the newest not archived that is not a schedule's run.
 * Absent when the owner has none.
 */
export function currentTopic(tasks: readonly TaskSummary[], owner: string): TaskSummary | undefined {
  return tasks
    .filter(task => sessionOwner(task) === owner && !task.archived && !task.automationId)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text)
const ERROR_CODE = /^[a-z0-9-]{1,64}$/u
const STATUS_CHANGE: Record<ChangedFile['status'], ScheduleResultFile['change']> = {
  A: 'created',
  M: 'modified',
  D: 'deleted',
  R: 'created',
}

/**
 * A session's files, each path once: what its turns' own change records say, without the turns another session ran
 * beside in the same folder. The outputs observed during a turn are not used: they may hold another program's or
 * session's writes (FILE-OUTPUTS.md), so a session without change records lists no files here.
 */
function sessionFiles(changed: readonly ChangedFile[] | undefined): ScheduleResultFile[] {
  const files = new Map<string, ScheduleResultFile>()
  for (const file of changed ?? [])
    if (!files.has(`${file.root}\n${file.path}`))
      files.set(`${file.root}\n${file.path}`, { root: file.root, path: file.path, change: STATUS_CHANGE[file.status] })
  return [...files.values()]
}

/**
 * What a settled run's card says: the start of its last reply, the files it changed or produced, and why it did not
 * complete (its failure note, with that note's error code, or why its start was refused).
 */
export function resultContent(
  outcome: ScheduleResult['outcome'],
  detail: TaskDetail | undefined,
  changed: readonly ChangedFile[] | undefined,
  refused?: unknown,
): Omit<ResultContent, 'topicId'> {
  const replyText = detail?.messages.findLast(message => message.role === 'assistant' && message.text.trim())?.text.trim()
  const files = sessionFiles(changed)
  const note = detail?.messages.findLast(message => message.role === 'system' && (message.state === 'failed' || message.errorCode))
  const failure =
    refused instanceof AppError
      ? { reason: clip(refused.message, RESULT_LIMITS.reason), ...(ERROR_CODE.test(refused.code) ? { code: refused.code } : {}) }
      : refused !== undefined
        ? { reason: '没有开始运行。' }
        : outcome !== 'completed' && note?.text.trim()
          ? {
              reason: clip(note.text.trim(), RESULT_LIMITS.reason),
              ...(note.errorCode && ERROR_CODE.test(note.errorCode) ? { code: note.errorCode } : {}),
            }
          : undefined
  return {
    ...(replyText ? { reply: clip(replyText, RESULT_LIMITS.reply) } : {}),
    ...(replyText && replyText.length > RESULT_LIMITS.reply ? { replyTruncated: true as const } : {}),
    ...(files.length ? { files: files.slice(0, RESULT_LIMITS.files) } : {}),
    ...(files.length > RESULT_LIMITS.files ? { filesMore: files.length - RESULT_LIMITS.files } : {}),
    ...(failure ? { failure } : {}),
  }
}

/** A page's place: the time and ID of the last row shown. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\|([A-Za-z0-9_:.@|-]{1,600})$/u
export function parseCursor(value: string | null): { at: string; id: string } | undefined {
  if (value === null || value === '') return undefined
  const match = CURSOR.exec(value)
  if (!match) throw new AppError(400, 'agent-cursor-invalid', '翻页位置无效。')
  return { at: match[1]!, id: match[2]! }
}
const cursorOf = (row: { at: string; id: string }) => `${row.at}|${row.id}`
/** Newest first; the same time by ID, so a page boundary is exact. */
const newer = (a: { at: string; id: string }, b: { at: string; id: string }) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)
const before = (row: { at: string; id: string }, cursor: { at: string; id: string } | undefined) => !cursor || newer(cursor, row) < 0

export const ACTIVITY_PAGE = 30

/**
 * An owner's 动态, newest first: topics it started, its schedules' runs (a run that has a result card is that card),
 * cards delivered, memories added, changed or removed (never their text), and proposals with where they stand.
 */
export function activityPage(input: {
  sessions: readonly TaskSummary[]
  automations: ReadonlyArray<{ automation: Pick<Automation, 'id' | 'name'>; runs: readonly AutomationRun[] }>
  results: readonly ScheduleResult[]
  memories: readonly AgentMemory[]
  changes: readonly AgentMemoryChange[]
  proposals: readonly MemoryProposal[]
  /** The turns whose agent searched its memories. */
  recalls?: ReadonlyArray<{ sessionId: string; messageId?: string; at: string; count: number }>
  before?: string | null
  limit?: number
}): AgentActivityPage {
  const cursor = parseCursor(input.before ?? null)
  const limit = Math.min(Math.max(input.limit ?? ACTIVITY_PAGE, 1), 100)
  const items: AgentActivityItem[] = []
  for (const task of input.sessions) {
    if (task.automationId) continue
    items.push({ kind: 'topic', id: `topic:${task.id}`, at: task.createdAt ?? task.updatedAt, sessionId: task.id, title: task.title })
  }
  const carded = new Set(input.results.map(result => `${result.automationId}|${result.runAt}`))
  for (const result of input.results)
    items.push({
      kind: 'result',
      id: `result:${result.id}`,
      at: result.at,
      resultId: result.id,
      name: result.name,
      outcome: result.outcome,
      ...(result.topicId ? { topicId: result.topicId } : {}),
    })
  for (const { automation, runs } of input.automations)
    for (const run of runs) {
      if (carded.has(`${automation.id}|${run.at}`)) continue
      items.push({
        kind: 'run',
        id: `run:${automation.id}:${run.at}:${run.trigger}:${run.state}`,
        at: run.at,
        automationId: automation.id,
        name: automation.name,
        state: run.state,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      })
    }
  for (const memory of input.memories)
    items.push({ kind: 'memory', id: `memory:added:${memory.id}`, at: memory.createdAt, change: 'added', memoryId: memory.id })
  for (const change of input.changes)
    items.push({
      kind: 'memory',
      id: `memory:${change.operation}:${change.memoryId}:${change.at}`,
      at: change.at,
      change: change.operation === 'update' ? 'updated' : 'deleted',
      memoryId: change.memoryId,
    })
  for (const proposal of input.proposals)
    items.push({
      kind: 'proposal',
      id: `proposal:${proposal.id}`,
      at: proposal.createdAt,
      proposalId: proposal.id,
      proposal: proposal.kind === 'schedule' ? 'schedule' : 'memory',
      state: proposal.state,
      sessionId: proposal.source.sessionId,
    })
  for (const recall of input.recalls ?? [])
    items.push({
      kind: 'recall',
      id: `recall:${recall.sessionId}:${(recall.messageId ?? '').replace(/[^A-Za-z0-9_.@-]/gu, '_').slice(0, 200)}`,
      at: recall.at,
      sessionId: recall.sessionId,
      count: recall.count,
    })
  const shown = items.filter(item => before(item, cursor)).toSorted(newer)
  const page = shown.slice(0, limit)
  return { items: page, ...(shown.length > limit ? { next: cursorOf(page.at(-1)!) } : {}) }
}

export const LIBRARY_PAGE = 8
/** Sessions looked at for one page at most, so a page of sessions without files does not read every session. */
const LIBRARY_SCAN = 24
const GROUP_ITEMS = 30

/**
 * An owner's 资料库, newest session first: per session, the files its turns changed or produced and the attachments the
 * person gave it. Sessions with none are left out. Each session's detail and changes are read only for the page.
 */
export async function libraryPage(input: {
  sessions: readonly TaskSummary[]
  detail(sessionId: string): Promise<TaskDetail | undefined>
  files(sessionId: string): Promise<ChangedFile[] | undefined>
  before?: string | null
}): Promise<AgentLibraryPage> {
  const cursor = parseCursor(input.before ?? null)
  const ordered = input.sessions
    .map(task => ({ task, at: task.updatedAt, id: task.id }))
    .filter(row => before(row, cursor))
    .toSorted(newer)
  const groups: AgentLibraryGroup[] = []
  let scanned = 0
  for (const row of ordered) {
    if (groups.length >= LIBRARY_PAGE || scanned >= LIBRARY_SCAN) break
    scanned++
    const detail = await input.detail(row.id).catch(() => undefined)
    if (!detail) continue
    const changed = await input.files(row.id)
    const items: AgentLibraryItem[] = []
    for (const file of sessionFiles(changed)) items.push({ kind: 'file', sessionId: row.id, ...file, at: row.at })
    for (const message of detail.messages.toReversed()) {
      if (message.role !== 'user') continue
      for (const attachment of message.attachments ?? [])
        items.push({ kind: 'attachment', sessionId: row.id, messageId: message.id, attachment, at: message.createdAt ?? row.at })
    }
    if (!items.length) continue
    groups.push({
      sessionId: row.id,
      title: row.task.title,
      at: row.at,
      ...(row.task.automationId ? { automationId: row.task.automationId } : {}),
      items: items.slice(0, GROUP_ITEMS),
      ...(items.length > GROUP_ITEMS ? { more: items.length - GROUP_ITEMS } : {}),
    })
  }
  const last = ordered[scanned - 1]
  return { groups, ...(last && scanned < ordered.length ? { next: cursorOf(last) } : {}) }
}
