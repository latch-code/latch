import type { Approval, Message, Subagent, TeamMember, TeamSummary } from '@latch/protocol'
import { teamsOf } from '../teams/model.ts'

export interface ObservedAgent {
  kind: 'subagent'
  id: string
  agent: Subagent
  parent?: string | undefined
  request?: Message | undefined
  approval?: Approval | undefined
}

export type OverviewAgent = ({ kind: 'session'; member: TeamMember; id: string } | ObservedAgent) & { at: string }

export const agentState = (row: OverviewAgent) =>
  row.kind === 'session' ? row.member.state : row.agent.stopping ? 'stopping' : row.approval ? 'waiting' : row.agent.status

const priority = (row: OverviewAgent) => {
  const status = agentState(row)
  if (status === 'waiting') return 0
  if (status === 'running' || status === 'starting') return 1
  return 2
}
const inReadingOrder = (a: OverviewAgent, b: OverviewAgent) => priority(a) - priority(b) || b.at.localeCompare(a.at)

/** A native delegation proves parentage. Only the originating user message proves it came from the team entry. */
export function overviewAgents(
  sessionId: string,
  teams: readonly TeamSummary[] | undefined,
  messages: readonly Message[],
  approvals: readonly Approval[],
) {
  const members: OverviewAgent[] = teamsOf(teams, sessionId).flatMap(team =>
    team.members.map(member => ({ kind: 'session' as const, member, id: member.itemId, at: team.createdAt })),
  )
  const children: OverviewAgent[] = []
  const requests = new Map(messages.filter(message => message.role === 'user').map(message => [message.id, message]))
  const pending = new Map<string, Approval>()
  for (const approval of approvals) {
    if (approval.subagentId && !pending.has(approval.subagentId)) pending.set(approval.subagentId, approval)
  }
  function visit(rows: readonly Message[], parent?: string) {
    for (const message of rows) {
      const agent = message.subagent
      if (!agent) continue
      const request = agent.team?.userMessageId ? requests.get(agent.team.userMessageId) : undefined
      const group = parent === undefined && request?.teamRequest ? members : children
      group.push({
        kind: 'subagent',
        id: message.id,
        at: message.createdAt ?? '',
        agent,
        parent,
        request,
        approval: pending.get(message.id),
      })
      visit(agent.steps, agent.title)
    }
  }
  visit(messages)
  return { members: members.toSorted(inReadingOrder), children: children.toSorted(inReadingOrder) }
}
