import { memo, useState } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import type { Message, Subagent } from '@latch/protocol'
import { MessageContent } from '../MessageContent.tsx'
import { ToolCard } from './ToolCard.tsx'
import { VisibleText } from './VisibleText.tsx'
import { Collapse, ICON_STROKE, StatusWord, type StatusTone } from '@latch/ui'

/** How a subagent last said it was doing, in the words a row uses. Nothing said, nothing shown. */
const SUBAGENT_STATUS: Record<NonNullable<Subagent['status']>, { tone: StatusTone; words: string }> = {
  running: { tone: 'running', words: '运行中' },
  waiting: { tone: 'waiting', words: '等你批准' },
  done: { tone: 'done', words: '已完成' },
  failed: { tone: 'failed', words: '失败' },
  cancelled: { tone: 'neutral', words: '已停止' },
  unknown: { tone: 'neutral', words: '状态未知' },
}

/**
 * A subagent the harness started for this turn: one row with its name and what it last said of itself, opening to what
 * it said and did, read only. Its requests for approval are in the approval drawer, under its name.
 */
export const SubagentRow = memo(function SubagentRow({ message, frozen }: { message: Message; frozen: boolean }) {
  const [open, setOpen] = useState(false)
  const agent = message.subagent!
  const status = agent.status ? SUBAGENT_STATUS[agent.status] : undefined
  return (
    <div className="subagent-row" data-message-id={message.id} data-open={open ? '' : undefined}>
      <button
        type="button"
        className="process-row"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <span className="process-slot" aria-hidden="true">
          <Bot size={16} strokeWidth={ICON_STROKE[16]} />
        </span>
        <span className="process-label">
          <span className="process-verb">子 Agent</span>
          <span className="process-object">
            <VisibleText text={agent.title} />
          </span>
        </span>
        {status && (
          <StatusWord tone={frozen && status.tone === 'running' ? 'neutral' : status.tone} className="subagent-status">
            {status.words}
          </StatusWord>
        )}
        <ChevronRight className="process-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
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
              <ToolCard key={step.id} message={step} frozen={frozen} />
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
