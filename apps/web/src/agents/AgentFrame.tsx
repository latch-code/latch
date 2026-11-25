import type { ReactNode } from 'react'

import type { AgentAvatar as AgentAvatarValue } from '@latch/protocol'
import { ChevronRightGlyph, Icon, Tooltip } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import type { AvatarState } from './avatarFace.ts'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'

/** The same profile entry and status in an existing or new conversation. */
export function AgentFrame({
  name,
  avatar,
  state,
  word,
  note = null,
  unavailable,
  topic,
  profileOpen,
  onProfile,
  actions,
  phone = false,
  duty,
}: {
  duty?: string
  name: string
  avatar: AgentAvatarValue | 'general'
  state: AvatarState
  /** The state word, or what the place says instead (不在线). */
  word: ReactNode
  /** What stays said whatever the state: 不先问你 or 权限没确认, amber. */
  note?: ReactNode
  unavailable?: ReactNode
  /** The open topic's title, under the name on a phone. */
  topic?: string | undefined
  profileOpen: boolean
  onProfile?: (() => void) | undefined
  actions: ReactNode
  phone?: boolean
}) {
  const identity = (
    <>
      <AgentAvatar avatar={avatar} size={phone ? 28 : 40} state={state} />
      <span className="agent-frame-text">
        <span className="agent-frame-name">
          <VisibleText text={name} />
        </span>
        {!phone && duty && (
          <span className="agent-frame-duty">
            <VisibleText text={duty} />
          </span>
        )}
        {phone && (word ? <span className="agent-frame-state">{word}</span> : topic && <span className="agent-frame-topic">{topic}</span>)}
      </span>
    </>
  )
  return (
    <div className="agent-frame" data-phone={phone ? '' : undefined}>
      {onProfile ? (
        <Tooltip content={profileOpen ? AGENT_SPACE_COPY.closeProfile : AGENT_SPACE_COPY.profileHint} side="bottom">
          <button
            type="button"
            className="agent-frame-who"
            aria-label={AGENT_SPACE_COPY.profileOf(name)}
            aria-expanded={profileOpen}
            onClick={onProfile}>
            {identity}
            <Icon className="agent-frame-profile-action" icon={ChevronRightGlyph} size={14} />
          </button>
        </Tooltip>
      ) : (
        <span className="agent-frame-who">{identity}</span>
      )}
      {!phone && note}
      {phone && (note || unavailable) && (
        <span className="agent-frame-notices" data-unavailable={unavailable ? '' : undefined}>
          {note}
          {unavailable}
        </span>
      )}
      <span className="agent-frame-actions">
        {!phone && (word ?? unavailable)}
        {actions}
      </span>
    </div>
  )
}
