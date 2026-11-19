import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import type { HarnessInfo, TeamMember, TeamSummary } from '@latch/protocol'
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

/** A member's elbow off the spine, and the bead of work that runs round it while the member works. */
function Elbow() {
  return (
    <span className="team-elbow" aria-hidden="true">
      <span className="team-bead" />
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
      // Each bead starts at its own point in the run, so they seem to come down the spine in turn.
      style={{ '--team-row': index } as CSSProperties}>
      <Elbow />
      <Tooltip content={member.state === 'unstarted' ? member.refusal : undefined}>{main}</Tooltip>
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
  const ended = team.members.filter(member => !memberAtWork(member.state)).length
  return (
    <div className="team-end" data-end={mark} style={{ '--team-row': team.members.length } as CSSProperties}>
      <Elbow />
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
      {(mark === 'members' || mark === 'you') && <span className="team-end-count">{TEAM_COPY.ended(ended, team.members.length)}</span>}
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
 * A team in its session's conversation, as work through pipes: this session's mark, a spine under it with a rounded
 * elbow into each member, and a last elbow into where the results are. The same at every width; a narrow card puts what
 * a member said under its name. A bead of work runs round the elbow of each member at work, and of the results while
 * they wait to go back; an elbow takes its member's colour once the member has ended.
 */
export function TeamGraph({ team, lead }: { team: TeamSummary; lead: { name: string; harness?: HarnessInfo | undefined } }): ReactNode {
  useLocale()
  const page = useContext(TeamPageContext)
  if (!page) return null
  return (
    <section className="team-card" data-team={team.id} data-state={team.state} aria-label={TEAM_COPY.said(team.members.length)}>
      <header className="team-head">
        <span className="team-lead">
          {lead.harness ? <HarnessTile harness={lead.harness} size={20} /> : <MarkTile mark={undefined} size={20} />}
          <span className="team-lead-name">
            <VisibleText text={lead.name} />
          </span>
        </span>
        {team.goal && (
          <p className="team-goal">
            <VisibleText text={team.goal} />
          </p>
        )}
        <span className="team-count">{TEAM_COPY.memberCount(team.members.length)}</span>
      </header>
      <ul className="team-members">
        {team.members.map((member, index) => (
          <MemberRow key={member.itemId} member={member} page={page} index={index} />
        ))}
      </ul>
      <End team={team} page={page} />
    </section>
  )
}
