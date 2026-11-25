import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TEAM_LIMITS,
  type FileMention,
  type Message,
  type TaskSummary,
  type TeamAnswer,
  type TeamMember,
  type TeamRound,
  type TeamRoundInput,
  type TeamSummary,
} from '@latch/protocol'
import { api, ApiError, errorMessage, newRequestId } from '../core/api.ts'
import { unconfirmedReason } from '../core/sendingMessage.ts'
import { promptChips } from '../composer/prompt-tokens.ts'
import { TEAM_COPY } from './copy.ts'
import { memberAtWork, teamOpen } from './model.ts'

/**
 * Later rounds of a team: who in the lead's input can be sent more work, the members a draft names, a
 * round's reply in a member's own session, and the requests a round and the switch make.
 */

/** A member as the lead's input offers it after `@`: the token its chip is in the draft, and why it cannot take work now. */
export interface MemberChoice {
  itemId: string
  token: string
  /** What the member is called; `title` is its task. */
  name: string
  title: string
  harnessId: string
  member: TeamMember
  /** Why it is shown but cannot be chosen: at work, archived, never started, or the team's round still open. */
  disabled?: string
}

const TOKEN_CHARS = 24

/** A member's chip in the draft: `@` and its name with spaces as `-`, cut short; a second of the same name gets `-2`. */
export function memberTokens(members: readonly Pick<TeamMember, 'name' | 'title'>[]): string[] {
  const seen = new Map<string, number>()
  return members.map(member => {
    const said = (member.name || member.title).trim().replace(/\s+/gu, '-')
    const base = `@${Array.from(said).slice(0, TOKEN_CHARS).join('') || 'member'}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}-${count}`
  })
}

/** The newest team this session leads: the one its input and its agent send work to. */
export const leadTeamOf = (teams: readonly TeamSummary[] | undefined, sessionId: string): TeamSummary | undefined =>
  (teams ?? [])
    .filter(team => team.leadSessionId === sessionId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1)

/** The members the lead's input lists, each with why it cannot take work now, from the snapshot's sessions. */
export function memberChoices(team: TeamSummary, tasks: readonly Pick<TaskSummary, 'id' | 'status' | 'archived'>[]): MemberChoice[] {
  const tokens = memberTokens(team.members)
  const open = teamOpen(team)
  return team.members.map((member, index) => {
    const session = member.sessionId ? tasks.find(task => task.id === member.sessionId) : undefined
    const disabled = !member.sessionId
      ? TEAM_COPY.memberUnstarted
      : !session || session.archived
        ? TEAM_COPY.memberArchived
        : memberAtWork(member.state) || session.status === 'running' || session.status === 'waiting-approval'
          ? TEAM_COPY.memberBusy
          : open
            ? TEAM_COPY.roundOpen
            : undefined
    return {
      itemId: member.itemId,
      token: tokens[index]!,
      name: member.name || member.title,
      title: member.title,
      harnessId: member.harnessId,
      member,
      ...(disabled ? { disabled } : {}),
    }
  })
}

/** Only visible member references address a round; a name inside a cited source stays literal. */
export function memberMarks(
  text: string,
  choices: readonly Pick<MemberChoice, 'token' | 'itemId' | 'title'>[],
  refs: readonly FileMention[] = [],
) {
  if (!choices.length || !text.includes('@')) return []
  const byToken = new Map(choices.map(choice => [choice.token, choice]))
  const members = choices.map(choice => ({ ...choice, name: choice.title }))
  return promptChips(text, { members }, refs).flatMap(({ start, end, kind }) => {
    const member = kind === 'member' && byToken.get(text.slice(start, end))
    return member ? [{ start, end, itemId: member.itemId, title: member.title }] : []
  })
}

/**
 * What a draft that names members sends: one round, the draft's text without the chips as each named member's prompt.
 * Undefined when it names none (it goes to this session as ever). `ready` only with words, within the limits, every
 * named member free to take work.
 */
export function draftRound(
  text: string,
  choices: readonly MemberChoice[],
  refs: readonly FileMention[] = [],
): { itemIds: string[]; prompt: string; ready: boolean; reason?: string } | undefined {
  const marks = memberMarks(text, choices, refs)
  if (!marks.length) return undefined
  const itemIds = [...new Set(marks.map(mark => mark.itemId))]
  let prompt = ''
  let at = 0
  for (const mark of marks) {
    const before = text.slice(at, mark.start)
    at = mark.end
    if (/[ \t]$/u.test(before) && /[ \t]/u.test(text[at] ?? '')) {
      prompt += before.replace(/[ \t]+$/u, ' ')
      while (text[at] === ' ' || text[at] === '\t') at++
    } else prompt += before
  }
  prompt = (prompt + text.slice(at)).trim()
  const busy = choices.find(choice => itemIds.includes(choice.itemId) && choice.disabled)
  const reason = busy
    ? `${busy.title} · ${busy.disabled}`
    : !prompt
      ? TEAM_COPY.writeFirst
      : prompt.length > TEAM_LIMITS.promptChars
        ? TEAM_COPY.tooLong
        : undefined
  return { itemIds, prompt, ready: reason === undefined, ...(reason ? { reason } : {}) }
}

/** The round whose results a returned message carried, and how many rounds the team has had. */
export function roundOfReturn(team: TeamSummary, messageId: string): { round: TeamRound | undefined; count: number } {
  const rounds = team.rounds ?? []
  return { round: rounds.find(round => round.returnedMessageId === messageId), count: rounds.length || 1 }
}

/**
 * A member's reply to one round, in its own session: the last words after that round's message (its `requestId`; the
 * start's is the session's first message) and before the next message to it.
 */
export function replyOf(messages: readonly Pick<Message, 'role' | 'text' | 'requestId'>[], requestId?: string): string {
  const start = requestId
    ? messages.findIndex(message => message.role === 'user' && message.requestId === requestId)
    : messages.findIndex(message => message.role === 'user')
  if (start < 0) return ''
  const next = messages.findIndex((message, index) => index > start && message.role === 'user')
  const turn = messages.slice(start + 1, next < 0 ? undefined : next)
  return turn.findLast(message => message.role === 'assistant' && message.text.trim())?.text ?? ''
}

/** `failed` names what it was for (the draft's text), so the page says it only while that is still what is written. */
export type RoundState = { state: 'idle' } | { state: 'sending' } | { state: 'failed'; reason: string; key: string }

/**
 * Sends a round. A send whose answer never came keeps its request: sending the same members the same words again reuses
 * it, so the Host makes the round once. Any other answer lets the next be a new request.
 */
export function useTeamRound(teamId: string | undefined, refresh: () => Promise<void>) {
  const [status, setStatus] = useState<RoundState>({ state: 'idle' })
  const held = useRef<TeamRoundInput | undefined>(undefined)
  const flying = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const set = (next: RoundState) => {
    if (alive.current) setStatus(next)
  }
  const send = useCallback(
    async (sends: TeamRoundInput['sends'], key = ''): Promise<boolean> => {
      if (!teamId || flying.current) return false
      const same = held.current && JSON.stringify(held.current.sends) === JSON.stringify(sends)
      const body: TeamRoundInput = same ? held.current! : { requestId: newRequestId(), sends }
      held.current = body
      flying.current = true
      set({ state: 'sending' })
      try {
        await api<TeamAnswer>(`teams/${encodeURIComponent(teamId)}/rounds`, { method: 'POST', body })
        held.current = undefined
        set({ state: 'idle' })
        await refresh().catch(() => {})
        return true
      } catch (cause) {
        if (unconfirmedReason(cause) === null) held.current = undefined
        set({ state: 'failed', reason: errorMessage(cause), key })
        if (cause instanceof ApiError && cause.status === 409) await refresh().catch(() => {})
        return false
      } finally {
        flying.current = false
      }
    },
    [teamId, refresh],
  )
  const clear = useCallback(() => set({ state: 'idle' }), [])
  return { status, send, clear }
}

/** The switch: in flight until the Host answers; a failure comes back in words for the page to say. */
export function useDispatchSwitch(teamId: string, refresh: () => Promise<void>) {
  const [sending, setSending] = useState<boolean | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const change = useCallback(
    async (agentDispatch: boolean): Promise<string | undefined> => {
      setSending(agentDispatch)
      try {
        await api<TeamAnswer>(`teams/${encodeURIComponent(teamId)}`, { method: 'PATCH', body: { agentDispatch } })
        await refresh().catch(() => {})
        return undefined
      } catch (cause) {
        await refresh().catch(() => {})
        return errorMessage(cause)
      } finally {
        if (alive.current) setSending(undefined)
      }
    },
    [teamId, refresh],
  )
  /** `sending`: the value it is being turned to, while that is on its way. */
  return { sending, change }
}
