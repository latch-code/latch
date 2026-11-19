import { useContext, useEffect, useState } from 'react'
import type { Message, TaskDetail, TeamMember, TeamSummary } from '@latch/protocol'
import { Button, ChevronRightGlyph, Collapse, ICON_STROKE, Loading } from '@latch/ui'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, errorMessage } from '../core/api.ts'
import { useLocale } from '../core/i18n.ts'
import { MessageContent } from '../MessageContent.tsx'
import { TEAM_COPY } from './copy.ts'
import { MemberState, MemberTile, TeamPageContext, type TeamPage } from './TeamGraph.tsx'

/** A member's last reply, whole, read from its own session when its row is opened. */
function MemberReply({ sessionId }: { sessionId: string }) {
  const [reply, setReply] = useState<{ text: string } | { error: string }>()
  useEffect(() => {
    const controller = new AbortController()
    api<TaskDetail>(`tasks/${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then(detail => {
        if (controller.signal.aborted) return
        setReply({ text: detail.messages.findLast(message => message.role === 'assistant' && message.text.trim())?.text ?? '' })
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setReply({ error: errorMessage(cause) })
      })
    return () => controller.abort()
  }, [sessionId])
  if (!reply) return <Loading label={TEAM_COPY.reading} />
  if ('error' in reply) return <p className="team-result-note">{reply.error}</p>
  return reply.text ? <MessageContent text={reply.text} /> : <p className="team-result-note">{TEAM_COPY.noReply}</p>
}

function MemberResult({ member, page }: { member: TeamMember; page: TeamPage }) {
  const [open, setOpen] = useState(false)
  const head = (
    <>
      <MemberTile harnessId={member.harnessId} harnesses={page.harnesses} />
      <span className="team-member-title">
        <VisibleText text={member.title} />
      </span>
      <span className="team-member-said" data-refusal={member.state === 'unstarted' && member.refusal ? '' : undefined}>
        {!open
          && (member.state === 'unstarted' && member.refusal ? (
            <VisibleText text={member.refusal} />
          ) : (
            member.said && <VisibleText text={member.said} />
          ))}
      </span>
      <MemberState member={member} />
    </>
  )
  if (!member.sessionId)
    return (
      <li className="team-result">
        <div className="team-result-head">
          <span className="team-result-chevron" />
          {head}
        </div>
      </li>
    )
  return (
    <li className="team-result" data-open={open ? '' : undefined}>
      <button type="button" className="team-result-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRightGlyph className="team-result-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {head}
      </button>
      <Collapse open={open} lazy>
        <div className="team-result-body">
          {open && <MemberReply sessionId={member.sessionId} />}
          <Button size="xs" variant="ghost" onClick={() => page.openSession(member.sessionId!)}>
            {TEAM_COPY.openSession}
          </Button>
        </div>
      </Collapse>
    </li>
  )
}

/**
 * The message with which the Host handed a team's results to this session's agent, in place of a bubble of the
 * person's: one row per member from the team's record, each opening to that member's whole reply, and the message as
 * it was sent behind 「发给 Agent 的原文」. Without the team's record only the message is there.
 */
export function TeamResults({ message, team }: { message: Message; team?: TeamSummary | undefined }) {
  useLocale()
  const page = useContext(TeamPageContext)
  const [source, setSource] = useState(false)
  return (
    <div className="team-results" data-message-id={message.id} data-team-return={team?.id ?? ''}>
      <p className="team-results-title">
        <AgentsGlyph size={14} />
        {TEAM_COPY.results}
      </p>
      {team && page && (
        <ul className="team-results-list">
          {team.members.map(member => (
            <MemberResult key={member.itemId} member={member} page={page} />
          ))}
        </ul>
      )}
      <div className="team-result team-results-source" data-open={source ? '' : undefined}>
        <button type="button" className="team-result-head" aria-expanded={source} onClick={() => setSource(!source)}>
          <ChevronRightGlyph className="team-result-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          <span className="team-results-source-label">{TEAM_COPY.source}</span>
        </button>
        <Collapse open={source} lazy onReveal={() => setSource(true)}>
          <div className="team-result-body team-results-text">
            <VisibleText text={message.text} />
          </div>
        </Collapse>
      </div>
    </div>
  )
}
