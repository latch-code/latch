import {
  HANDOFF_LIMITS,
  type AppSnapshot,
  type FileMention,
  type Handoff,
  type HandoffCreate,
  type HandoffEvidence,
  type HandoffMaterial,
  type HandoffReturn,
  type HandoffReturnScope,
  type HandoffSummary,
  type Message,
  type TaskSummary,
  type DataScope,
  readsProjectFiles,
} from '@latch/protocol'
import { ApiError, isUncertain, MessageError } from '../core/api.ts'

/** 回传: what the target may hand back. The Host keeps three scopes, so the page offers three. */
export const RETURN_SCOPES: ReadonlyArray<{ value: HandoffReturnScope; label: string }> = [
  { value: 'none', label: '不交回' },
  { value: 'summary', label: '结论' },
  { value: 'summary-and-evidence', label: '加证据' },
]

/** Where the result goes, in a few words beside the choice. */
export const SCOPE_LINES: Record<HandoffReturnScope, string> = {
  none: '不回到这里',
  summary: '交回到这个会话',
  'summary-and-evidence': '交回到这个会话',
}

/** The fact behind each scope's ⓘ. */
export const SCOPE_FACTS: Record<HandoffReturnScope, string> = {
  none: '代码会话照常运行，结果不回到这里；在那边用「结束交接」收尾。',
  summary: '代码会话结束后，由你在那边把结论交回这个会话。',
  'summary-and-evidence': '代码会话结束后，由你在那边把结论连同选中的文件与消息交回这个会话，各带链接。',
}

/** 「回传：结论」 in a few words, for lines that only say what was agreed. */
export const scopeWords = (scope: HandoffReturnScope) => RETURN_SCOPES.find(item => item.value === scope)?.label ?? scope

const fileKey = (file: FileMention) => `${file.root}\u0000${file.path}`
export const fileName = (file: FileMention) => file.path.split('/').at(-1) ?? file.path

/** Files a session names: what the person mentioned and what its turns wrote, once each, deleted ones left out. */
export function sessionFiles(messages: readonly Message[]): FileMention[] {
  const seen = new Map<string, FileMention>()
  for (const message of messages) {
    for (const ref of message.fileRefs ?? []) if (!seen.has(fileKey(ref))) seen.set(fileKey(ref), { root: ref.root, path: ref.path })
    for (const change of message.outputs ?? [])
      if (change.change !== 'deleted' && !seen.has(fileKey(change))) seen.set(fileKey(change), { root: change.root, path: change.path })
  }
  return [...seen.values()]
}

/** One line of a message, for a chip or a checklist row. */
export function messageLine(text: string, max = 40): string {
  const line =
    text
      .split('\n')
      .map(part => part.trim())
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * A chip of 材料. A message or file chip is pinned to the version it had when chosen, by SHA-256 of its text or bytes;
 * `pinning` while that is computed, `failed` when it could not be read.
 */
export type MaterialChip =
  | { key: string; kind: 'text'; text: string }
  | { key: string; kind: 'message'; messageId: string; role: 'user' | 'assistant'; line: string; hash?: string; problem?: string }
  | { key: string; kind: 'file'; file: FileMention; hash?: string; problem?: string }

export const chipKey = {
  text: (index: number) => `text:${index}`,
  message: (id: string) => `message:${id}`,
  file: (file: FileMention) => `file:${fileKey(file)}`,
}

export function chipLabel(chip: MaterialChip): string {
  if (chip.kind === 'text') return `选中的文字 · ${messageLine(chip.text, 24)}`
  if (chip.kind === 'message') return `${chip.role === 'user' ? '你的消息' : 'Agent 的回复'} · ${chip.line}`
  return fileName(chip.file)
}

/** More Agent replies than this read as one row with their count; the materials themselves are unchanged. */
export const REPLY_ROWS = 3

/**
 * The Agent replies among the chips when there are enough to read as one row, with whether that row must stay open
 * because one of them blocks sending (could not be read, or changed since it was chosen). Undefined: show every chip.
 */
export function replyGroup(
  chips: readonly MaterialChip[],
  changed: readonly string[] = [],
): { keys: Set<string>; open: boolean; pinning: boolean } | undefined {
  const replies = chips.filter(chip => chip.kind === 'message' && chip.role === 'assistant')
  if (replies.length <= REPLY_ROWS) return undefined
  return {
    keys: new Set(replies.map(chip => chip.key)),
    open: replies.some(chip => changed.includes(chip.key) || (chip.kind !== 'text' && chip.problem !== undefined)),
    pinning: replies.some(chip => chip.kind !== 'text' && !chip.hash && !chip.problem),
  }
}

/** The materials as the Host takes them, or why not yet: a chip still pinning or one that could not be read. */
export function materialsOf(chips: readonly MaterialChip[]): { materials: HandoffMaterial[] } | { problem: string } {
  const materials: HandoffMaterial[] = []
  for (const chip of chips) {
    if (chip.kind === 'text') materials.push({ kind: 'text', text: chip.text })
    else if (chip.problem) return { problem: `「${chipLabel(chip)}」${chip.problem}` }
    else if (!chip.hash) return { problem: '正在固定材料的版本' }
    else if (chip.kind === 'message') materials.push({ kind: 'message', messageId: chip.messageId, hash: chip.hash })
    else materials.push({ kind: 'file', file: chip.file, hash: chip.hash })
  }
  if (materials.length > HANDOFF_LIMITS.materials) return { problem: `材料最多 ${HANDOFF_LIMITS.materials} 项` }
  return { materials }
}

const utf8 = new TextEncoder()
export const utf8Bytes = (text: string) => utf8.encode(text).length

/** SHA-256 in lowercase hex, as the Host names versions. */
export async function sha256Hex(
  input: string | ArrayBuffer,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<string> {
  if (!subtle) throw new MessageError('这个页面不能核对文件版本，请用 HTTPS 或这台电脑上的 Latch 打开。')
  const data = typeof input === 'string' ? utf8.encode(input) : new Uint8Array(input)
  const digest = new Uint8Array(await subtle.digest('SHA-256', data))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** What the person filled in, before it becomes a request. */
export interface HandoffForm {
  target:
    | {
        kind: 'new-session'
        projectId?: string
        harnessId?: string
        model?: { providerId: string; model: string }
        worktree: boolean
        mode: 'chat' | 'agent'
      }
    | { kind: 'session'; sessionId?: string }
  requirements: string
  decisions: string[]
  returnScope: HandoffReturnScope
}

/** Why the form cannot be sent as it is, in a few words; undefined when it can. */
export function formProblem(form: HandoffForm, chips: readonly MaterialChip[]): string | undefined {
  const pinned = materialsOf(chips)
  if ('problem' in pinned) return pinned.problem
  if (!pinned.materials.length && !form.requirements.trim()) return '选一项材料或写下要求'
  if (form.target.kind === 'session' && !form.target.sessionId) return '选一个已有会话'
  if (form.target.kind === 'new-session' && !form.target.harnessId) return '先选 Harness'
  if (form.target.kind === 'new-session' && form.target.worktree && chips.some(chip => chip.kind === 'file'))
    return '新工作树里没有选定的文件版本：去掉文件，或改用当前文件夹'
  if (utf8Bytes(form.requirements) > HANDOFF_LIMITS.requirementsBytes) return `要求最多 ${HANDOFF_LIMITS.requirementsBytes / 1024} KB`
  const text = chips.reduce((sum, chip) => sum + (chip.kind === 'text' ? utf8Bytes(chip.text) : 0), 0)
  if (text > HANDOFF_LIMITS.materialBytes) return `选中的文字合计最多 ${HANDOFF_LIMITS.materialBytes / 1024} KB`
  return undefined
}

/** The request for `POST /handoffs`. The locale is always named, so the record says exactly what was asked. */
export function createBody(requestId: string, sourceSessionId: string, form: HandoffForm, materials: HandoffMaterial[]): HandoffCreate {
  const decisions = form.decisions.map(item => item.trim()).filter(Boolean)
  const target: HandoffCreate['target'] =
    form.target.kind === 'session'
      ? { kind: 'session', sessionId: form.target.sessionId! }
      : {
          kind: 'new-session',
          ...(form.target.projectId ? { projectId: form.target.projectId } : {}),
          ...(form.target.harnessId ? { harnessId: form.target.harnessId } : {}),
          mode: form.target.mode,
          ...(form.target.model ? { model: form.target.model } : {}),
          ...(form.target.worktree ? { worktree: true as const } : {}),
        }
  return {
    requestId,
    sourceSessionId,
    target,
    materials,
    requirements: form.requirements.trim(),
    decisions,
    returnScope: form.returnScope,
    locale: 'zh-CN',
  }
}

/**
 * The same request again, rebuilt from the record: the Host's receipt compares a canonical hash of what was asked, so a
 * retry with the record's own fields is the same request. Undefined when this reader cannot see the source's fields.
 */
export function retryBody(handoff: Handoff, requestId = handoff.requestId): HandoffCreate | undefined {
  if (handoff.materials === undefined || handoff.requirements === undefined || handoff.decisions === undefined) return undefined
  return {
    requestId,
    sourceSessionId: handoff.sourceSessionId,
    target: handoff.target,
    materials: handoff.materials,
    requirements: handoff.requirements,
    decisions: handoff.decisions,
    returnScope: handoff.returnScope,
    locale: handoff.locale,
  }
}

/** How a write ended, when it did not answer with its result. */
export type WriteFailure =
  | { kind: 'unknown'; message: string }
  | { kind: 'denied'; message: string; code: string }
  | { kind: 'refused'; message: string; code?: string; items?: number[] }

export function writeFailure(error: unknown): WriteFailure {
  if (error instanceof ApiError && error.code === 'agent-write-unknown') return { kind: 'unknown', message: error.message }
  if (isUncertain(error)) return { kind: 'unknown', message: '已发出，Mac 没有回答；重试不会多建一个会话。' }
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: 'denied', message: error.message, code: error.code }
    const listed = (error.details as Record<string, unknown>).materials ?? (error.details as Record<string, unknown>).evidence
    const items = Array.isArray(listed) ? listed.filter((value): value is number => Number.isInteger(value)) : undefined
    return { kind: 'refused', message: error.message, code: error.code, ...(items?.length ? { items } : {}) }
  }
  return { kind: 'refused', message: error instanceof Error ? error.message : '没有交接，请重试。' }
}

/** The chips a refusal names, by the materials' order in the request. */
export function namedChips(chips: readonly MaterialChip[], items: readonly number[] | undefined): MaterialChip[] {
  return (items ?? []).flatMap(index => (chips[index] ? [chips[index]!] : []))
}

/** A handoff's state as a status word: amber only where it waits for the person. */
export function statusWords(handoff: Pick<Handoff, 'status' | 'returnScope'>): {
  tone: 'neutral' | 'waiting' | 'running' | 'failed' | 'done' | 'warn'
  words: string
} {
  switch (handoff.status) {
    case 'starting':
      return { tone: 'running', words: '正在开始' }
    case 'started':
      return handoff.returnScope === 'none' ? { tone: 'done', words: '已开始' } : { tone: 'running', words: '代码会话在做' }
    case 'start-unknown':
      return { tone: 'warn', words: '结果未知' }
    case 'start-failed':
      return { tone: 'failed', words: '没有开始' }
    case 'returned':
      return { tone: 'done', words: '已交回' }
    case 'withdrawn':
      return { tone: 'neutral', words: '已撤回' }
    case 'closed':
      return { tone: 'neutral', words: '已结束' }
  }
}

/** The handoff this session received, as the Host lists it in the snapshot: the newest, if any. */
export function incomingHandoff(snapshot: Pick<AppSnapshot, 'handoffs'>, sessionId: string | undefined): HandoffSummary | undefined {
  if (!sessionId) return undefined
  return (snapshot.handoffs ?? [])
    .filter(item => item.targetSessionId === sessionId)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

/** 「来自 <来源会话>」: the source's title when this device lists it, else nothing to link to. */
export function sourceCrumb(
  snapshot: Pick<AppSnapshot, 'handoffs' | 'tasks'>,
  sessionId: string | undefined,
): { sourceId: string; title?: string } | undefined {
  const incoming = incomingHandoff(snapshot, sessionId)
  if (!incoming) return undefined
  const source = snapshot.tasks.find(task => task.id === incoming.sourceSessionId)
  return { sourceId: incoming.sourceSessionId, ...(source ? { title: source.title || '未命名会话' } : {}) }
}

const running = (task: Pick<TaskSummary, 'status'>) => task.status === 'running' || task.status === 'waiting-approval'

/** A target whose result the person has yet to hand back: started, a return agreed, and its turn has ended. */
export function awaitsReturn(
  handoff: Pick<HandoffSummary, 'status' | 'returnScope'>,
  target: Pick<TaskSummary, 'status'> | undefined,
): boolean {
  return handoff.status === 'started' && handoff.returnScope !== 'none' && target !== undefined && !running(target)
}

/** Sessions where a return waits for the person, for the session list's marker. */
export function sessionsAwaitingReturn(snapshot: Pick<AppSnapshot, 'handoffs' | 'tasks'>): ReadonlySet<string> {
  const waiting = new Set<string>()
  for (const item of snapshot.handoffs ?? []) {
    if (!item.targetSessionId) continue
    const target = snapshot.tasks.find(task => task.id === item.targetSessionId)
    if (awaitsReturn(item, target)) waiting.add(item.targetSessionId)
  }
  return waiting
}

/** The text of the target's last reply, which 交回结果 starts from. */
export function defaultSummary(messages: readonly Message[]): string {
  const last = messages.findLast(message => message.role === 'assistant' && message.text.trim())
  return (last?.text.trim() ?? '').slice(0, HANDOFF_LIMITS.summaryChars)
}

/** What 交回结果 may offer as evidence: the session's files (with the full data scope) and its replies. */
export type EvidenceChoice =
  | { key: string; kind: 'file'; file: FileMention; label: string }
  | { key: string; kind: 'message'; messageId: string; label: string }

export function evidenceChoices(messages: readonly Message[], dataScope: DataScope | undefined): EvidenceChoice[] {
  const files: EvidenceChoice[] = readsProjectFiles(dataScope)
    ? sessionFiles(messages).map(file => ({ key: chipKey.file(file), kind: 'file', file, label: file.path }))
    : []
  const replies: EvidenceChoice[] = messages
    .filter(message => (message.role === 'assistant' || message.role === 'user') && message.text.trim())
    .slice(-8)
    .map(message => ({
      key: chipKey.message(message.id),
      kind: 'message',
      messageId: message.id,
      label: `${message.role === 'user' ? '消息' : '回复'} · ${messageLine(message.text, 48)}`,
    }))
  return [...files, ...replies].slice(0, HANDOFF_LIMITS.evidence)
}

/** The return request; evidence goes along only when the agreed scope keeps it. */
export function returnBody(
  requestId: string,
  summary: string,
  scope: HandoffReturnScope,
  evidence: Array<{ choice: EvidenceChoice; hash: string }>,
): HandoffReturn {
  return {
    requestId,
    summary: summary.trim(),
    evidence:
      scope === 'summary-and-evidence'
        ? evidence.map(({ choice, hash }) =>
            choice.kind === 'file' ? { kind: 'file', file: choice.file, hash } : { kind: 'message', messageId: choice.messageId, hash },
          )
        : [],
  }
}

/** The summary into the composer as quoted text, after what is already there. */
export function quotedSummary(previous: string, summary: string): string {
  const quote = summary
    .trim()
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')
  return `${previous.trimEnd()}${previous.trim() ? '\n\n' : ''}${quote}\n\n`
}

/** One evidence row as its reader may see it. */
export function evidenceRow(
  item: HandoffEvidence,
): { kind: 'file'; label: string } | { kind: 'message'; label: string } | { kind: 'withheld'; label: string } {
  if (item.kind === 'withheld') return { kind: 'withheld', label: '无权查看' }
  if (item.kind === 'file') return { kind: 'file', label: item.file.path }
  return { kind: 'message', label: '代码会话里的一条消息' }
}

/**
 * Where each returned result sits in the source's timeline: after the last turn that began before it arrived, so later
 * turns follow it. Results before every turn go first (key '').
 */
export function placeByTime<T extends { at: string }>(
  turns: ReadonlyArray<{ key: string; at: number | undefined }>,
  items: readonly T[],
): Map<string, T[]> {
  const placed = new Map<string, T[]>()
  for (const item of items.toSorted((a, b) => a.at.localeCompare(b.at))) {
    const at = Date.parse(item.at)
    const turn = Number.isNaN(at) ? turns.at(-1) : turns.findLast(entry => entry.at !== undefined && entry.at <= at)
    const key = turn?.key ?? ''
    placed.set(key, [...(placed.get(key) ?? []), item])
  }
  return placed
}

/** Whether a session reads as private, so a handoff from it may only go to a session that is private too. */
export const privateSession = (task: Pick<TaskSummary, 'agent' | 'agentPrivate'>) => task.agent !== undefined || task.agentPrivate === true

/** Sessions an existing-session handoff may go to: listed, not archived, not the source, and private only with private. */
export function sessionTargets(tasks: readonly TaskSummary[], source: TaskSummary): TaskSummary[] {
  const isPrivate = privateSession(source)
  return tasks
    .filter(task => task.id !== source.id && !task.archived && !task.personal && (!isPrivate || privateSession(task)))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** The messages of the turn a message belongs to: from its prompt up to the next one. */
export function turnAround(messages: readonly Message[], messageId: string): Message[] {
  const index = messages.findIndex(message => message.id === messageId)
  if (index < 0) return []
  const start = messages.findLastIndex((message, at) => at <= index && message.role === 'user')
  const next = messages.findIndex((message, at) => at > index && message.role === 'user')
  return messages.slice(Math.max(0, start), next < 0 ? messages.length : next)
}

/** The chips a message action starts with: the chosen messages, the selected text, and the files their turns name. */
export function initialChips(
  messages: readonly Message[],
  chosen: readonly string[],
  text: string | undefined,
  withFiles: boolean,
): MaterialChip[] {
  const chips: MaterialChip[] = []
  if (text?.trim()) chips.push({ key: chipKey.text(0), kind: 'text', text: text.trim() })
  for (const id of chosen) {
    const message = messages.find(item => item.id === id)
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || !message.text.trim()) continue
    chips.push({ key: chipKey.message(id), kind: 'message', messageId: id, role: message.role, line: messageLine(message.text) })
  }
  if (withFiles) {
    const files = sessionFiles(chosen.flatMap(id => turnAround(messages, id)))
    for (const file of files)
      if (!chips.some(chip => chip.key === chipKey.file(file))) chips.push({ key: chipKey.file(file), kind: 'file', file })
  }
  return chips.slice(0, HANDOFF_LIMITS.materials)
}
