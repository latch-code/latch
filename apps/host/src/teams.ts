import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import {
  LISTENER_CLASSES,
  TEAM_LIMITS,
  TEAM_RETURN_ASK,
  TEAM_RETURN_HEADING,
  WORK_ITEM_LIMITS,
  type TeamMember,
  type TeamMemberState,
  type TeamSummary,
} from '@latch/protocol'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { HARNESS_ID } from './work-items.ts'

const TEAMS_FILE = join('work', 'teams.json')
/** A member's `said`: the first line of its last reply, at most this long. */
const TEAM_SAID_CHARS = 200
/** What one prompt takes (`promptSchema`): the return stays under it whatever the members wrote. */
const PROMPT_CHARS = 16_000
/** Said in place of the part of a longer reply that was left out; the end is what is kept. */
export const TEAM_CUT_MARK = '…（前面省略）'

const TEAM_ID = /^tem_[A-Za-z0-9_-]{22}$/u
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
const sessionIdText = z.string().min(1).max(256)
const hex64 = z.string().regex(/^[a-f0-9]{64}$/u)
const memberState = z.enum(['starting', 'running', 'waiting', 'done', 'failed', 'cancelled', 'unknown', 'unstarted'])

const memberSchema = z.strictObject({
  itemId: z.string().regex(/^itm_[A-Za-z0-9_-]{22}$/u),
  sessionId: sessionIdText.optional(),
  title: z
    .string()
    .min(1)
    .max(WORK_ITEM_LIMITS.titleChars * 4),
  harnessId: z.string().regex(HARNESS_ID),
  state: memberState,
  refusal: z.string().min(1).max(1000).optional(),
  said: z.string().min(1).max(TEAM_SAID_CHARS).optional(),
  /** The end of its last reply, at most `TEAM_LIMITS.resultChars`; `resultCut`: the reply was longer. Never sent to a device. */
  result: z.string().max(TEAM_LIMITS.resultChars).optional(),
  resultCut: z.literal(true).optional(),
  /** The branch of its own worktree, where its changes are; the lead is told, so it reads the work, not only the reply. */
  branch: z.string().min(1).max(256).optional(),
  startedAt: isoTime.optional(),
  endedAt: isoTime.optional(),
})
// Every persisted field is listed and the objects are strict, as the 待办 file beside it.
const teamSchema = z.strictObject({
  id: z.string().regex(TEAM_ID),
  leadSessionId: sessionIdText,
  messageId: z.string().min(1).max(256).optional(),
  proposalId: z
    .string()
    .regex(/^wpp_[A-Za-z0-9_-]{22}$/u)
    .optional(),
  goal: z
    .string()
    .min(1)
    .max(WORK_ITEM_LIMITS.titleChars * 4)
    .optional(),
  /**
   * The device that started it, as a queued message keeps its sender: the members were started as it, and the results go
   * to the lead as it, checked again then.
   */
  actor: z.strictObject({
    deviceId: z.string().min(1).max(64),
    listener: z.enum(LISTENER_CLASSES),
    nativeWindowHash: z.string().min(1).max(128).optional(),
  }),
  /** The start request, by that device: a retry answers this team. */
  request: z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u), hash: hex64 }),
  /** The lead was private when the team was read: only the full data scope reads the team from then on. Never cleared. */
  private: z.literal(true).optional(),
  members: z.array(memberSchema).min(1).max(TEAM_LIMITS.members),
  state: z.enum(['running', 'stopping', 'returning', 'returned', 'kept']),
  kept: z.enum(['lead-gone', 'device-removed', 'stopped']).optional(),
  /** The request ID of the one message that carries the results to the lead: from the team's ID, so every try reuses it. */
  returnRequestId: z.string().uuid(),
  returnedMessageId: z.string().min(1).max(256).optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
})
const fileSchema = z
  .strictObject({ version: z.literal(1), teams: z.array(teamSchema).max(TEAM_LIMITS.stored) })
  .superRefine((file, ctx) => {
    if (new Set(file.teams.map(team => team.id)).size !== file.teams.length) ctx.addIssue({ code: 'custom', message: 'duplicate team' })
  })

export type TeamRecord = z.infer<typeof teamSchema>
export type TeamMemberRecord = z.infer<typeof memberSchema>

const ENDS: ReadonlySet<TeamMemberState> = new Set(['done', 'failed', 'cancelled', 'unknown', 'unstarted'])
/** The member is at an end: nothing more is waited for from it. */
export const memberEnded = (member: Pick<TeamMemberRecord, 'state'>): boolean => ENDS.has(member.state)
/** The team has not ended: it counts against its lead's one open team, and the watcher looks at it. */
export const teamOpen = (team: Pick<TeamRecord, 'state'>): boolean => team.state !== 'returned' && team.state !== 'kept'

export const newTeamId = (): string => `tem_${randomBytes(16).toString('base64url')}`

/** A UUID from a hash of `parts`: the same parts, the same ID. */
export function derivedUuid(parts: readonly unknown[]): string {
  const hex = sha256Hex(canonicalJson(parts))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The first line of a reply with any words, cut to `TEAM_SAID_CHARS` code points. */
export function saidOf(reply: string): string | undefined {
  const line = reply
    .split(/\r?\n/u)
    .map(part => part.trim())
    .find(Boolean)
  if (!line) return undefined
  const points = [...line]
  return points.length > TEAM_SAID_CHARS ? `${points.slice(0, TEAM_SAID_CHARS - 1).join('')}…` : line
}

/** The end of a reply, at most `limit` characters; `cut` when the reply was longer. */
export function resultOf(reply: string, limit: number = TEAM_LIMITS.resultChars): { result: string; cut: boolean } {
  const text = reply.trim()
  if (text.length <= limit) return { result: text, cut: false }
  let end = text.slice(text.length - limit)
  // Never half of a surrogate pair.
  if (/^[\udc00-\udfff]/u.test(end)) end = end.slice(1)
  return { result: end, cut: true }
}

const END_WORDS: Record<TeamMemberState, string> = {
  starting: '没有开始',
  running: '没有结束',
  waiting: '没有结束',
  done: '已完成',
  failed: '失败了',
  cancelled: '已取消',
  unknown: '结束方式未知',
  unstarted: '没有开始',
}

/**
 * The one message that carries a team's results to its lead: the heading, a block per member (its title, its Harness
 * and how it ended, then the end of its last reply or why there is none), and the ask. `withheld`: members whose reply
 * stays in their own session (private now, while the lead is not). Always under what one prompt takes: when the blocks
 * would not fit, every reply is cut to the same shorter length.
 */
export function teamReturnText(
  team: Pick<TeamRecord, 'members'>,
  harnessName: (harnessId: string) => string,
  withheld: ReadonlySet<string> = new Set(),
): string {
  const build = (limit: number) => {
    const blocks = team.members.map(member => {
      const head = `【${member.title}】（${harnessName(member.harnessId)}）：${END_WORDS[member.state]}`
      if (member.state === 'unstarted') return `${head}\n${member.refusal ?? '会话没有开始。'}`
      if (member.state !== 'done') return `${head}\n这个成员没有正常结束，没有可用的结果。`
      if (member.sessionId && withheld.has(member.sessionId)) return `${head}\n它的会话是私有的，结果没有带回，请到它的会话里查看。`
      if (!member.result) return `${head}\n它没有留下回复。`
      const { result, cut } = resultOf(member.result, limit)
      const where = member.branch ? `它的改动在分支 ${member.branch} 上，在它自己的工作树里。\n` : ''
      return `${head}\n${where}${cut || member.resultCut ? `${TEAM_CUT_MARK}\n` : ''}${result}`
    })
    return [TEAM_RETURN_HEADING, ...blocks, TEAM_RETURN_ASK].join('\n\n')
  }
  let limit: number = TEAM_LIMITS.resultChars
  let text = build(limit)
  while (text.length >= PROMPT_CHARS && limit > 100) {
    limit = Math.floor(limit / 2)
    text = build(limit)
  }
  return text
}

/** A member as a device reads it; `readable`: it may read the member's session (its ID and what it said). */
function memberView(member: TeamMemberRecord, readable: boolean): TeamMember {
  return {
    itemId: member.itemId,
    ...(member.sessionId && readable ? { sessionId: member.sessionId } : {}),
    title: member.title,
    harnessId: member.harnessId,
    state: member.state,
    ...(member.refusal ? { refusal: member.refusal } : {}),
    ...(member.said && readable ? { said: member.said } : {}),
    ...(member.startedAt ? { startedAt: member.startedAt } : {}),
    ...(member.endedAt ? { endedAt: member.endedAt } : {}),
  }
}

export function teamSummary(team: TeamRecord, readable: (sessionId: string) => boolean): TeamSummary {
  return {
    id: team.id,
    leadSessionId: team.leadSessionId,
    ...(team.messageId ? { messageId: team.messageId } : {}),
    ...(team.proposalId ? { proposalId: team.proposalId } : {}),
    ...(team.goal ? { goal: team.goal } : {}),
    state: team.state,
    ...(team.kept ? { kept: team.kept } : {}),
    members: team.members.map(member => memberView(member, member.sessionId === undefined || readable(member.sessionId))),
    ...(team.returnedMessageId ? { returnedMessageId: team.returnedMessageId } : {}),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  }
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/**
 * `work/teams.json`: the teams (docs/TEAMS.md), written atomically (0600) one change at a time, as the 待办 file beside
 * it. A change is published in memory only once the file holds it. At most `TEAM_LIMITS.stored`: the oldest ended ones
 * go first, an open one never.
 */
export class TeamStore {
  private queue: Promise<void> = Promise.resolve()
  private byMember = new Map<string, string>()

  private constructor(
    private readonly path: string,
    private readonly dir: string,
    private teams: TeamRecord[],
    private readonly now: () => number,
  ) {
    this.index()
  }

  static async open(dataDir: string, options: { now?: () => number } = {}): Promise<TeamStore> {
    const path = join(dataDir, TEAMS_FILE)
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
    let teams: TeamRecord[] = []
    if (text !== undefined)
      try {
        teams = fileSchema.parse(JSON.parse(text)).teams
      } catch {
        throw new AppError(500, 'config-corrupt', `团队文件 ${path} 无法读取，原文件已保留；请修复或移走后重启`)
      }
    return new TeamStore(path, join(dataDir, 'work'), teams, options.now ?? Date.now)
  }

  list(): readonly TeamRecord[] {
    return this.teams
  }

  get(id: string): TeamRecord | undefined {
    return this.teams.find(team => team.id === id)
  }

  /** The team a session is a member of: the newest one that holds it. */
  memberOf(sessionId: string): TeamRecord | undefined {
    const id = this.byMember.get(sessionId)
    return id === undefined ? undefined : this.get(id)
  }

  /** The teams of a lead that have not ended. */
  openOf(leadSessionId: string): TeamRecord[] {
    return this.teams.filter(team => team.leadSessionId === leadSessionId && teamOpen(team))
  }

  /**
   * One change, against the teams as they stand when its turn comes: `change` edits a copy and says whether anything
   * changed. Throwing refuses it with nothing written.
   */
  transact<T>(change: (draft: TeamRecord[], at: string) => { result: T; changed: boolean }): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.teams)
      const at = new Date(this.now()).toISOString()
      const { result, changed } = change(draft, at)
      if (!changed) return result
      while (draft.length > TEAM_LIMITS.stored) {
        const index = draft.findIndex(team => !teamOpen(team))
        if (index < 0) break
        draft.splice(index, 1)
      }
      const file = { version: 1 as const, teams: draft }
      if (!fileSchema.safeParse(file).success) throw new AppError(500, 'team-invalid', '团队无法保存：内容不符合格式，没有写入。')
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        await writeFileAtomic(this.path, JSON.stringify(file) + '\n', { prefix: '.teams.json.' })
      } catch {
        throw new AppError(503, 'team-write-unknown', '团队没有确认保存，请重试同一次操作。')
      }
      this.teams = draft
      this.index()
      return result
    })
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** One team's change; undefined when it is gone. `change` answers false when nothing changed. */
  update(id: string, change: (team: TeamRecord, at: string) => boolean | void): Promise<TeamRecord | undefined> {
    return this.transact((draft, at) => {
      const team = draft.find(one => one.id === id)
      if (!team) return { result: undefined, changed: false }
      if (change(team, at) === false) return { result: team, changed: false }
      team.updatedAt = at
      return { result: team, changed: true }
    })
  }

  flush(): Promise<void> {
    return this.queue
  }

  private index(): void {
    this.byMember = new Map()
    for (const team of this.teams) for (const member of team.members) if (member.sessionId) this.byMember.set(member.sessionId, team.id)
  }
}
