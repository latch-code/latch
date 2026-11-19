import type { HarnessInfo, TaskSummary, TeamSummary } from '@latch/protocol'
import { HarnessTile, MarkTile } from '../components/BrandTile.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useLocale } from '../core/i18n.ts'
import { TEAM_COPY } from './copy.ts'
import { memberPlace } from './model.ts'

/**
 * Over a member's conversation: whose team it is in (that session's Harness mark and title, a way back to it) and its
 * place among the members. Nothing where this reader was not given the team.
 */
export function MemberLine({
  summary,
  teams,
  tasks,
  harnesses,
  untitled,
  onOpen,
}: {
  summary: Pick<TaskSummary, 'id' | 'teamOf'>
  teams: readonly TeamSummary[] | undefined
  tasks: readonly TaskSummary[]
  harnesses: readonly HarnessInfo[] | undefined
  untitled: string
  onOpen: (sessionId: string) => void
}) {
  useLocale()
  const team = summary.teamOf && teams?.find(item => item.id === summary.teamOf!.teamId)
  const lead = team && tasks.find(task => task.id === team.leadSessionId)
  const place = team && memberPlace(team, summary.id)
  if (!team || !lead || !place) return null
  const harness = harnesses?.find(item => item.id === lead.harnessId)
  return (
    <p className="team-member-line" role="note">
      <button type="button" className="team-member-line-lead" onClick={() => onOpen(lead.id)}>
        {harness ? <HarnessTile harness={harness} size={16} /> : <MarkTile mark={undefined} size={16} />}
        <span className="team-member-line-title">
          <VisibleText text={lead.title || untitled} />
        </span>
      </button>
      <span className="team-member-line-place">{TEAM_COPY.place(place.place, place.of)}</span>
    </p>
  )
}
