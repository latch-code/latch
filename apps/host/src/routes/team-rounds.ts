import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { TEAM_LIMITS, type TeamRoster } from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { errorText, jsonBody } from '../http-util.ts'
import { derivedUuid, memberEnded, nameOf, pastRound, roundOf, teamOpen, type TeamMemberRecord, type TeamRecord } from '../teams.ts'
import { checkedPrompt } from '../work-items.ts'
import type { DeviceCaller, RouteContext } from './registry.ts'
import type { TeamRouteDeps } from './teams.ts'

/** What the rounds need of the team routes they belong to. */
export interface RoundEnv {
  context: RouteContext
  deps: TeamRouteDeps
  /** The turn every change to a team after its start takes. */
  exclusive: <T>(work: () => Promise<T>) => Promise<T>
  /** Leads whose members are being started or sent work now: the watcher leaves their teams alone meanwhile. */
  starting: Set<string>
  published: (team: TeamRecord | undefined, sessionIds?: readonly string[]) => void
  visible: (caller: DeviceCaller, id: string) => TeamRecord
  answer: (res: ServerResponse, caller: DeviceCaller, id: string, status?: number) => void
  sweep: () => void
  fullData: (caller: DeviceCaller) => boolean
}

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const roundSchema = z.strictObject({
  requestId,
  sends: z
    .array(
      z.strictObject({
        itemId: z.string().regex(/^itm_[A-Za-z0-9_-]{22}$/u),
        prompt: z.string().max(TEAM_LIMITS.promptChars * 2),
      }),
    )
    .min(1)
    .max(TEAM_LIMITS.members),
})
const changeSchema = z.strictObject({ agentDispatch: z.boolean() })
const agentSends = z
  .array(
    z.strictObject({
      member: z
        .string()
        .min(1)
        .max(TEAM_LIMITS.nameChars * 4),
      prompt: z.string().max(TEAM_LIMITS.promptChars * 2),
    }),
  )
  .min(1)
  .max(TEAM_LIMITS.members)

/** Why a round was refused, for a person (Chinese, by the API) or for the lead's agent (English, by its tool). */
type Refusal =
  | 'lead'
  | 'starting'
  | 'open'
  | 'other-open'
  | 'duplicate'
  | 'unknown-member'
  | 'unstarted'
  | 'private'
  | 'archived'
  | 'busy'
  | 'prompt'
  | 'audit'
/** A refusal as the Host answers it, each code written out where it is thrown. */
function refusalError(refusal: Refusal, message: string): AppError {
  switch (refusal) {
    case 'lead':
      return new AppError(409, 'team-lead', message)
    case 'starting':
      return new AppError(409, 'team-starting', message)
    case 'open':
      return new AppError(409, 'team-round-open', message)
    case 'other-open':
      return new AppError(409, 'team-open', message)
    case 'duplicate':
      return new AppError(400, 'invalid-input', message)
    case 'unknown-member':
      return new AppError(404, 'team-member-not-found', message)
    case 'unstarted':
      return new AppError(409, 'team-member-unstarted', message)
    case 'private':
      return new AppError(403, 'agent-scope-required', message)
    case 'archived':
      return new AppError(409, 'team-member-archived', message)
    case 'busy':
      return new AppError(409, 'team-member-busy', message)
    case 'prompt':
      return new AppError(400, 'invalid-input', message)
    case 'audit':
      return new AppError(503, 'audit-unavailable', message)
  }
}
type Words = (refusal: Refusal, member?: string) => string
const PERSON: Words = (refusal, member) => {
  const who = member ? `「${member}」` : '这个成员'
  if (refusal === 'lead') return '带队的会话已归档或不在了，不能再派一轮。'
  if (refusal === 'starting') return '团队正在开始或派活，稍后再试。'
  if (refusal === 'open') return '这个团队还有一轮没有结束，等它的结果交回后再派下一轮。'
  if (refusal === 'other-open') return '这个会话已有一个还没结束的团队，等它结束或停止后再派。'
  if (refusal === 'duplicate') return '同一个成员在一轮里只能派一次。'
  if (refusal === 'unknown-member') return '这个团队里没有这个成员。'
  if (refusal === 'unstarted') return `${who}没有开始过，不能再派活。`
  if (refusal === 'private') return 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。'
  if (refusal === 'archived') return `${who}的会话已归档或不在了。`
  if (refusal === 'busy') return `${who}还在运行或等你处理，等它结束后再派。`
  if (refusal === 'prompt') return `每个成员的要求要 1–${TEAM_LIMITS.promptChars} 个字符。`
  return '审计记录暂时无法保存，这一轮没有开始，请重试。'
}
const AGENT: Words = (refusal, member) => {
  const who = member ? `Member ${member}` : 'A member'
  if (refusal === 'lead') return 'Not sent: this conversation is archived.'
  if (refusal === 'starting') return 'Not sent: the team is being started or sent work right now. Try again shortly.'
  if (refusal === 'open') return 'Not sent: a round of this team is still open. Its results come back here as one message first.'
  if (refusal === 'other-open') return 'Not sent: another team of this conversation is still open.'
  if (refusal === 'duplicate') return 'Not sent: name each member once in a round.'
  if (refusal === 'unknown-member') return `Not sent: ${member ?? 'that member'} is not a member of this team. Use list_members.`
  if (refusal === 'unstarted') return `Not sent: ${who} never started, so it cannot be sent work.`
  if (refusal === 'private') return `Not sent: ${who} is private to the user.`
  if (refusal === 'archived') return `Not sent: ${who}'s session is archived or gone.`
  if (refusal === 'busy') return `Not sent: ${who} is still working or waiting for the user. Send it more once it has ended.`
  if (refusal === 'prompt') return `Not sent: each prompt must be 1 to ${TEAM_LIMITS.promptChars} characters, with nothing like a secret.`
  return 'Not sent: the record of it could not be written. Try again later.'
}

/** One send of a round, the member found in the team's record. */
interface RoundSend {
  member: TeamMemberRecord
  /** As the member is named in a refusal: its title for a person, its short ID for the agent. */
  name: string
  prompt: string
}

/**
 * Later rounds on a team's existing members (docs/TEAMS.md): one prompt to each, a new turn of its own session, through
 * the path a person's message takes; the results go back to the lead as one message once every one has ended, as the
 * start's do. A person makes one from the page; the lead's agent makes one only while the person lets it, for that team,
 * as the device that allowed it, within the ceiling scheduled runs keep.
 */
export function createTeamRounds(env: RoundEnv) {
  const context: RouteContext = env.context
  const { deps, starting, published } = env
  const { store } = deps
  const hub = context.hub

  /** The newest team a session leads: the one its agent's tools and the input's members are of. */
  const newestOf = (leadSessionId: string): TeamRecord | undefined => store.list().findLast(team => team.leadSessionId === leadSessionId)

  const findRound = (team: TeamRecord, deviceId: string, request: string) => {
    if (team.round?.request.deviceId === deviceId && team.round.request.requestId === request)
      return { round: team.round.round, hash: team.round.request.hash }
    const past = team.history?.find(round => round.request?.deviceId === deviceId && round.request.requestId === request)
    return past?.request ? { round: past.round, hash: past.request.hash } : undefined
  }

  /** Why the lead's agent cannot be let send work for this team now; undefined when it can. */
  function refusalOf(team: TeamRecord): string | undefined {
    const channel = deps.channelRefusal(team.leadSessionId)
    if (channel) return channel
    if (newestOf(team.leadSessionId)?.id !== team.id) return '只有这个会话最新的团队可以让 Agent 派活。'
    if (!team.members.some(member => member.sessionId)) return '这个团队没有开始过的成员。'
    return undefined
  }

  /** Is the member able to take a round now: started, readable, there, and ended with nothing running or waiting. */
  async function check(caller: DeviceCaller, send: RoundSend, words: Words): Promise<string> {
    const refuse = (refusal: Refusal) => refusalError(refusal, words(refusal, send.name))
    const sessionId = send.member.sessionId
    if (!sessionId) throw refuse('unstarted')
    if (hub.agentPrivate(sessionId) && !env.fullData(caller)) throw refuse('private')
    if (hub.sessionRecord(sessionId)?.archived) throw refuse('archived')
    const summary = await hub.summary(sessionId).catch(() => undefined)
    if (!summary || summary.archived) throw refuse('archived')
    if (
      !memberEnded(send.member)
      || summary.status === 'running'
      || summary.status === 'waiting-approval'
      || deps.questions(sessionId) > 0
      || deps.queued(sessionId) > 0
    )
      throw refuse('busy')
    return sessionId
  }

  /**
   * A new round on the team: checked, on record (`team.round.started`) before anything is sent, saved with each member's
   * own request ID, then every prompt sent at once. A member whose prompt was refused counts as not started in this round;
   * when none was sent, the team is put back as it was and the first refusal is the answer.
   */
  async function makeRound(
    caller: DeviceCaller,
    teamId: string,
    sends: RoundSend[],
    how: { by: 'person' | 'agent'; request: { deviceId: string; requestId: string; hash: string }; messageId?: string; words: Words },
  ): Promise<number> {
    const { words } = how
    const refuse = (refusal: Refusal) => refusalError(refusal, words(refusal))
    const team = store.get(teamId)
    if (!team) throw new AppError(404, 'team-not-found', '找不到这个团队。')
    const lead = team.leadSessionId
    const valid = (row: TeamRecord, all: readonly TeamRecord[], held = false) => {
      if (!held && starting.has(lead)) throw refuse('starting')
      if (teamOpen(row)) throw refuse('open')
      if (all.some(other => other.id !== row.id && other.leadSessionId === lead && teamOpen(other))) throw refuse('other-open')
    }
    valid(team, store.list())
    if (new Set(sends.map(send => send.member.itemId)).size !== sends.length) throw refuse('duplicate')
    const leadSummary = await hub.summary(lead).catch(() => undefined)
    if (hub.sessionRecord(lead)?.archived || !leadSummary || leadSummary.archived) throw refuse('lead')
    const sessions = new Map<string, string>()
    for (const send of sends) sessions.set(send.member.itemId, await check(caller, send, words))
    context.recheck(caller, 'run')
    const round = roundOf(team) + 1
    try {
      await context.audited({
        action: 'team.round.started',
        actor: context.actorOf(caller),
        target: teamId,
        detail: { teamId, round, by: how.by, members: sends.length },
      })
    } catch {
      throw refuse('audit')
    }
    const leadPrivate = team.private === true || hub.agentPrivate(lead)
    const outside = how.by === 'agent' || hub.outsideStartOf(lead)
    const messageId = how.messageId ?? (await hub.detail(lead).catch(() => undefined))?.messages.at(-1)?.id
    starting.add(lead)
    try {
      let before: TeamRecord | undefined
      // Only the record takes the turn every team's changes take; the sends run outside it, as a start's do, so a slow
      // Harness holds up no other team (`starting` keeps the watcher off this one meanwhile).
      const made = await env.exclusive(async () => {
        context.recheck(caller, 'run')
        return store.transact((draft, at) => {
          const row = draft.find(one => one.id === teamId)
          if (!row) throw new AppError(404, 'team-not-found', '找不到这个团队。')
          valid(row, draft, true)
          before = structuredClone(row)
          // Any number of rounds: the record keeps the latest ones' states.
          row.history = [...(row.history ?? []), pastRound(row)].slice(-TEAM_LIMITS.history)
          row.round = {
            round,
            by: how.by,
            itemIds: sends.map(send => send.member.itemId),
            request: how.request,
            ...(messageId ? { messageId } : {}),
            createdAt: at,
          }
          row.state = 'running'
          delete row.kept
          delete row.returnedMessageId
          row.returnRequestId = derivedUuid(['team-return', teamId, round])
          row.actor = {
            deviceId: caller.device.id,
            listener: caller.connection.listener,
            ...(caller.nativeOpening?.windowHash ? { nativeWindowHash: caller.nativeOpening.windowHash } : {}),
          }
          if (how.by === 'agent') row.agentRounds = (row.agentRounds ?? 0) + 1
          for (const member of row.members) {
            if (!sessions.has(member.itemId)) continue
            for (const key of ['said', 'result', 'resultCut', 'refusal', 'startedAt', 'endedAt'] as const) delete member[key]
            member.state = 'starting'
            member.sendRequestId = derivedUuid(['team-round', teamId, round, member.itemId])
          }
          row.updatedAt = at
          return { result: row, changed: true }
        })
      })
      published(made)
      const refusals: unknown[] = []
      await Promise.all(
        sends.map(async (send, index) => {
          const sessionId = sessions.get(send.member.itemId)!
          const sent = made.members.find(member => member.itemId === send.member.itemId)!
          let refusal: string | undefined
          try {
            await deps.sendToMember(
              caller,
              sessionId,
              { requestId: sent.sendRequestId!, prompt: send.prompt },
              { agent: how.by === 'agent', outside, withoutPrivateContext: how.by === 'agent' || !leadPrivate },
            )
          } catch (error) {
            // A send whose answer was lost may still have been taken: the member's own record says so.
            const taken = (await hub.detail(sessionId).catch(() => undefined))?.messages.some(
              message => message.role === 'user' && message.requestId === sent.sendRequestId,
            )
            if (!taken) {
              refusals[index] = error
              refusal = (error instanceof AppError ? error.message : '').slice(0, 300) || '这一轮的要求没有发出。'
            }
          }
          const done = await store
            .update(teamId, (row, at) => {
              const target = row.members.find(member => member.itemId === send.member.itemId)
              if (!target || target.state !== 'starting') return false
              if (refusal === undefined) Object.assign(target, { state: 'running', startedAt: at })
              else Object.assign(target, { state: 'unstarted', refusal, endedAt: at })
            })
            .catch(() => undefined)
          published(done, [sessionId])
        }),
      )
      if (sends.every((_, index) => refusals[index] !== undefined) && before) {
        // Nothing was sent: the team stands as it did before the round, and the first refusal is the answer.
        const restored = before
        const back = await store.update(teamId, row => {
          for (const key of Object.keys(row)) delete (row as Record<string, unknown>)[key]
          Object.assign(row, structuredClone(restored))
        })
        published(back)
        throw refusals[0]
      }
      return round
    } finally {
      starting.delete(lead)
      env.sweep()
    }
  }

  /** `POST /teams/:id/rounds`: a person's round. A retry of the same request answers the same round. */
  async function start(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, id: string): Promise<void> {
    context.requireScope(caller, 'run')
    context.limits.classC.take(caller.device.id)
    const body = roundSchema.parse(await jsonBody(req))
    const team = env.visible(caller, id)
    const hash = sha256Hex(canonicalJson({ teamId: id, sends: body.sends }))
    const prior = findRound(team, caller.device.id, body.requestId)
    if (prior) {
      if (prior.hash !== hash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同内容。')
      return env.answer(res, caller, id)
    }
    context.recheck(caller, 'run')
    const sends = body.sends.map(send => {
      const member = team.members.find(one => one.itemId === send.itemId)
      if (!member) throw refusalError('unknown-member', PERSON('unknown-member'))
      let prompt: string
      try {
        prompt = checkedPrompt(send.prompt)
      } catch (error) {
        throw error instanceof AppError && error.code === 'item-secret' ? error : new AppError(400, 'invalid-input', PERSON('prompt'))
      }
      if (prompt.length > TEAM_LIMITS.promptChars) throw new AppError(400, 'invalid-input', PERSON('prompt'))
      return { member, name: member.title, prompt }
    })
    await makeRound(caller, id, sends, {
      by: 'person',
      request: { deviceId: caller.device.id, requestId: body.requestId, hash },
      words: PERSON,
    })
    env.answer(res, caller, id, 201)
  }

  async function dispatchEnded(teamId: string, reason: 'person' | 'device-removed' | 'stopped', res?: ServerResponse): Promise<void> {
    const entry = {
      action: 'team.dispatch.ended' as const,
      actor: { listener: 'host' as const },
      target: teamId,
      detail: { teamId, reason },
    }
    if (res) await context.audited(entry, res)
    else await context.audit.append(entry).catch(error => context.log(`审计记录写入失败（team.dispatch.ended）：${errorText(error)}`))
  }

  /** `PATCH /teams/:id`: the switch. On is a widening, written to the audit first; off is never held up by it. */
  async function change(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, id: string): Promise<void> {
    context.requireScope(caller, 'run')
    context.limits.classC.take(caller.device.id)
    const { agentDispatch } = changeSchema.parse(await jsonBody(req))
    const team = env.visible(caller, id)
    context.recheck(caller, 'run')
    if (!agentDispatch) {
      if (team.dispatch) {
        const off = await store.update(id, row => {
          if (!row.dispatch) return false
          delete row.dispatch
        })
        await dispatchEnded(id, 'person', res)
        published(off)
      }
      return env.answer(res, caller, id)
    }
    if (team.dispatch) return env.answer(res, caller, id)
    const refusal = refusalOf(team)
    if (refusal) throw new AppError(409, 'team-dispatch-unavailable', refusal)
    try {
      await context.audited({
        action: 'team.dispatch.allowed',
        actor: context.actorOf(caller),
        target: id,
        detail: { teamId: id, leadSessionId: team.leadSessionId },
      })
    } catch {
      throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，没有打开，请重试。')
    }
    context.recheck(caller, 'run')
    const on = await store.update(id, (row, at) => {
      if (row.dispatch) return false
      row.dispatch = {
        deviceId: caller.device.id,
        listener: caller.connection.listener,
        ...(caller.nativeOpening?.windowHash ? { nativeWindowHash: caller.nativeOpening.windowHash } : {}),
        at,
      }
    })
    published(on)
    env.answer(res, caller, id)
  }

  /** The switch goes off for good once the device that turned it on is removed or lost `run`; never back on by itself. */
  async function devicesChanged(): Promise<void> {
    for (const team of store.list()) {
      if (!team.dispatch || deps.callerOf(team.dispatch) !== 'gone') continue
      const off = await store
        .update(team.id, row => {
          if (!row.dispatch || deps.callerOf(row.dispatch) !== 'gone') return false
          delete row.dispatch
        })
        .catch(() => undefined)
      if (off && !off.dispatch) {
        await dispatchEnded(team.id, 'device-removed')
        published(off)
      }
    }
  }

  /** What the lead's agent reads of its newest team, only while the switch is on and its device may still act. */
  function roster(leadSessionId: string): TeamRoster | undefined {
    const team = newestOf(leadSessionId)
    if (!team?.dispatch || deps.callerOf(team.dispatch) === 'gone') return undefined
    return {
      members: team.members.map((member, index) => ({
        id: `m${index + 1}`,
        name: member.name ?? nameOf(member.title),
        title: member.title,
        harness: deps.harnessName(member.harnessId),
        state: member.state,
      })),
      open: teamOpen(team),
    }
  }

  /**
   * The lead's agent's `send_to_members`: its session's newest team, only with the switch on, as the device that allowed
   * it, each member by its short ID in that team and nothing else. Refused, in English, with why.
   */
  async function dispatch(input: { sessionId: string; messageId?: string; sends: unknown; key: string }): Promise<{ round: number }> {
    const team = newestOf(input.sessionId)
    if (!team) throw new Error('Not sent: this conversation leads no team.')
    if (!team.dispatch) throw new Error('Not sent: the user has not let you send work to this team. Only the user can turn it on.')
    const caller = deps.callerOf(team.dispatch)
    if (caller === 'gone') {
      await devicesChanged()
      throw new Error('Not sent: the device that allowed it was removed, so it is off now.')
    }
    if (caller === 'wait') throw new Error('Not sent: the device that allowed it cannot act right now. Try again later.')
    const parsed = agentSends.safeParse(input.sends)
    if (!parsed.success) throw new Error(`Not sent: sends must hold 1 to ${TEAM_LIMITS.members} items of { member: "m1"…, prompt }.`)
    const request = derivedUuid(['team-agent-round', input.sessionId, team.id, input.key])
    const hash = sha256Hex(canonicalJson({ teamId: team.id, sends: parsed.data }))
    const prior = findRound(team, team.dispatch.deviceId, request)
    if (prior) return { round: prior.round }
    const sends: RoundSend[] = parsed.data.map(send => {
      // By its short ID (`m1`…) or by its name, as list_members gives both.
      const byId = /^m[1-9]$/u.test(send.member) ? team.members[Number(send.member.slice(1)) - 1] : undefined
      const member = byId ?? team.members.find(row => (row.name ?? nameOf(row.title)) === send.member.trim())
      if (!member) throw new Error(AGENT('unknown-member', send.member))
      let prompt: string
      try {
        prompt = checkedPrompt(send.prompt)
      } catch {
        throw new Error(AGENT('prompt'))
      }
      if (prompt.length > TEAM_LIMITS.promptChars) throw new Error(AGENT('prompt'))
      return { member, name: send.member, prompt }
    })
    // The person who turned this on trusts these members, whatever their Harness; the device must still be able to act.
    const refused = deps.dispatchRefusal(team.dispatch.deviceId)
    if (refused) throw new Error(`Not sent: ${refused}`)
    try {
      const round = await makeRound(caller, team.id, sends, {
        by: 'agent',
        request: { deviceId: team.dispatch.deviceId, requestId: request, hash },
        ...(input.messageId ? { messageId: input.messageId } : {}),
        words: AGENT,
      })
      return { round }
    } catch (error) {
      if (error instanceof AppError && /^Not sent/u.test(error.message)) throw new Error(error.message)
      // The device lost what it needs, or the member's own path refused: never the Host's words about a prompt.
      throw new Error(
        error instanceof AppError && (error.status === 401 || error.status === 403)
          ? 'Not sent: the device that allowed it can no longer act for this team.'
          : 'Not sent: the members could not be sent this round now.',
      )
    }
  }

  return { start, change, roster, dispatch, devicesChanged, refusalOf, dispatchEnded }
}
