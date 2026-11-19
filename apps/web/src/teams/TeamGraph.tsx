import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import type { HarnessInfo, TeamMember, TeamState, TeamSummary } from '@latch/protocol'
import { Button, StatusWord, Tooltip } from '@latch/ui'
import { HarnessTile, MarkTile } from '../components/BrandTile.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { runClock } from '../conversation.ts'
import { harnessName } from '../core/harnessName.ts'
import { hostNow, parseTime, useTicker } from '../core/hostClock.ts'
import { useLocale } from '../core/i18n.ts'
import { TEAM_COPY, endWords, keptWords, memberWords } from './copy.ts'
import { MEMBER_TONE, endMark, memberAtWork } from './model.ts'
import { useTeamStop } from './start.ts'

/** What the team's parts in a conversation need from the page around them. */
export interface TeamPage {
  harnesses: readonly HarnessInfo[]
  /** Opens a member's or the lead's session. */
  openSession: (sessionId: string) => void
  /** Brings a message of this conversation into view. */
  reveal: (messageId: string) => void
  refresh: () => Promise<void>
  /** This device may stop a team. */
  canStop: boolean
  onError: (error: string) => void
}

export const TeamPageContext = createContext<TeamPage | undefined>(undefined)

export function MemberTile({ harnessId, harnesses, size = 16 }: { harnessId: string; harnesses: readonly HarnessInfo[]; size?: 16 | 20 }) {
  const harness = harnesses.find(item => item.id === harnessId)
  return harness ? <HarnessTile harness={harness} size={size} /> : <MarkTile mark={undefined} size={size} />
}

const memberHarnessName = (harnessId: string, harnesses: readonly HarnessInfo[]): string => {
  const harness = harnesses.find(item => item.id === harnessId)
  return harness ? harnessName(harness) : harnessId
}

/** How long a member has been at work, counted on the Host's clock. */
function Elapsed({ since }: { since: string }) {
  useTicker('second')
  const started = parseTime(since)
  return started === undefined ? null : <span className="team-clock">{runClock(hostNow() - started)}</span>
}

export function MemberState({ member }: { member: TeamMember }) {
  return (
    <StatusWord tone={MEMBER_TONE[member.state]} className="team-member-state">
      {memberWords(member.state)}
      {member.state === 'running' && member.startedAt && <Elapsed since={member.startedAt} />}
    </StatusWord>
  )
}

/*
 * The drawing's geometry, in px: every row is the same height, so each connector is computed from its row's place and
 * nothing on the page is measured. Wide: one pill per row across the middle; narrow: two-line pills down a rail.
 */
const WIDE = { row: 36, gap: 8, fan: 56 } as const
// The spine runs under the middle of this session's mark: the node's inset (10) and half its 16px mark.
const NARROW = { row: 52, gap: 8, rail: 32, spine: 18, end: 32 } as const

/** How a member's wire is drawn: what went in to it, and what came back from it. */
function wireStates(member: TeamMember): { into: string; out: string | undefined } {
  const into = member.state === 'unstarted' ? 'none' : member.state === 'waiting' ? 'waiting' : memberAtWork(member.state) ? 'flow' : 'done'
  const out =
    member.state === 'done'
      ? 'done'
      : member.state === 'failed'
        ? 'failed'
        : member.state === 'cancelled' || member.state === 'unknown'
          ? 'quiet'
          : undefined
  return { into, out }
}

/**
 * What runs along a wire, as light: `flow` carries work to a member at work, two beads apart, for as long as it works;
 * `sent` is the work handed out, once, as the drawing appears; `back` is a member's result reaching the results once, as
 * it ends; `stream` carries every result in while they wait to go back.
 */
type Run = 'flow' | 'sent' | 'back' | 'stream'

function Wire({ d, wire, run, row }: { d: string; wire: string; run: Run | undefined; row: number }) {
  const style = { '--team-row': row } as CSSProperties
  return (
    <g className="team-wire-group" data-wire={wire} style={style}>
      <path className="team-wire" data-wire={wire} d={d} />
      {run && <path className="team-bead" data-run={run} d={d} pathLength={100} />}
      {(run === 'flow' || run === 'stream') && <path className="team-bead is-second" data-run={run} d={d} pathLength={100} />}
    </g>
  )
}

/** The light on a member's wire out, and on its wire back in while the team is where `state` says. */
function runs(member: TeamMember, team: TeamState): { out: Run | undefined; back: Run | undefined } {
  const out =
    member.state === 'running' || member.state === 'starting'
      ? 'flow'
      : member.state === 'unstarted' || member.state === 'waiting'
        ? undefined
        : 'sent'
  const back = member.state !== 'done' ? undefined : team === 'returning' ? 'stream' : 'back'
  return { out, back }
}

/** The wide drawing's connectors: from this session out to every member, or from every member in to the results. */
function Fan({ members, side, team }: { members: readonly TeamMember[]; side: 'out' | 'in'; team: TeamState }) {
  const height = members.length * (WIDE.row + WIDE.gap) - WIDE.gap
  const middle = height / 2
  const w = WIDE.fan
  return (
    <svg className={`team-fan is-${side}`} width={w} height={height} viewBox={`0 0 ${w} ${height}`} aria-hidden="true">
      {members.map((member, index) => {
        const y = index * (WIDE.row + WIDE.gap) + WIDE.row / 2
        const [from, to] = side === 'out' ? [middle, y] : [y, middle]
        const { into, out } = wireStates(member)
        const light = runs(member, team)
        return (
          <Wire
            key={member.itemId}
            d={`M 0 ${from} C ${w * 0.55} ${from} ${w * 0.45} ${to} ${w} ${to}`}
            wire={side === 'out' ? into : (out ?? 'idle')}
            run={side === 'out' ? light.out : light.back}
            row={index}
          />
        )
      })}
    </svg>
  )
}

/** The narrow drawing's rail: down from this session, round into each member's pill, and last into the results. */
function Rail({ members, end, team }: { members: readonly TeamMember[]; end: string; team: TeamState }) {
  const pitch = NARROW.row + NARROW.gap
  const listed = members.length * pitch - NARROW.gap
  const height = listed + NARROW.gap + NARROW.end
  const x = NARROW.spine
  const w = NARROW.rail
  const elbow = (y: number) => `M ${x} 0 V ${y - 8} Q ${x} ${y} ${x + 8} ${y} H ${w}`
  return (
    <svg className="team-rail" width={w} height={height} viewBox={`0 0 ${w} ${height}`} aria-hidden="true">
      <Wire
        d={elbow(listed + NARROW.gap + NARROW.end / 2)}
        wire={end}
        run={team === 'returning' ? 'stream' : team === 'returned' ? 'back' : undefined}
        row={members.length}
      />
      {members.map((member, index) => (
        <Wire
          key={member.itemId}
          d={elbow(index * pitch + NARROW.row / 2)}
          wire={wireStates(member).into}
          run={runs(member, team).out}
          row={index}
        />
      ))}
    </svg>
  )
}

function MemberRow({ member, page, index }: { member: TeamMember; page: TeamPage; index: number }) {
  const body = (
    <>
      <MemberTile harnessId={member.harnessId} harnesses={page.harnesses} />
      <span className="team-member-title">
        <VisibleText text={member.title} />
      </span>
      <span className="team-member-said" data-refusal={member.state === 'unstarted' && member.refusal ? '' : undefined}>
        {member.state === 'unstarted' && member.refusal ? (
          <VisibleText text={member.refusal} />
        ) : (
          member.said && <VisibleText text={member.said} />
        )}
      </span>
      <MemberState member={member} />
    </>
  )
  const name = `${member.title} · ${memberHarnessName(member.harnessId, page.harnesses)} · ${memberWords(member.state)}`
  const main = member.sessionId ? (
    <button type="button" className="team-member-main" aria-label={name} onClick={() => page.openSession(member.sessionId!)}>
      {body}
    </button>
  ) : (
    <div className="team-member-main" aria-label={name} tabIndex={member.refusal ? 0 : undefined}>
      {body}
    </div>
  )
  return (
    <li
      className="team-member"
      data-state={member.state}
      data-work={member.state === 'running' || member.state === 'starting' ? '' : undefined}
      data-ended={memberAtWork(member.state) ? undefined : ''}
      // Each pill's light starts at its own point, so the rows never pulse in step.
      style={{ '--team-row': index } as CSSProperties}>
      <Tooltip content={member.state === 'unstarted' ? member.refusal : undefined}>{main}</Tooltip>
    </li>
  )
}

/** Where the results are: a node the wires come together into. Once they are back it leads to them. */
function End({ team, page }: { team: TeamSummary; page: TeamPage }) {
  const { mark, tone } = endMark(team)
  const ended = team.members.filter(member => !memberAtWork(member.state)).length
  const word = (
    <StatusWord tone={tone} className="team-end-word">
      {endWords(mark)}
    </StatusWord>
  )
  const count = (mark === 'members' || mark === 'you') && (
    <span className="team-end-count">{TEAM_COPY.ended(ended, team.members.length)}</span>
  )
  return (
    <div className="team-end" data-end={mark}>
      {mark === 'returned' && team.returnedMessageId ? (
        <button type="button" className="team-node team-end-link" onClick={() => page.reveal(team.returnedMessageId!)}>
          {word}
        </button>
      ) : mark === 'kept' ? (
        <Tooltip content={keptWords(team.kept)}>
          <span tabIndex={0} className="team-node team-end-kept">
            {word}
          </span>
        </Tooltip>
      ) : (
        <span className="team-node">
          {word}
          {count}
        </span>
      )}
    </div>
  )
}

function Stop({ team, page }: { team: TeamSummary; page: TeamPage }) {
  const { status, stop } = useTeamStop(team.id, page.refresh)
  if (!page.canStop || (team.state !== 'running' && team.state !== 'returning')) return null
  return (
    <Button
      size="xs"
      variant="ghost"
      className="team-stop"
      disabled={status.state === 'sending'}
      onClick={() => {
        void stop().then(reason => {
          if (reason) page.onError(reason)
        })
      }}>
      {status.state === 'sending' ? TEAM_COPY.endStopping : TEAM_COPY.stop}
    </Button>
  )
}

/** The wire into the results: flowing while they wait to go back, full once they are back, quiet when kept. */
const endWire = (team: TeamSummary): string =>
  team.state === 'returned' ? 'done' : team.state === 'returning' ? 'flow' : team.state === 'kept' ? 'quiet' : 'idle'

/**
 * A team in its session's conversation, drawn as work passing through: this session as a node, curved wires out to one
 * pill per member, and the wires coming together into the node where the results are. Left to right where the card is
 * wide; down a rail where it is narrow. Light runs along a member's wire and across its pill while it works; once it
 * has ended, its wire into the results takes its colour.
 */
export function TeamGraph({ team, lead }: { team: TeamSummary; lead: { name: string; harness?: HarnessInfo | undefined } }): ReactNode {
  useLocale()
  const page = useContext(TeamPageContext)
  if (!page) return null
  return (
    <section
      className="team-card"
      data-team={team.id}
      data-state={team.state}
      aria-label={TEAM_COPY.said(team.members.length)}
      style={{ '--team-rows': team.members.length } as CSSProperties}>
      <header className="team-head">
        <span className="team-goal">{team.goal ? <VisibleText text={team.goal} /> : TEAM_COPY.team}</span>
        <span className="team-count">{TEAM_COPY.memberCount(team.members.length)}</span>
        <Stop team={team} page={page} />
      </header>
      <div className="team-graph">
        <span className="team-node team-lead">
          {lead.harness ? <HarnessTile harness={lead.harness} size={16} /> : <MarkTile mark={undefined} size={16} />}
          <span className="team-lead-name">
            <VisibleText text={lead.name} />
          </span>
        </span>
        <Fan members={team.members} side="out" team={team.state} />
        <Rail members={team.members} end={endWire(team)} team={team.state} />
        <ul className="team-members">
          {team.members.map((member, index) => (
            <MemberRow key={member.itemId} member={member} page={page} index={index} />
          ))}
        </ul>
        <Fan members={team.members} side="in" team={team.state} />
        <End team={team} page={page} />
      </div>
    </section>
  )
}
