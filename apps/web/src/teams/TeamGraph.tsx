import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import type { HarnessInfo, TeamMember, TeamSummary } from '@latch/protocol'
import { ArrowRight } from 'lucide-react'
import { Button, Icon, StatusWord, Tooltip } from '@latch/ui'
import { HarnessTile, MarkTile } from '../components/BrandTile.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { runClock } from '../conversation.ts'
import { harnessName } from '../core/harnessName.ts'
import { hostNow, parseTime, useTicker } from '../core/hostClock.ts'
import { useLocale } from '../core/i18n.ts'
import { TEAM_COPY, endWords, keptWords, memberWords } from './copy.ts'
import { MEMBER_TONE, endMark, memberAtWork, teamOpen } from './model.ts'
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

/**
 * A member's pipe, across the middle of its row from the fan to the join: work flows along it while the member is at
 * work, and it fills in the member's colour once it has ended.
 */
function Pipe() {
  return (
    <span className="team-pipe" aria-hidden="true">
      <span className="team-flow" />
    </span>
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
      <Pipe />
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
      // Each pipe's flow starts at its own point, so the rows never pulse in step.
      style={{ '--team-row': index } as CSSProperties}>
      <span className="team-stub" aria-hidden="true" />
      <Tooltip content={member.state === 'unstarted' ? member.refusal : undefined}>{main}</Tooltip>
      <span className="team-stub is-out" aria-hidden="true" />
    </li>
  )
}

function End({ team, page }: { team: TeamSummary; page: TeamPage }) {
  const { mark, tone } = endMark(team)
  const { status, stop } = useTeamStop(team.id, page.refresh)
  const word = (
    <StatusWord tone={tone} className="team-end-word">
      {endWords(mark)}
    </StatusWord>
  )
  const stoppable = page.canStop && (team.state === 'running' || team.state === 'returning')
  return (
    <div className="team-end" data-end={mark}>
      {mark === 'returned' && team.returnedMessageId ? (
        <button type="button" className="team-end-link" onClick={() => page.reveal(team.returnedMessageId!)}>
          {word}
        </button>
      ) : mark === 'kept' ? (
        <Tooltip content={keptWords(team.kept)}>
          <span tabIndex={0} className="team-end-kept">
            {word}
          </span>
        </Tooltip>
      ) : (
        word
      )}
      {stoppable && (
        <Button
          size="xs"
          variant="outline"
          disabled={status.state === 'sending'}
          onClick={() => {
            void stop().then(reason => {
              if (reason) page.onError(reason)
            })
          }}>
          {status.state === 'sending' ? TEAM_COPY.endStopping : TEAM_COPY.stop}
        </Button>
      )}
    </div>
  )
}

/**
 * A team in its session's conversation, as work through pipes: this session on one side, a pipe that fans out to one
 * per member across its row, and the pipes joining into the one that carries the results back. Left to right where
 * there is room; on a narrow card each member's pipe runs under its row. Work flows only along a pipe whose member is
 * at work, and a pipe fills once its member has ended.
 */
export function TeamGraph({ team, lead }: { team: TeamSummary; lead: { name: string; harness?: HarnessInfo | undefined } }): ReactNode {
  useLocale()
  const page = useContext(TeamPageContext)
  if (!page) return null
  const live = teamOpen(team) && team.members.some(member => member.state === 'running' || member.state === 'starting')
  // The results' pipe: flowing while they wait to go back, full once they have.
  const out = team.state === 'returning' ? 'flow' : team.state === 'returned' ? 'full' : undefined
  return (
    <section className="team-card" data-team={team.id} data-state={team.state} aria-label={TEAM_COPY.said(team.members.length)}>
      {team.goal && (
        <p className="team-goal">
          <VisibleText text={team.goal} />
        </p>
      )}
      <div className="team-graph" data-live={live ? '' : undefined}>
        <div className="team-lead">
          {lead.harness ? <HarnessTile harness={lead.harness} size={20} /> : <MarkTile mark={undefined} size={20} />}
          <span className="team-lead-name">
            <VisibleText text={lead.name} />
          </span>
        </div>
        <span className="team-trunk" aria-hidden="true">
          <Pipe />
        </span>
        <ul className="team-members">
          {team.members.map((member, index) => (
            <MemberRow key={member.itemId} member={member} page={page} index={index} />
          ))}
        </ul>
        <span className="team-trunk is-out" data-out={out} aria-hidden="true">
          <Pipe />
          <Icon icon={ArrowRight} size={12} className="team-arrow" />
        </span>
        <End team={team} page={page} />
      </div>
    </section>
  )
}
