import {
  TEAM_LIMITS,
  TEAM_RETURN_HEADING,
  type HarnessInfo,
  type Message,
  type ModelRef,
  type TaskSummary,
  type TeamMemberState,
  type TeamStartInput,
  type TeamSummary,
  type TeamTaskInput,
} from '@latch/protocol'
import type { StatusTone } from '@latch/ui'

/** A team whose results have neither gone back nor been kept: its session starts no other meanwhile. */
export const teamOpen = (team: Pick<TeamSummary, 'state'>): boolean =>
  team.state === 'running' || team.state === 'stopping' || team.state === 'returning'

/** The teams this session started, oldest first. */
export const teamsOf = (teams: readonly TeamSummary[] | undefined, sessionId: string): TeamSummary[] =>
  (teams ?? []).filter(team => team.leadSessionId === sessionId).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))

/**
 * Whether the page offers this session a team: a Code session that is not archived, is not a member itself, and has no
 * team still open. The Host checks again (`team-lead`, `team-open`).
 */
export function canStartTeam(
  summary: Pick<TaskSummary, 'id' | 'agent' | 'generalChat' | 'personal' | 'archived' | 'teamOf' | 'origin'>,
  teams: readonly TeamSummary[] | undefined,
): boolean {
  if (summary.agent || summary.generalChat || summary.personal || summary.archived || summary.teamOf || summary.origin) return false
  return !(teams ?? []).some(team => team.leadSessionId === summary.id && teamOpen(team))
}

/** One row of the list a person writes: the whole text is what the member is asked, its first line the title. */
export interface TeamRow {
  id: string
  text: string
  harnessId: string
}

/**
 * The Harness a new row starts with: this session's for the first row, then one no row uses yet, then the least used.
 * Among equals this session's comes first, then the order they are listed in. None when no Harness is ready.
 */
export function nextHarness(
  rows: readonly Pick<TeamRow, 'harnessId'>[],
  ready: readonly Pick<HarnessInfo, 'id'>[],
  leadHarnessId: string | undefined,
): string | undefined {
  const order = [...ready.filter(harness => harness.id === leadHarnessId), ...ready.filter(harness => harness.id !== leadHarnessId)]
  const used = (id: string) => rows.filter(row => row.harnessId === id).length
  return order.toSorted((a, b) => used(a.id) - used(b.id))[0]?.id
}

const chars = (text: string) => Array.from(text)

/** A row as the Host takes it; a row with no words is not a task. */
export function taskOf(row: Pick<TeamRow, 'text' | 'harnessId'>): TeamTaskInput | undefined {
  const prompt = row.text.trim()
  const first = prompt.split('\n', 1)[0]?.trim()
  if (!prompt || !first) return undefined
  return { title: chars(first).slice(0, TEAM_LIMITS.titleChars).join(''), prompt, harnessId: row.harnessId }
}

export const rowTooLong = (row: Pick<TeamRow, 'text'>): boolean => row.text.trim().length > TEAM_LIMITS.promptChars

/** What 开始 would send, or nothing while the list cannot start: no task written, one too long, or one without a Harness. */
export function tasksOf(rows: readonly TeamRow[]): TeamTaskInput[] | undefined {
  const tasks = rows.flatMap(row => taskOf(row) ?? [])
  if (!tasks.length || tasks.length > TEAM_LIMITS.members) return undefined
  if (rows.some(rowTooLong) || tasks.some(task => !task.harnessId)) return undefined
  return tasks
}

/** Where the results are, as the card's end says it. */
export type EndMark = 'members' | 'you' | 'stopping' | 'pending' | 'returned' | 'kept'

export function endMark(team: Pick<TeamSummary, 'state' | 'members'>): { mark: EndMark; tone: StatusTone } {
  if (team.state === 'kept') return { mark: 'kept', tone: 'neutral' }
  if (team.state === 'returned') return { mark: 'returned', tone: 'done' }
  if (team.state === 'returning') return { mark: 'pending', tone: 'neutral' }
  if (team.state === 'stopping') return { mark: 'stopping', tone: 'neutral' }
  return team.members.some(member => member.state === 'waiting') ? { mark: 'you', tone: 'waiting' } : { mark: 'members', tone: 'running' }
}

/** A member's state in the tones every status on the page uses. */
export const MEMBER_TONE: Record<TeamMemberState, StatusTone> = {
  starting: 'running',
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  cancelled: 'neutral',
  unknown: 'neutral',
  unstarted: 'failed',
}

export const memberAtWork = (state: TeamMemberState): boolean => state === 'starting' || state === 'running' || state === 'waiting'

/** The turn a team's card follows: the one that holds `messageId`; none when that message is not in the record. */
export function teamTurnKey(team: Pick<TeamSummary, 'messageId'>, messages: readonly Message[]): string | undefined {
  const at = team.messageId === undefined ? -1 : messages.findIndex(message => message.id === team.messageId)
  if (at < 0) return undefined
  for (let index = at; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === 'user' && !message.steered) return message.id
  }
  // Before any prompt: the lead content's own turn.
  return messages[0] ? `lead:${messages[0].id}` : undefined
}

/**
 * Whether a message of the person's side is a team's results the Host sent: the team that names it, or, where the page
 * has no such team (it aged out of the snapshot, or the snapshot has not caught up), `true` for the Host's heading.
 */
export function returnOf(message: Pick<Message, 'id' | 'role' | 'text'>, teams: readonly TeamSummary[] | undefined): TeamSummary | boolean {
  if (message.role !== 'user') return false
  return teams?.find(team => team.returnedMessageId === message.id) ?? message.text.startsWith(TEAM_RETURN_HEADING)
}

/** A member's place among its team's members, counted from one. */
export function memberPlace(team: Pick<TeamSummary, 'members'>, sessionId: string): { place: number; of: number } | undefined {
  const index = team.members.findIndex(member => member.sessionId === sessionId)
  return index < 0 ? undefined : { place: index + 1, of: team.members.length }
}

/** The entries of a proposal as 一起开始 sends them: only what the person changed, and the Harness (and model) chosen for each. */
export function proposalStart(
  proposal: { id: string; revision: number },
  entries: ReadonlyArray<{
    index: number
    title: string
    prompt: string
    harnessId: string
    model?: ModelRef | undefined
    read: { title: string; prompt: string }
  }>,
): NonNullable<TeamStartInput['proposal']> {
  return {
    id: proposal.id,
    baseRevision: proposal.revision,
    entries: entries.map(entry => ({
      index: entry.index,
      ...(entry.title.trim() !== entry.read.title ? { title: entry.title.trim() } : {}),
      ...(entry.prompt.trim() !== entry.read.prompt ? { prompt: entry.prompt.trim() } : {}),
      harnessId: entry.harnessId,
      ...(entry.model ? { model: entry.model } : {}),
    })),
  }
}
