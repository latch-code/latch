import type { ReactNode } from 'react'

import { GENERAL_AGENT_ID } from '@latch/protocol'
import { useLastConfirmed } from '../components/SessionStatus.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentFrame, TopicMenu } from './AgentFrame.tsx'
import { agentTopics } from './chat.ts'
import { askDelegateFocus } from './delegateFocus.ts'
import { ACTIVITY_WORDS, agentActivity, sessionAgent } from './model.ts'
import { ActivityWord } from './parts.tsx'

/**
 * The frame of a conversation with `owner` as the shell draws it, on a topic (`current`) or on a new one (null): the face
 * and name open the profile, 话题 ▾ moves between topics or starts a new one. `actions` follow 话题 (a phone's panel and ⋯).
 */
export function TopicFrame({
  shell,
  owner,
  current,
  title,
  actions,
}: {
  shell: ShellState
  owner: string
  current: string | null
  /** The open topic's title. */
  title?: string | undefined
  actions?: ReactNode
}) {
  const { snapshot, connection, phone, access } = shell
  const frozen = useLastConfirmed(connection, snapshot)
  const general = owner === GENERAL_AGENT_ID
  const found = general ? undefined : snapshot.customAgents?.find(agent => agent.id === owner)
  const named = sessionAgent(snapshot, general ? { generalChat: true } : { agent: { customAgentId: owner } })
  const name = named?.name ?? 'Agent'
  const state = agentActivity(snapshot, found ?? { id: owner, available: true })
  const offline = connection === 'offline'
  const gone = !general && snapshot.customAgents !== undefined && !found
  const canStart = offline
    ? 'Mac 不在线'
    : !access.scopes.has('run')
      ? '这台设备不能开始会话'
      : gone
        ? '这个 Agent 已删除'
        : found && !found.available
          ? (found.unavailableReason ?? '现在不能开始')
          : undefined
  return (
    <AgentFrame
      name={name}
      avatar={found?.avatar ?? 'general'}
      state={frozen !== null && (state === 'running' || state === 'waiting') ? 'idle' : state}
      word={frozen === null && ACTIVITY_WORDS[state] ? <ActivityWord state={state} /> : null}
      topic={title}
      phone={phone}
      profileOpen={shell.profileShown !== null}
      onProfile={() => {
        shell.toggleProfile(owner)
      }}
      actions={
        <>
          <TopicMenu
            topics={agentTopics(snapshot.tasks, owner)}
            current={current}
            frozen={frozen !== null}
            canStart={canStart}
            compact={phone}
            onTopic={id => {
              if (id !== shell.selectedId) shell.choose(id)
              shell.setRoute({ entry: 'sessions' })
            }}
            onNewTopic={() => {
              askDelegateFocus()
              shell.openMyAgent({ id: owner, topic: 'new' })
            }}
          />
          {actions}
        </>
      }
    />
  )
}
