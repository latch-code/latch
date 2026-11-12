import { createContext, memo, useContext, useEffect, useState } from 'react'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import type { Message, Subagent } from '@latch/protocol'
import { APPROVAL_COPY } from '../core/securityCopy.ts'
import { MessageContent } from '../MessageContent.tsx'
import { ToolCard } from './ToolCard.tsx'
import { VisibleText } from './VisibleText.tsx'
import { Button, Collapse, ICON_STROKE, StatusWord, type StatusTone, ChevronRightGlyph } from '@latch/ui'

/** How a subagent last said it was doing, in the words a row uses. Nothing said, nothing shown. */
const SUBAGENT_STATUS: Record<NonNullable<Subagent['status']>, { tone: StatusTone; words: string }> = {
  running: { tone: 'running', words: '运行中' },
  waiting: { tone: 'waiting', words: APPROVAL_COPY.waiting },
  done: { tone: 'done', words: '已完成' },
  failed: { tone: 'failed', words: '失败' },
  cancelled: { tone: 'neutral', words: '已停止' },
  unknown: { tone: 'neutral', words: '状态未知' },
}

/** Stops one subagent by its row's ID; absent where this device cannot stop the session. Rejects with what went wrong. */
export const SubagentStop = createContext<((subagentId: string) => Promise<void>) | undefined>(undefined)

/**
 * A subagent the harness started for this turn: a row on the turn's rail, 「子 Agent」 in the verb column, its name and
 * what it last said of itself, opening to what it said and did on a rail of its own, read only. Its requests for approval are in the approval drawer, under its name. One that can be
 * stopped alone offers 停止; it reads 正在停止… until it says it stopped.
 */
export const SubagentRow = memo(function SubagentRow({ message, frozen }: { message: Message; frozen: boolean }) {
  const [open, setOpen] = useState(false)
  const [requested, setRequested] = useState(false)
  const stop = useContext(SubagentStop)
  const agent = message.subagent!
  // Asked from here and not yet shown by the Host; once the Host says it is stopping, or no longer stoppable, that is what shows.
  useEffect(() => {
    if (agent.stopping || !agent.stoppable) setRequested(false)
  }, [agent.stopping, agent.stoppable])
  const stopping = agent.stopping === true || (requested && agent.stoppable === true)
  const status = stopping ? { tone: 'neutral' as const, words: '正在停止…' } : agent.status ? SUBAGENT_STATUS[agent.status] : undefined
  const canStop = stop && agent.stoppable && !stopping && !frozen
  return (
    <div className="subagent-row" data-message-id={message.id} data-open={open ? '' : undefined}>
      <div className="subagent-head">
        <button
          type="button"
          className="process-row subagent-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
          }}>
          <span className="process-verb">子 Agent</span>
          <span className="subagent-icon" aria-hidden="true">
            <AgentsGlyph size={16} />
          </span>
          <span className="process-object subagent-name">
            <VisibleText text={agent.title} />
          </span>
          {status ? (
            <StatusWord tone={frozen && status.tone === 'running' ? 'neutral' : status.tone} className="subagent-status">
              {status.words}
            </StatusWord>
          ) : (
            <span />
          )}
          <ChevronRightGlyph className="process-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        </button>
        {/* The stop column keeps its width whether it holds 停止 or not, so every row's status lines up. */}
        <span className="subagent-stop">
          {canStop && (
            <Button
              size="xs"
              variant="outline"
              aria-label={`停止子 Agent ${agent.title}`}
              onClick={() => {
                setRequested(true)
                stop(message.id).catch(() => {
                  setRequested(false)
                })
              }}>
              停止
            </Button>
          )}
        </span>
      </div>
      <Collapse
        open={open}
        onReveal={() => {
          setOpen(true)
        }}>
        <div className="subagent-steps">
          {agent.description && (
            <p className="subagent-note">
              <VisibleText text={agent.description} />
            </p>
          )}
          {agent.steps.map(step =>
            step.subagent ? (
              <SubagentRow key={step.id} message={step} frozen={frozen} />
            ) : step.role === 'tool' ? (
              <ToolCard key={step.id} message={step} frozen={frozen} inline />
            ) : (
              <div key={step.id} className="subagent-text" data-message-id={step.id}>
                <MessageContent text={step.text} />
              </div>
            ),
          )}
          {agent.steps.length === 0 && <p className="subagent-note">还没有说做了什么</p>}
          {agent.truncated && <p className="subagent-note">之后的步骤没有保留</p>}
        </div>
      </Collapse>
    </div>
  )
})
