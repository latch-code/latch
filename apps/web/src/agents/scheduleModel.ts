import type {
  Automation,
  AutomationConfig,
  AutomationDetail,
  AutomationPatch,
  AutomationRun,
  AutomationSchedule,
  AutomationSummary,
  FileMention,
  HostCatalog,
  Message,
} from '@latch/protocol'
import { worksIn } from './model.ts'
import { DEVICE_OFFLINE } from '../core/hostState.ts'

/** What the 定时 form edits. `location` is a project ID, or `default` for the owner's fixed home. */
export interface ScheduleDraft {
  name: string
  kind: AutomationSchedule['kind']
  /** 0 is Sunday; used by `weekly` only. */
  day: number
  time: string
  location?: string
  prompt: string
  notify: boolean
}

export const NEW_SCHEDULE: ScheduleDraft = {
  name: '',
  kind: 'daily',
  day: 1,
  time: '09:00',
  location: 'default',
  prompt: '',
  notify: false,
}

/** New schedules start at home; a project is an explicit choice in this form. */
export function newScheduleDraft(): ScheduleDraft {
  return { ...NEW_SCHEDULE }
}

export function scheduleDraftOf(automation: Pick<Automation, 'name' | 'schedule' | 'projectId' | 'prompt' | 'notify'>): ScheduleDraft {
  const { schedule } = automation
  return {
    name: automation.name,
    kind: schedule.kind,
    day: schedule.kind === 'weekly' ? schedule.day : 1,
    time: schedule.time,
    location: automation.projectId ?? 'default',
    prompt: automation.prompt,
    notify: automation.notify,
  }
}

export function scheduleOf(draft: Pick<ScheduleDraft, 'kind' | 'day' | 'time'>): AutomationSchedule {
  return draft.kind === 'weekly' ? { kind: 'weekly', day: draft.day, time: draft.time } : { kind: draft.kind, time: draft.time }
}

const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u

/** Why the form cannot be saved yet, in a few words; undefined when it can. */
export function scheduleProblem(draft: ScheduleDraft): string | undefined {
  if (!draft.name.trim()) return '先填名称'
  if (!TIME.test(draft.time)) return '先填时间'
  if (draft.location === undefined) return '先选工作位置'
  if (!draft.prompt.trim()) return '先写每次的输入'
  return undefined
}

const projectOf = (location: string | undefined) => (location && location !== 'default' ? location : undefined)

/** The new automation as the Host takes it, for one of 我的 Agent or, without an ID, for 通用. */
export function scheduleCreate(draft: ScheduleDraft, customAgentId: string | undefined): AutomationConfig {
  const projectId = projectOf(draft.location)
  return {
    name: draft.name.trim(),
    ...(customAgentId ? { customAgentId } : {}),
    ...(projectId ? { projectId } : {}),
    prompt: draft.prompt.trim(),
    schedule: scheduleOf(draft),
    notify: draft.notify,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Only what changed, `null` clearing the project, against the revision the form was opened on. */
export function schedulePatch(base: ScheduleDraft, next: ScheduleDraft): Omit<AutomationPatch, 'requestId' | 'baseRevision'> {
  const patch: Omit<AutomationPatch, 'requestId' | 'baseRevision'> = {}
  if (base.name.trim() !== next.name.trim()) patch.name = next.name.trim()
  if (!same(scheduleOf(base), scheduleOf(next))) patch.schedule = scheduleOf(next)
  if (projectOf(base.location) !== projectOf(next.location)) patch.projectId = projectOf(next.location) ?? null
  if (base.prompt.trim() !== next.prompt.trim()) patch.prompt = next.prompt.trim()
  if (base.notify !== next.notify) patch.notify = next.notify
  return patch
}

const pad = (value: number) => String(value).padStart(2, '0')
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

/** A time in this device's clock: 今天 09:00, 明天 09:00, 昨天 09:00 or 11月17日 09:00. */
export function whenWords(at: string, now = Date.now()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date(now)
  const offset = (days: number) => dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days))
  const key = dayKey(date)
  if (key === offset(0)) return `今天 ${clock}`
  if (key === offset(1)) return `明天 ${clock}`
  if (key === offset(-1)) return `昨天 ${clock}`
  const year = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

/** The automation's state in a word and a tone, with the Host's reason for a pause. */
export function scheduleStatus(automation: Pick<AutomationSummary, 'state' | 'pause'>): {
  label: string
  tone: 'neutral' | 'running' | 'warn'
  reason?: string
} {
  if (automation.state === 'running') return { label: '运行中', tone: 'running' }
  if (automation.state === 'paused')
    return { label: '已暂停', tone: 'warn', ...(automation.pause ? { reason: automation.pause.message } : {}) }
  if (automation.state === 'ready') return { label: '已开启', tone: 'neutral' }
  return { label: '已关闭', tone: 'neutral' }
}

/** Why a run did not happen, as the Host records it. Neither kind is caught up. */
export function runReason(run: Pick<AutomationRun, 'state'>): string | undefined {
  if (run.state === 'missed') return '这台 Mac 关机、睡眠或 Latch 没有运行，没有补跑。'
  if (run.state === 'skipped') return '上一次运行还没结束，没有补跑。'
  return undefined
}

/** The times missed or skipped since the last run that happened, newest first. */
export function missedRuns(runs: readonly AutomationRun[]): AutomationRun[] {
  const missed: AutomationRun[] = []
  for (const run of runs) {
    if (run.state !== 'missed' && run.state !== 'skipped') break
    missed.push(run)
  }
  return missed
}

/** Where the runs work: a project, or each run's own folder in the start directory. */
export function scheduleWhere(catalog: HostCatalog | undefined, automation: Pick<AutomationConfig, 'projectId'>): string {
  return automation.projectId ? worksIn(catalog, automation.projectId) : '家'
}

/** The first line of what each run receives. */
export function inputLine(prompt: string, max = 60): string {
  const line =
    prompt
      .split('\n')
      .map(part => part.trim())
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What each automation's detail read needs to be redone for: anything the snapshot says changed. */
export function automationsVersion(automations: readonly AutomationSummary[]): string {
  return automations
    .map(
      item =>
        `${item.id}:${item.revision}:${item.state}:${item.lastRun?.at ?? ''}:${item.lastRun?.state ?? ''}:${item.lastRun?.sessionId ?? ''}`,
    )
    .join('|')
}

/** Background grants and explicit manual runs share device checks, but only the former need unattended capability. */
export function scheduleBlock(input: {
  offline: boolean
  canRun: boolean
  agent?: { available?: boolean; canAutomate: boolean; unavailableReason?: string } | undefined
  trigger?: 'schedule' | 'manual'
}): string | undefined {
  if (input.offline) return `${DEVICE_OFFLINE}，恢复后再改`
  if (!input.canRun) return '这台设备只能查看定时任务：它没有开始会话的权限。'
  if (input.agent?.available === false || input.agent?.unavailableReason) return input.agent.unavailableReason ?? '这个 Agent 现在不可用。'
  if (input.trigger !== 'manual' && input.agent && !input.agent.canAutomate) return '这个 Agent 不能后台运行，可保存后点「立即运行」。'
  return undefined
}

export type DetailRead = { state: 'loading' } | { state: 'ready'; detail: AutomationDetail } | { state: 'failed'; message: string }

/* 带入上次成果 */

/** The last reply of a session, which an earlier delegation's result is. */
export function finalReply(messages: readonly Pick<Message, 'role' | 'text'>[]): string {
  return messages.findLast(message => message.role === 'assistant' && message.text.trim())?.text.trim() ?? ''
}

/** What one earlier delegation gives: its reply (when chosen) and the files chosen from it. */
export interface CarriedResult {
  title: string
  reply?: string
  files: FileMention[]
}

/** The longest a carried reply is; the composer's limit is 16,000 characters for the whole message. */
export const CARRY_REPLY_CHARS = 6000

/**
 * The results as quoted material after what the person typed: a quoted line naming the delegation, then its reply and
 * file paths. Quoted from the header on, so a session title taken from the prompt skips them (`promptTitle`). It is text in the new message only; nothing of the old session's context goes along.
 */
export function carriedText(previous: string, results: readonly CarriedResult[]): string {
  const blocks = results
    .filter(result => result.reply?.trim() || result.files.length)
    .map(result => {
      const reply = result.reply?.trim() ?? ''
      const clipped = reply.length > CARRY_REPLY_CHARS ? `${reply.slice(0, CARRY_REPLY_CHARS)}…（已截断）` : reply
      const lines = [
        ...(clipped ? clipped.split('\n') : []),
        ...(clipped && result.files.length ? [''] : []),
        ...result.files.map(file => `文件：${file.path}`),
      ]
      return [`上次成果「${result.title}」：`, ...lines].map(line => (line ? `> ${line}` : '>')).join('\n')
    })
  if (!blocks.length) return previous
  return `${previous.trimEnd()}${previous.trim() ? '\n\n' : ''}${blocks.join('\n\n')}\n\n`
}
