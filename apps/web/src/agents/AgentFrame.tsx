import type { ReactNode } from 'react'

import type { AgentAvatar as AgentAvatarValue } from '@latch/protocol'
import { VisibleText } from '../components/VisibleText.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import type { AvatarState } from './avatarFace.ts'

/**
 * The conversation's frame. 侧栏 layout: a 40px face, the name and the role line on the left, which open the profile; at
 * the right the one state word, the schedule chip and what the place adds (⋯). 顶栏 layout: a presence
 * block at the top of the conversation, a 52px face over the name and role with the same chips under them. The same on a
 * topic and on a new one.
 */
export function AgentFrame({
  name,
  avatar,
  state,
  word,
  note = null,
  topic,
  profileOpen,
  onProfile,
  actions,
  phone = false,
  duty,
  layout = 'overview',
}: {
  duty?: string
  layout?: 'overview' | 'triage'
  name: string
  avatar: AgentAvatarValue | 'general'
  state: AvatarState
  /** The state word, or what the place says instead (不在线). */
  word: ReactNode
  /** What stays said whatever the state: 不先问你 or 权限没确认, amber. */
  note?: ReactNode
  /** The open topic's title, under the name on a phone. */
  topic?: string | undefined
  profileOpen: boolean
  onProfile: () => void
  actions: ReactNode
  phone?: boolean
}) {
  return (
    <div className="agent-frame" data-phone={phone ? '' : undefined} data-layout={layout}>
      <button type="button" className="agent-frame-who" aria-label={`${name} 的资料`} aria-expanded={profileOpen} onClick={onProfile}>
        <AgentAvatar avatar={avatar} size={phone ? 28 : layout === 'triage' ? 52 : 40} state={state} />
        <span className="agent-frame-text">
          <span className="agent-frame-name">
            <VisibleText text={name} />
          </span>
          {!phone && duty && (
            <span className="agent-frame-duty">
              <VisibleText text={duty} />
            </span>
          )}
          {/* A phone has room for one line under the name: the state, whole, while there is one, else the topic. */}
          {phone && word ? (
            <span className="agent-frame-state">{word}</span>
          ) : (
            phone && topic && <span className="agent-frame-topic">{topic}</span>
          )}
        </span>
      </button>
      {note}
      <span className="agent-frame-actions">
        {/* The one state word of the screen, at the right; a phone says it under the name. */}
        {!phone && word}
        {actions}
      </span>
    </div>
  )
}
