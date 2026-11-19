/**
 * A team (docs/TEAMS.md): one session, the lead, with several others that each do one piece of work at the same time,
 * each on the Harness chosen for it, and whose results the Host hands back to the lead once every one has ended. The
 * members are ordinary sessions and ordinary 待办; the team is what ties them to the lead and brings the results back.
 *
 * Nothing starts by itself. A team starts when the person presses start on a split: one the lead's agent proposed
 * (`propose_todos`, a todo proposal of this session), or a list the person wrote. The Host starts every member as that
 * device and sends the results to the lead as that device.
 */

export const TEAM_LIMITS = {
  /** Members of one team: what one proposal carries. */
  members: 8,
  /** Teams of one lead that have not ended; a lead waits for one before it starts the next. */
  openPerLead: 1,
  /** Teams the Host keeps, ended ones included; the oldest ended go first. */
  stored: 256,
  /** Of one member's last reply, what goes back to the lead; the end of a longer one is kept and the cut said. */
  resultChars: 1600,
  /** A task the person writes in the list. */
  titleChars: 120,
  promptChars: 4000,
} as const

/**
 * Where a member stands. `waiting`: it waits for the person (an approval or a question). `done`, `failed`, `cancelled`
 * and `unknown` (its Harness ended without saying how) are ends; `unstarted`: its session could not be started.
 */
export type TeamMemberState = 'starting' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'unknown' | 'unstarted'

export interface TeamMember {
  /** The 待办 it is. */
  itemId: string
  /** Its session, once started. Absent to a device that may not read it. */
  sessionId?: string
  title: string
  harnessId: string
  state: TeamMemberState
  /** Why it did not start, in the Host's words. */
  refusal?: string
  /** The first line of its last reply, for the lead's page; the whole reply is in its own session. */
  said?: string
  startedAt?: string
  endedAt?: string
}

/**
 * `running`: members are at work. `returning`: all have ended and the results wait to go to the lead (it is busy, or
 * waits for the person). `returned`: the lead was sent them (`returnedMessageId` is that message). `kept`: they were
 * not sent and will not be: the lead is archived or gone, the device that started the team was removed, or the person
 * stopped the team; the results stay on the page. `stopping`: stop was pressed and members are still ending.
 */
export type TeamState = 'running' | 'stopping' | 'returning' | 'returned' | 'kept'

/** What the snapshot lists (`AppSnapshot.teams`) for leads the reader can see. */
export interface TeamSummary {
  /** `tem_` and 22 base64url characters. */
  id: string
  leadSessionId: string
  /** The user message of the lead's turn the split came from, or the lead's last message when the person wrote it. */
  messageId?: string
  /** The proposal it was started from. */
  proposalId?: string
  goal?: string
  state: TeamState
  /** Why the results were kept. */
  kept?: 'lead-gone' | 'device-removed' | 'stopped'
  members: TeamMember[]
  returnedMessageId?: string
  createdAt: string
  updatedAt: string
}

/** One task of a list the person wrote. */
export interface TeamTaskInput {
  title: string
  prompt: string
  harnessId: string
}

/**
 * `POST /link/api/tasks/:id/team`: start a team of the session `:id`. Either `proposal` (a pending todo proposal of
 * this session; the entries named, as edited, are accepted and started in one go) or `tasks` (a list the person wrote).
 * Needs `run`. Answers 201 `{ team }` once every member has been started or refused.
 */
export interface TeamStartInput {
  requestId: string
  proposal?: { id: string; baseRevision: number; entries?: Array<{ index: number; title?: string; prompt?: string; harnessId?: string }> }
  tasks?: TeamTaskInput[]
  goal?: string
}

/** `POST /link/api/teams/:id/stop`: cancel every member still at work; the results are kept, not sent. */
export interface TeamStopInput {
  requestId: string
}

export interface TeamAnswer {
  team: TeamSummary
}

/** Which team a session is a member of (`TaskSummary.teamOf`): the Host's record, never the driver's. */
export interface TeamMembership {
  teamId: string
  leadSessionId: string
}

/**
 * How the results are worded to the lead, as one message from the Host: outside content, since other agents wrote it.
 * Every member is named with its Harness and how it ended; a member that did not end well says so instead of a result.
 */
export const TEAM_RETURN_HEADING = '团队成员都结束了。下面是每个成员的结果，由各自的 Agent 写下，不是用户的话：'
export const TEAM_RETURN_ASK = '请核对这些结果，指出彼此不一致或没做完的地方，然后给出汇总。'
