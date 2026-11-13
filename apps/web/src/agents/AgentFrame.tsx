import type { ReactNode } from 'react'

import type { AgentAvatar as AgentAvatarValue, TaskSummary } from '@latch/protocol'
import { Button, ICON_STROKE, ChevronDownGlyph, PlusGlyph } from '@latch/ui'
import { Menu, type MenuSection } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { relativeTime } from '../format.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import type { AvatarState } from './avatarFace.ts'
import { topicWords } from './chat.ts'

const SHOWN_ARCHIVED = 12

/** One topic in the menu: its title, then when and what it is doing. */
const topicItem = (task: TaskSummary, current: string | null, frozen: boolean, onTopic: (id: string) => void) => {
  const words = topicWords(task, frozen)
  return {
    id: task.id,
    label: task.title || '未命名会话',
    description: [relativeTime(task.updatedAt), words].filter(Boolean).join(' · '),
    checked: task.id === current,
    onSelect: () => {
      onTopic(task.id)
    },
  }
}

/**
 * 话题 ▾: 新话题 first, then the Agent's topics newest first with their time and state, the current one checked, and the
 * archived ones last under 已归档.
 */
export function TopicMenu({
  topics,
  current,
  frozen,
  onTopic,
  onNewTopic,
  canStart,
  compact = false,
}: {
  topics: { open: TaskSummary[]; archived: TaskSummary[] }
  /** The open topic, or null on a new one. */
  current: string | null
  frozen: boolean
  onTopic: (id: string) => void
  onNewTopic: () => void
  /** Why a new topic cannot start here, or undefined when it can. */
  canStart: string | undefined
  compact?: boolean
}) {
  const sections: MenuSection[] = [
    {
      id: 'new',
      items: [
        {
          id: 'new-topic',
          label: '新话题',
          leading: <PlusGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />,
          ...(current === null ? { checked: true } : {}),
          ...(canStart ? { disabled: true, disabledReason: canStart } : {}),
          onSelect: onNewTopic,
        },
      ],
    },
    ...(topics.open.length ? [{ id: 'open', items: topics.open.map(task => topicItem(task, current, frozen, onTopic)) }] : []),
    ...(topics.archived.length
      ? [
          {
            id: 'archived',
            label: '已归档',
            items: topics.archived.slice(0, SHOWN_ARCHIVED).map(task => topicItem(task, current, frozen, onTopic)),
          },
        ]
      : []),
  ]
  return (
    <Menu
      label="话题"
      placement="bottom-end"
      selection
      sections={sections}
      className="agent-topic-menu"
      trigger={props => (
        <Button {...props} variant="ghost" size={compact ? 'sm' : 'md'} className="agent-topic-trigger" aria-label="话题" tooltip="话题">
          <span>话题</span>
          <ChevronDownGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        </Button>
      )}
    />
  )
}

/**
 * The conversation's frame: the Agent's face, name and state word on the left, which open its profile; on the right 话题 ▾
 * and what the place adds (the panel's toggles, ⋯). The same on a topic and on a new one.
 */
export function AgentFrame({
  name,
  avatar,
  state,
  word,
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
      {!phone && word}
      <span className="agent-frame-actions">{actions}</span>
    </div>
  )
}
