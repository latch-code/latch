import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import {
  LADDER_MODE,
  TEAM_LIMITS,
  WORK_ITEM_LIMITS,
  WORK_PROPOSAL_LIMITS,
  type DataScope,
  type HostFeatures,
  type TaskSummary,
  type TeamAnswer,
  type TeamMemberState,
  type TeamSummary,
} from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { errorText, json, jsonBody, KIB, safeDecode } from '../http-util.ts'
import {
  derivedUuid,
  memberEnded,
  newTeamId,
  resultOf,
  roundMembers,
  roundOf,
  saidOf,
  teamOpen,
  teamReturnText,
  teamSummary,
  type TeamMemberRecord,
  type TeamRecord,
  type TeamStore,
} from '../teams.ts'
import { checkedPrompt, checkedTitle, HARNESS_ID, type WorkItemStore } from '../work-items.ts'
import type { DeviceCaller, RouteContext, RouteModule } from './registry.ts'
import type { WorkItemRoutes } from './work-items.ts'
import type { WorkProposalRoutes } from './work-proposals.ts'
import { createTeamRounds } from './team-rounds.ts'

export interface TeamRouteDeps {
  store: TeamStore
  items: WorkItemStore
  /**
   * Whether members start in a new worktree each: a saved project of one folder that is a Git repository. A repository
   * that refuses a worktree now still answers true, so each member is refused with the reason instead of sharing a folder.
   */
  worktrees: (projectId: string) => Promise<boolean>
  /** Why this Harness cannot start a member without a confirmation of its own on this Mac; undefined when it can. */
  harnessRefusal: (harnessId: string) => string | undefined
  harnessName: (harnessId: string) => string
  /**
   * The device that started a team, as it stands now, to send the results as: `gone` once it is removed, inactive or
   * without `run`; `wait` while it cannot send but may again (a phone whose verification window ended).
   */
  callerOf: (actor: TeamRecord['actor']) => DeviceCaller | 'gone' | 'wait'
  /** A person's message to a session through the checked path, marked as carrying outside content. */
  send: (caller: DeviceCaller, sessionId: string, input: { requestId: string; prompt: string }) => Promise<void>
  /** Messages waiting in the session's queue, and questions waiting for the person. */
  queued: (sessionId: string) => number
  questions: (sessionId: string) => number
  /** The cancel a person's 停止 makes, with its audit and receipts. */
  cancel: (caller: DeviceCaller, sessionId: string, runId: string | undefined, res: ServerResponse) => Promise<void>
  /** A team changed: clients read again, and each named session's summary; a private one only tells the full data scope. */
  changed: (team: TeamRecord, sessionIds: readonly string[]) => void
  /**
   * A later round's message to a member, through the same checked path as a person's message, as `caller`. `agent`: the
   * lead's agent wrote it, so it is outside content for the member and carries no device's grant.
   */
  sendToMember: (
    caller: DeviceCaller,
    sessionId: string,
    input: { requestId: string; prompt: string },
    how: { agent: boolean; outside: boolean; withoutPrivateContext: boolean },
  ) => Promise<void>
  /**
   * Why a round nobody pressed cannot run as this device on these Harnesses now, by the ceiling scheduled runs keep
   * (`policy.json` `unattended`): the Harness's level, the device standing behind unattended work, its idle days.
   */
  unattendedRefusal: (deviceId: string | undefined, harnessIds: readonly string[]) => string | undefined
  /** Why the lead's Harness gives its agent no team tools (no agent channel); undefined when it does. */
  channelRefusal: (leadSessionId: string) => string | undefined
  /** What the lead's agent may read of its team changed: its driver reads it again. */
  rosterChanged: (leadSessionId: string) => void
  /** How often open teams are looked at, in milliseconds. */
  pollMs?: number
}

interface Parts {
  itemRoutes: Pick<WorkItemRoutes, 'createItem' | 'startItem'>
  proposals: Pick<WorkProposalRoutes, 'acceptTodos' | 'isPrivate'>
}

const START = /^\/link\/api\/tasks\/([^/]+)\/team$/u
const ONE = /^\/link\/api\/teams\/(tem_[A-Za-z0-9_-]{22})(?:\/(stop|rounds))?$/u
const BODY_LIMIT = 256 * KIB
/** In the snapshot: every open team, and the most recent ended ones up to this many in all. */
const SNAPSHOT_TEAMS = 32
const POLL_MS = 500
/** A member idle with no outcome on record and no reply: after this long its Harness is taken to have ended it unsaid. */
const SILENT_END_MS = 60_000
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
/** A member's start choices from its Harness's own options, bounded as `POST /tasks` bounds `config`; checked by that start. */
const startConfig = z
  .array(z.strictObject({ configId: z.string().min(1).max(128), value: z.string().max(1024) }))
  .max(16)
  .refine(entries => new Set(entries.map(entry => entry.configId)).size === entries.length, '每个设置只能选一次')
  .optional()
/** What a member starts on beside its Harness: a service's model, its Harness's own choices, or its own default model. */
const startChoices = {
  // Checked by the session's own start, as a 待办's is.
  model: z.unknown().optional(),
  config: startConfig,
  ownModel: z.literal(true).optional(),
}
type StartChoices = { model?: unknown; config?: Array<{ configId: string; value: string }>; ownModel?: true }
const startSchema = z
  .strictObject({
    requestId,
    proposal: z
      .strictObject({
        id: z.string().regex(/^wpp_[A-Za-z0-9_-]{22}$/u),
        baseRevision: z.number().int().min(1),
        entries: z
          .array(
            z.strictObject({
              index: z
                .number()
                .int()
                .min(0)
                .max(WORK_PROPOSAL_LIMITS.entries - 1),
              title: z
                .string()
                .max(4 * KIB)
                .optional(),
              prompt: z
                .string()
                .max(WORK_ITEM_LIMITS.promptChars * 2)
                .optional(),
              harnessId: z.string().regex(HARNESS_ID).optional(),
              ...startChoices,
            }),
          )
          .min(1)
          .max(TEAM_LIMITS.members)
          .optional(),
      })
      .optional(),
    tasks: z
      .array(
        z.strictObject({
          title: z.string().max(4 * KIB),
          prompt: z.string().max(TEAM_LIMITS.promptChars * 2),
          harnessId: z.string().regex(HARNESS_ID),
          ...startChoices,
        }),
      )
      .min(1)
      .max(TEAM_LIMITS.members)
      .optional(),
    goal: z
      .string()
      .max(4 * KIB)
      .optional(),
  })
  .refine(body => (body.proposal === undefined) !== (body.tasks === undefined), '要么从一条提议开始，要么写一个任务列表')
const stopSchema = z.strictObject({ requestId })

/** Only the start choices that were given. */
const choicesOf = (from: StartChoices | undefined): StartChoices => ({
  ...(from?.model !== undefined ? { model: from.model } : {}),
  ...(from?.config?.length ? { config: from.config } : {}),
  ...(from?.ownModel ? { ownModel: true as const } : {}),
})

const notFound = () => new AppError(404, 'team-not-found', '找不到这个团队。')
const conflict = () => new AppError(409, 'request-conflict', '同一个请求标识不能用于不同内容。')
const teamOpenError = () => new AppError(409, 'team-open', '这个会话已有一个还没结束的团队，等它结束或停止后再开始下一个。')
const scopeRequired = () => new AppError(403, 'agent-scope-required', 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。')
const RESTARTED = 'Latch 重新启动时这个成员还没有开始，没有再替你开始。'

/** A member's state from its session's summary; undefined: its first run has not been seen to end, look again. */
function observed(summary: TaskSummary, questions: number): TeamMemberState | undefined {
  if (summary.status === 'running') return 'running'
  if (summary.status === 'waiting-approval' || questions > 0) return 'waiting'
  if (summary.status === 'failed') return 'failed'
  if (summary.status === 'cancelled') return 'cancelled'
  if (summary.status === 'interrupted') return 'unknown'
  if (summary.runOutcome === 'failed') return 'failed'
  if (summary.runOutcome === 'cancelled') return 'cancelled'
  if (summary.runOutcome === 'interrupted') return 'unknown'
  return summary.runOutcome === 'completed' ? 'done' : undefined
}

/**
 * Teams (docs/TEAMS.md): a person starts one for a session, the lead; its members are ordinary 待办 started through the
 * 待办's own start, each on its Harness, at the same time. The Host watches them and, once every one has ended, sends
 * their results to the lead as one message of the device that started the team. Nothing here starts on its own: a
 * member that had not started when the Host stopped stays unstarted.
 */
export function createTeamRoutes(context: RouteContext, deps: TeamRouteDeps, parts: Parts) {
  const { store, items } = deps
  const hub = context.hub
  const scopeOf = (caller: DeviceCaller): DataScope => context.devices.get(caller.device.id)?.dataScope ?? 'work'
  const fullData = (caller: DeviceCaller) => scopeOf(caller) === 'all'
  /** Leads with a start under way in this process: its members are being started, so nothing else touches the team. */
  const starting = new Set<string>()
  /** Teams whose return is on record in this process; a later try writes no second line. */
  const returnAudited = new Set<string>()
  const logged = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let chain: Promise<unknown> = Promise.resolve()
  let sweepWaiting = false

  /** Private once marked, and while its lead is private now. */
  const isPrivate = (team: TeamRecord) => team.private === true || hub.agentPrivate(team.leadSessionId)
  const memberReadable = (full: boolean) => (sessionId: string) => full || !hub.agentPrivate(sessionId)

  /** Every change to a team after its start takes its turn here, so a stop and a return never cross. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = chain.then(work, work)
    chain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  function visible(caller: DeviceCaller, id: string): TeamRecord {
    const team = store.get(id)
    if (!team || (isPrivate(team) && !fullData(caller))) throw notFound()
    return team
  }

  function answer(res: ServerResponse, caller: DeviceCaller, id: string, status = 200): void {
    context.recheck(caller, 'view')
    const team = visible(caller, id)
    json(res, { team: teamSummary(team, memberReadable(fullData(caller)), rounds.refusalOf(team)) } satisfies TeamAnswer, status)
  }

  function published(team: TeamRecord | undefined, sessionIds: readonly string[] = []): void {
    if (team) {
      deps.changed(team, [team.leadSessionId, ...sessionIds])
      deps.rosterChanged(team.leadSessionId)
    }
    watch()
  }

  /** The timer runs only while a team is open. */
  function watch(): void {
    const open = store.list().some(teamOpen)
    if (open && !timer && !context.closing()) {
      timer = setInterval(sweep, deps.pollMs ?? POLL_MS)
      timer.unref()
    } else if (!open && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  function sweep(): void {
    if (sweepWaiting || context.closing()) return
    sweepWaiting = true
    void exclusive(async () => {
      sweepWaiting = false
      for (const team of store.list().filter(teamOpen)) {
        if (context.closing()) return
        if (starting.has(team.leadSessionId)) continue
        await advance(team.id).catch(error => noteOnce(`${team.id}:advance`, `团队 ${team.id} 的状态没有更新：${errorText(error)}`))
      }
      watch()
    })
  }

  function noteOnce(key: string, text: string): void {
    if (logged.has(key)) return
    logged.add(key)
    context.log(text)
  }

  /**
   * Deleted: every Harness is mounted and has listed its sessions, and none lists it. A Harness still mounting after a
   * restart lists nothing and proves nothing.
   */
  async function gone(sessionId: string): Promise<boolean> {
    const listing = await hub.listTasksProven().catch(() => undefined)
    return listing?.complete === true && !listing.tasks.some(task => task.id === sessionId)
  }

  /** What a member's session says of it now; undefined when nothing changed or it cannot be read yet. */
  async function look(member: TeamMemberRecord, at: string): Promise<Partial<TeamMemberRecord> | undefined> {
    if (!member.sessionId) {
      // The Host stopped between the team's record and this member's start: its 待办 may hold the session that did start.
      const sessionId = items.get(member.itemId)?.sessionIds.at(-1)
      return sessionId ? { sessionId, state: 'running', startedAt: at } : { state: 'unstarted', refusal: RESTARTED, endedAt: at }
    }
    const sessionId = member.sessionId
    const summary = await hub.summary(sessionId).catch(() => undefined)
    if (!summary) return (await gone(sessionId)) ? { state: 'unknown', endedAt: at } : undefined
    let state = observed(summary, deps.questions(sessionId))
    if (state === 'running' || state === 'waiting') return state === member.state ? undefined : { state }
    const detail = await hub.detail(sessionId).catch(() => undefined)
    if (!detail) return undefined
    // A later round: only what follows its own message counts; before that message is on record, the earlier round's
    // outcome still stands in the summary, so nothing is read from it.
    const from = member.sendRequestId
      ? detail.messages.findIndex(message => message.role === 'user' && message.requestId === member.sendRequestId)
      : 0
    if (from < 0) {
      if (context.now() - Date.parse(member.startedAt ?? at) < SILENT_END_MS) return undefined
      return { state: 'unknown', endedAt: at }
    }
    const since = detail.messages.slice(from)
    if (state === undefined) {
      // Idle with no outcome on record (a Harness that records none, or a first run not yet begun): done once it has
      // replied; with no reply it is waited for, then counted as ended nobody knows how.
      if (since.some(message => message.role === 'assistant')) state = 'done'
      else if (context.now() - Date.parse(member.startedAt ?? at) < SILENT_END_MS) return undefined
      else state = 'unknown'
    }
    const reply = since.findLast(message => message.role === 'assistant' && message.text.trim())?.text ?? ''
    const said = saidOf(reply)
    const { result, cut } = resultOf(reply)
    return {
      state,
      endedAt: at,
      ...(said ? { said } : {}),
      ...(result ? { result } : {}),
      ...(cut ? { resultCut: true as const } : {}),
      ...(summary.worktree && !summary.worktree.removed ? { branch: summary.worktree.branch.slice(0, 256) } : {}),
    }
  }

  /** One team's next step: its members' states, then the return or the keep once every one has ended. */
  async function advance(id: string): Promise<void> {
    let team = store.get(id)
    if (!team || !teamOpen(team)) return
    if (!team.private && hub.agentPrivate(team.leadSessionId)) team = (await store.update(id, row => void (row.private = true))) ?? team
    if (team.state === 'running' || team.state === 'stopping') {
      const at = new Date(context.now()).toISOString()
      const changes = new Map<string, Partial<TeamMemberRecord>>()
      for (const member of team.members) {
        if (memberEnded(member)) continue
        const change = await look(member, at)
        if (change) changes.set(member.itemId, change)
      }
      if (changes.size) {
        team = await store.update(id, row => {
          for (const member of row.members) {
            const change = changes.get(member.itemId)
            if (change && !memberEnded(member)) Object.assign(member, change)
          }
        })
        published(
          team,
          [...changes.values()].flatMap(change => (change.sessionId ? [change.sessionId] : [])),
        )
      }
      if (!team || !team.members.every(memberEnded)) return
      if (team.state === 'stopping') return keep(id, 'stopped')
      team = await store.update(id, row => {
        if (row.state !== 'running') return false
        row.state = 'returning'
      })
      published(team)
    }
    if (team?.state === 'returning') await giveBack(team)
  }

  async function keep(id: string, reason: NonNullable<TeamRecord['kept']>): Promise<void> {
    const before = store.get(id)
    if (!before || !teamOpen(before)) return
    // A reduction: the results stay where they are whether or not the line is written.
    await context.audit
      .append({ action: 'team.kept', actor: { listener: 'host' }, target: id, detail: { teamId: id, reason } })
      .catch(error => context.log(`审计记录写入失败（team.kept）：${errorText(error)}`))
    const team = await store.update(id, row => {
      if (!teamOpen(row)) return false
      row.state = 'kept'
      row.kept = reason
    })
    published(team)
  }

  async function returned(id: string, messageId: string | undefined): Promise<void> {
    const team = await store.update(id, row => {
      if (row.state !== 'returning') return false
      row.state = 'returned'
      if (messageId) row.returnedMessageId = messageId
    })
    published(team)
  }

  /**
   * The results go to the lead, once: as the device that started the team, checked as its own message would be, when
   * the lead is idle with nothing queued and nothing asked. A lead that is busy, or a device that cannot send for now,
   * leaves the team `returning` for the next look. The message carries one request ID for good, and the lead's own record
   * is read for it before every try, so a try whose answer was lost is never sent again.
   */
  async function giveBack(team: TeamRecord): Promise<void> {
    const lead = team.leadSessionId
    if (hub.sessionRecord(lead)?.archived) return keep(team.id, 'lead-gone')
    const summary = await hub.summary(lead).catch(() => undefined)
    if (!summary) {
      if (await gone(lead)) await keep(team.id, 'lead-gone')
      return
    }
    if (summary.archived) return keep(team.id, 'lead-gone')
    const caller = deps.callerOf(team.actor)
    if (caller === 'gone') return keep(team.id, 'device-removed')
    if (caller === 'wait') return
    // Not while the lead is at work or waits for the person, nor ahead of what the person queued for it.
    if (summary.status === 'running' || summary.status === 'waiting-approval' || deps.questions(lead) > 0 || deps.queued(lead) > 0) return
    const sent = () =>
      hub.detail(lead).then(now => now.messages.find(message => message.role === 'user' && message.requestId === team.returnRequestId))
    // The lead's own record is read only now, when the message would go: a try whose answer was lost left it there.
    let already: Awaited<ReturnType<typeof sent>>
    try {
      already = await sent()
    } catch {
      return
    }
    if (already) return returned(team.id, already.id)
    if (context.closing() || store.get(team.id)?.state !== 'returning') return
    // A member that is private now, while the lead is not: its words stay in its own session.
    const withheld = new Set(
      hub.agentPrivate(lead)
        ? []
        : team.members.flatMap(member => (member.sessionId && hub.agentPrivate(member.sessionId) ? [member.sessionId] : [])),
    )
    const prompt = teamReturnText({ members: roundMembers(team) }, deps.harnessName, withheld)
    const once = `${team.id}:${roundOf(team)}`
    if (!returnAudited.has(once)) {
      try {
        await context.audited({
          action: 'team.returned',
          actor: context.actorOf(caller),
          target: team.id,
          detail: { teamId: team.id, leadSessionId: lead, members: roundMembers(team).length, promptHash: sha256Hex(prompt) },
        })
      } catch {
        return
      }
      returnAudited.add(once)
    }
    try {
      await deps.send(caller, lead, { requestId: team.returnRequestId, prompt })
    } catch (error) {
      const code = error instanceof AppError ? error.code : undefined
      // The device lost what a message of its own needs: it is not sent as anyone else.
      if (error instanceof AppError && (error.status === 401 || error.status === 403) && code !== 'native-verification-required')
        return keep(team.id, 'device-removed')
      noteOnce(`${once}:${code ?? 'send'}`, `团队 ${team.id} 的结果还没有发给来源会话：${errorText(error)}`)
      return
    }
    await returned(team.id, (await sent().catch(() => undefined))?.id)
  }

  /** The session a team may be started for: a Code session this device can read, not archived, not a page's, not a member. */
  async function leadOf(caller: DeviceCaller, sessionId: string): Promise<TaskSummary> {
    const readable = () => {
      if (hub.agentPrivate(sessionId) && !fullData(caller)) throw scopeRequired()
    }
    readable()
    const summary = await hub.summary(sessionId)
    context.recheck(caller, 'run')
    readable()
    const refuse = (message: string) => new AppError(409, 'team-lead', message)
    if (summary.agent || summary.generalChat || summary.personal || summary.automationId) throw refuse('只有 Code 会话可以带团队。')
    if (hub.pageOriginOf(sessionId)) throw refuse('插件页面开始的会话不能带团队。')
    if (summary.archived) throw refuse('会话已归档，先取消归档再组队。')
    if (store.memberOf(sessionId)) throw refuse('团队的成员不能再带团队。')
    return summary
  }

  async function start(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, leadId: string): Promise<void> {
    context.requireScope(caller, 'run')
    context.limits.classC.take(caller.device.id)
    const body = startSchema.parse(await jsonBody(req, BODY_LIMIT))
    const { requestId: request, ...fields } = body
    const hash = sha256Hex(canonicalJson({ leadId, ...fields }))
    const replay = () => {
      const prior = store.list().find(team => team.actor.deviceId === caller.device.id && team.request.requestId === request)
      if (prior && (prior.request.hash !== hash || prior.leadSessionId !== leadId)) throw conflict()
      return prior
    }
    const prior = replay()
    if (prior) return answer(res, caller, prior.id)
    const lead = await leadOf(caller, leadId)
    if (starting.has(leadId) || store.openOf(leadId).length >= TEAM_LIMITS.openPerLead) throw teamOpenError()
    starting.add(leadId)
    let teamId: string | undefined
    try {
      teamId = await startMembers(req, res, caller, lead, body, hash)
    } finally {
      starting.delete(leadId)
    }
    sweep()
    answer(res, caller, teamId, 201)
  }

  /** The members' 待办, the team's record, then every member's start at once. Answers the team's ID. */
  async function startMembers(
    req: IncomingMessage,
    res: ServerResponse,
    caller: DeviceCaller,
    lead: TaskSummary,
    body: z.infer<typeof startSchema>,
    hash: string,
  ): Promise<string> {
    const leadId = lead.id,
      deviceId = caller.device.id,
      projectId = lead.workspaceId ?? 'default'
    const derived = (kind: string, index?: number) => sha256Hex(canonicalJson([kind, deviceId, leadId, body.requestId, index ?? 0]))
    const goalText = body.goal?.trim() ? checkedTitle(body.goal) : undefined
    const row = body.proposal ? items.proposal(body.proposal.id) : undefined
    let plan: Array<{ index?: number; title?: string; prompt?: string; harnessId: string } & StartChoices>
    // A retry of a start whose members were all refused: its entries were accepted then, and are those 待办 now.
    const acceptedBefore = body.proposal ? items.receipt('accept', deviceId, derived('team-accept'))?.itemIds : undefined
    if (body.proposal) {
      if (!row?.entries || (parts.proposals.isPrivate(row) && !fullData(caller)))
        throw new AppError(404, 'proposal-not-found', '找不到这条提议。')
      if (row.from.sessionId !== leadId)
        throw new AppError(409, 'team-proposal', '这条提议不是这个会话提出的，不能从它开始这个会话的团队。')
      if (acceptedBefore) {
        const made = acceptedBefore.map(id => items.get(id))
        if (made.some(item => !item)) throw new AppError(409, 'proposal-decided', '这条提议已经处理过了。')
        // What each was to start on comes with the retry, as the first request named it.
        plan = made.map((item, index) => ({
          ...choicesOf(body.proposal!.entries?.[index]),
          index,
          title: item!.title,
          harnessId: item!.harnessId ?? lead.harnessId,
        }))
      } else {
        if (row.revision !== body.proposal.baseRevision) throw new AppError(409, 'proposal-changed', '提议已有变化，请刷新后再试。')
        const pending = row.entries.flatMap((entry, index) => (entry.state === 'pending' ? [index] : []))
        const chosen: Array<{ index: number; title?: string; prompt?: string; harnessId?: string } & StartChoices> =
          body.proposal.entries ?? pending.map(index => ({ index }))
        if (new Set(chosen.map(edit => edit.index)).size !== chosen.length) throw new AppError(400, 'invalid-input', '同一项只能开始一次。')
        if (!chosen.length || chosen.some(edit => !pending.includes(edit.index)))
          throw new AppError(409, 'proposal-decided', '这条提议已经处理过了。')
        // A member runs on the Harness its entry names; one that names none runs on the lead's.
        plan = chosen.map(edit => ({ ...edit, harnessId: edit.harnessId ?? row.entries![edit.index]!.harnessId ?? lead.harnessId }))
      }
    } else {
      plan = body.tasks!.map(task => {
        const prompt = checkedPrompt(task.prompt)
        if (!prompt || prompt.length > TEAM_LIMITS.promptChars)
          throw new AppError(400, 'invalid-input', `每个成员的要求要 1–${TEAM_LIMITS.promptChars} 个字符。`)
        return {
          title: checkedTitle(task.title),
          prompt,
          harnessId: task.harnessId,
          ...choicesOf(task),
        }
      })
    }
    if (plan.length > TEAM_LIMITS.members) throw new AppError(400, 'invalid-input', `一个团队最多 ${TEAM_LIMITS.members} 个成员。`)
    const goal = goalText ?? row?.goal
    const leadPrivate = () => hub.agentPrivate(leadId)
    const outsideStart = hub.outsideStartOf(leadId) || row?.external === true
    const worktree = await deps.worktrees(projectId)
    context.recheck(caller, 'run')
    const id = newTeamId()
    // Executing: nothing is accepted, made or started without the line.
    try {
      await context.audited({
        action: 'team.started',
        actor: context.actorOf(caller),
        target: id,
        detail: {
          teamId: id,
          leadSessionId: leadId,
          members: plan.length,
          harnessIds: [...new Set(plan.map(member => member.harnessId))],
          ...(row ? { proposalId: row.id } : {}),
        },
      })
    } catch {
      throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，团队没有开始，请重试。')
    }
    // The members' 待办: a proposal's entries accepted as edited, in the lead's project; or one 待办 per task written.
    let itemIds: string[]
    if (acceptedBefore) itemIds = acceptedBefore
    else if (body.proposal) {
      const accepted = await parts.proposals.acceptTodos(caller, body.proposal.id, {
        requestId: derived('team-accept'),
        baseRevision: body.proposal.baseRevision,
        entries: plan.map(member => ({
          index: member.index!,
          ...(member.title !== undefined ? { title: member.title } : {}),
          ...(member.prompt !== undefined ? { prompt: member.prompt } : {}),
          harnessId: member.harnessId,
          projectId,
        })),
      })
      itemIds = accepted.itemIds
    } else {
      itemIds = []
      for (const [index, member] of plan.entries()) {
        const made = await parts.itemRoutes.createItem(
          res,
          caller,
          {
            requestId: derived('team-item', index),
            title: member.title!,
            prompt: member.prompt!,
            projectId,
            harnessId: member.harnessId,
          },
          leadPrivate(),
        )
        itemIds.push(made.item.id)
      }
    }
    if (itemIds.length !== plan.length) throw new AppError(409, 'proposal-decided', '这条提议已经处理过了。')
    context.recheck(caller, 'run')
    const messageId = row?.from.messageId ?? (await hub.detail(leadId).catch(() => undefined))?.messages.at(-1)?.id
    const team = await store.transact((draft, at) => {
      if (draft.some(one => one.actor.deviceId === deviceId && one.request.requestId === body.requestId)) throw conflict()
      if (draft.filter(one => one.leadSessionId === leadId && teamOpen(one)).length >= TEAM_LIMITS.openPerLead) throw teamOpenError()
      if (draft.length >= TEAM_LIMITS.stored && draft.every(teamOpen))
        throw new AppError(409, 'team-store-full', '这台电脑上的团队记录已满，请先等一些结束。')
      const record: TeamRecord = {
        id,
        leadSessionId: leadId,
        ...(messageId ? { messageId } : {}),
        ...(row ? { proposalId: row.id } : {}),
        ...(goal ? { goal } : {}),
        actor: {
          deviceId,
          listener: caller.connection.listener,
          ...(caller.nativeOpening?.windowHash ? { nativeWindowHash: caller.nativeOpening.windowHash } : {}),
        },
        request: { requestId: body.requestId, hash },
        ...(leadPrivate() ? { private: true as const } : {}),
        members: itemIds.map((itemId, index) => ({
          itemId,
          title: items.get(itemId)?.title ?? plan[index]!.title ?? '成员',
          harnessId: plan[index]!.harnessId,
          state: 'starting' as const,
        })),
        state: 'running',
        returnRequestId: derivedUuid(['team-return', id]),
        createdAt: at,
        updatedAt: at,
      }
      draft.push(record)
      return { result: record, changed: true }
    })
    published(team)
    const refusals: unknown[] = []
    await Promise.all(
      team.members.map(async (member, index) => {
        let sessionId: string | undefined
        let refusal: string | undefined
        try {
          const unconfirmed = deps.harnessRefusal(member.harnessId)
          if (unconfirmed) throw new AppError(409, 'harness-unconfirmed', unconfirmed)
          const item = items.get(member.itemId)
          if (!item) throw new AppError(404, 'item-not-found', '找不到这条待办。')
          // Its own new worktree where the project takes them and the Harness works in files; never the lead's mode or model.
          const harness = hub.info(member.harnessId)
          const ownTree = worktree && harness?.modes.includes('agent') === true
          const choices = plan[index]!
          // A member's permission is its Harness's and project's default: no pick of a mode comes with it.
          if (
            choices.config?.some(
              pick =>
                pick.configId === LADDER_MODE
                || harness?.catalogue?.options.some(option => option.id === pick.configId && option.category === 'mode'),
            )
          )
            throw new AppError(400, 'config-unsupported', '成员的权限用项目的默认档位，不能在开始前另选。')
          const started = await parts.itemRoutes.startItem(
            req,
            res,
            caller,
            member.itemId,
            {
              requestId: derivedUuid(['team-member', deviceId, leadId, body.requestId, index]),
              baseRevision: item.revision,
              workspaceId: projectId,
              harnessId: member.harnessId,
              ...(ownTree ? { worktree: true } : {}),
              // The person's own choice for this member's Harness; never the lead's.
              ...choicesOf(choices),
            },
            {
              // A lead that is not private gets its members' replies: they start without private context.
              withoutPrivateContext: !leadPrivate(),
              ...(leadPrivate() ? { privateFrom: `team:${leadId}` } : {}),
              outsideStart,
            },
          )
          sessionId = started.sessionId
        } catch (error) {
          // A start whose answer was lost may still have made the session: its 待办 says so.
          sessionId = items.get(member.itemId)?.sessionIds.at(-1)
          if (!sessionId) {
            refusals[index] = error
            refusal = (error instanceof AppError ? error.message : '').slice(0, 300) || '会话没有开始。'
          }
        }
        const done = await store
          .update(id, (record, at) => {
            const target = record.members[index]!
            if (sessionId) Object.assign(target, { sessionId, state: 'running', startedAt: at })
            else Object.assign(target, { state: 'unstarted', refusal, endedAt: at })
          })
          .catch(() => undefined)
        published(done, sessionId ? [sessionId] : [])
      }),
    )
    const settled = store.get(id)
    if (settled && !settled.members.some(member => member.sessionId)) {
      // No member started: no team is kept, and the first refusal is the answer.
      await store.transact(draft => {
        const index = draft.findIndex(one => one.id === id)
        if (index >= 0) draft.splice(index, 1)
        return { result: undefined, changed: index >= 0 }
      })
      published(settled)
      throw refusals.find(error => error !== undefined) ?? new AppError(409, 'team-unstarted', '没有一个成员开始，团队没有建立。')
    }
    return id
  }

  /** 停止: every member still at work is cancelled as a person's 停止 would; the results are kept, never sent. */
  async function stop(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, id: string): Promise<void> {
    context.requireScope(caller, 'run')
    context.limits.classC.take(caller.device.id)
    stopSchema.parse(await jsonBody(req))
    const current = visible(caller, id)
    if (current.kept === 'stopped' || current.state === 'stopping') return answer(res, caller, id)
    if (!teamOpen(current)) throw new AppError(409, 'team-ended', '这个团队已经结束了。')
    if (starting.has(current.leadSessionId)) throw new AppError(409, 'team-starting', '团队正在开始，稍后再停止。')
    context.recheck(caller, 'run')
    await context.audited({ action: 'team.stopped', actor: context.actorOf(caller), target: id, detail: { teamId: id } }, res)
    const team = await exclusive(async () => {
      context.recheck(caller, 'run')
      const marked = await store.update(id, row => {
        if (!teamOpen(row) || row.state === 'stopping') return false
        row.state = 'stopping'
        // Stopping a team also takes back what its lead's agent was let do.
        delete row.dispatch
      })
      if (marked?.state === 'stopping' && current.dispatch) void rounds.dispatchEnded(id, 'stopped')
      if (marked?.state === 'stopping') published(marked)
      return marked
    })
    // Outside the turn every team's changes take: a Harness slow to stop one member holds nothing else up.
    if (team?.state === 'stopping')
      await Promise.all(
        team.members.map(async member => {
          if (!member.sessionId || memberEnded(member)) return
          const runId = (await hub.summary(member.sessionId).catch(() => undefined))?.runId
          await deps
            .cancel(caller, member.sessionId, runId, res)
            .catch(error => context.log(`团队 ${id} 的一个成员没有停下：${errorText(error)}`))
        }),
      )
    // A member whose Harness has not settled yet leaves the team `stopping`; the watcher keeps it once it has.
    await exclusive(() => advance(id))
    answer(res, caller, id)
  }

  /** The teams this device may read, for the snapshot: open ones, then the most recent ended ones. */
  function summaries(scope: DataScope | undefined): TeamSummary[] {
    const readable = store.list().filter(team => scope === 'all' || !isPrivate(team))
    const open = readable.filter(teamOpen)
    const ended = readable
      .filter(team => !teamOpen(team))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(0, SNAPSHOT_TEAMS - open.length))
    return [...open, ...ended].map(team => teamSummary(team, memberReadable(scope === 'all'), rounds.refusalOf(team)))
  }

  context.lifecycle.on('runSettled', ({ sessionId }) => {
    if (store.memberOf(sessionId) || store.openOf(sessionId).length) sweep()
  })
  context.lifecycle.on('hostStopping', () => {
    if (timer) clearInterval(timer)
    timer = undefined
  })
  const rounds = createTeamRounds({
    context,
    deps,
    exclusive,
    starting,
    published,
    visible,
    answer,
    sweep,
    fullData,
  })
  // Teams left open by the last run of the Host are taken up again: their members' states, then the return.
  watch()

  const module: RouteModule = {
    features: () => ({ teams: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      const lead = START.exec(path)
      if (lead) {
        if (method !== 'POST') return false
        context.requireScope(caller, 'view')
        const leadId = safeDecode(lead[1]!)
        if (leadId.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
        await start(req, res, caller, leadId)
        return true
      }
      if (!path.startsWith('/link/api/teams')) return false
      context.requireScope(caller, 'view')
      const match = ONE.exec(path)
      if (!match) throw notFound()
      const id = match[1]!
      if (!match[2] && method === 'GET') answer(res, caller, id)
      else if (!match[2] && method === 'PATCH') await rounds.change(req, res, caller, id)
      else if (match[2] === 'stop' && method === 'POST') await stop(req, res, caller, id)
      else if (match[2] === 'rounds' && method === 'POST') await rounds.start(req, res, caller, id)
      else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
  return {
    module,
    summaries,
    isPrivate,
    sweep,
    roster: rounds.roster,
    dispatch: rounds.dispatch,
    devicesChanged: rounds.devicesChanged,
    close: () => (timer ? clearInterval(timer) : undefined),
  }
}

export type TeamRoutes = ReturnType<typeof createTeamRoutes>
