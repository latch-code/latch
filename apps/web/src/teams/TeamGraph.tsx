import { createContext, useContext, type ReactNode } from 'react'
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

function MemberRow({ member, page }: { member: TeamMember; page: TeamPage }) {
  const ended = !memberAtWork(member.state)
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
      data-work={member.state === 'running' || member.state === 'starting' ? '' : undefined}>
      <span className="team-stub" aria-hidden="true">
        <span className="team-dot" />
      </span>
      <Tooltip content={member.state === 'unstarted' ? member.refusal : undefined}>{main}</Tooltip>
      <span className="team-stub is-out" aria-hidden="true">
        {ended && <span className="team-dot" />}
      </span>
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
 * A team in its session's conversation, as the work passing through it: this session on one side, a track that fans
 * out to one row per member, and the tracks joining at where the results are. Left to right where there is room, top
 * to bottom where there is not. Marks travel along a member's track only while that member works.
 */
export function TeamGraph({ team, lead }: { team: TeamSummary; lead: { name: string; harness?: HarnessInfo | undefined } }): ReactNode {
  useLocale()
  const page = useContext(TeamPageContext)
  if (!page) return null
  const live = teamOpen(team) && team.members.some(member => member.state === 'running' || member.state === 'starting')
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
          <span className="team-dot" />
          <span className="team-dot" />
        </span>
        <ul className="team-members">
          {team.members.map(member => (
            <MemberRow key={member.itemId} member={member} page={page} />
          ))}
        </ul>
        <span className="team-trunk is-out" aria-hidden="true">
          <Icon icon={ArrowRight} size={12} className="team-arrow" />
        </span>
        <End team={team} page={page} />
      </div>
    </section>
  )
}
