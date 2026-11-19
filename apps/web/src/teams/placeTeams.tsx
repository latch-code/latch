import type { ReactNode } from 'react'
import type { HarnessInfo, TaskDetail, TeamSummary } from '@latch/protocol'
import { TeamGraph } from './TeamGraph.tsx'
import { teamTurnKey } from './model.ts'

/**
 * A session's teams in its conversation: each card after the turn its split came from, or after the last turn when
 * that message is not in the record. Undefined while the session has none.
 */
export function placeTeams(
  teams: readonly TeamSummary[],
  detail: TaskDetail,
  lead: { name: string; harness?: HarnessInfo | undefined },
): ((turns: ReadonlyArray<{ key: string }>) => ReadonlyMap<string, ReactNode>) | undefined {
  if (!teams.length) return undefined
  return turns => {
    const keys = new Set(turns.map(turn => turn.key))
    const last = turns.at(-1)?.key ?? ''
    const placed = new Map<string, TeamSummary[]>()
    for (const team of teams) {
      const at = teamTurnKey(team, detail.messages)
      const key = at !== undefined && keys.has(at) ? at : last
      placed.set(key, [...(placed.get(key) ?? []), team])
    }
    return new Map(
      [...placed].map(([key, rows]) => [
        key,
        <div key={`teams:${key}`} className="team-cards">
          {rows.map(team => (
            <TeamGraph key={team.id} team={team} lead={lead} />
          ))}
        </div>,
      ]),
    )
  }
}
