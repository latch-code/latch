import { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'

import { GENERAL_AGENT_ID } from '@latch/protocol'
import { Button, EmptyState, IconButton, ChevronLeftGlyph } from '@latch/ui'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { AgentProfile } from './AgentProfile.tsx'
import { agentTopics } from './chat.ts'
import { takeDelegateFocus } from './delegateFocus.ts'
import { NewTopic } from './NewTopic.tsx'
import { dutyLine, GENERAL_NAME, readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { TopicFrame } from './TopicFrame.tsx'
import { ResultStack } from './TopicResults.tsx'
import { useWaitingResults } from './useAgentData.ts'
import { useAgentWrites } from './useAgentWrites.ts'

/**
 * A conversation with an Agent on a new topic: its frame on top (the face and name open the profile, 话题 ▾ goes back to
 * an earlier topic), who it is in the middle while nothing is said yet, and the input at the bottom, whose first message
 * starts the topic. On wide windows the profile stands beside it; on phones it is a sheet the shell draws.
 */
export function AgentChat({ shell, owner, onBack }: { shell: ShellState; owner: string; onBack: () => void }) {
  const { snapshot, phone, titleSlot, connection } = shell
  const offline = connection === 'offline'
  const general = owner === GENERAL_AGENT_ID
  const agent = general ? undefined : snapshot.customAgents?.find(item => item.id === owner)
  const confirming = !general && snapshot.customAgents === undefined
  const missing = !general && !confirming && agent === undefined
  const name = general ? GENERAL_NAME : (agent?.name ?? '')
  const duty = general ? '没选别的 Agent 的会话都带上它' : agent ? dutyLine(agent) : ''
  const earlier = agentTopics(snapshot.tasks, owner).open.length > 0
  const locked = !readsAgents(snapshot)
  // Results of its schedules while it has no topic: they stay here, and the next topic keeps them.
  const { read: waitingRead } = useWaitingResults(snapshot, locked ? null : owner)
  const waiting = 'value' in waitingRead && waitingRead.value ? waitingRead.value.results : []
  const refreshShell = shell.refresh
  const writes = useAgentWrites(useCallback(() => void refreshShell(), [refreshShell]))
  // 新对话… or 新话题 asked for the input: it takes the keys once it is drawn.
  useEffect(() => {
    requestAnimationFrame(() => {
      takeDelegateFocus()
    })
  })
  const frame = !locked && !missing && <TopicFrame shell={shell} owner={owner} current={null} title="新话题" />
  return (
    <div className="agent-chat" data-profile={shell.profileShown && !phone ? '' : undefined}>
      {!phone && titleSlot && frame && createPortal(<div className="agent-chat-title">{frame}</div>, titleSlot)}
      <div className="agent-chat-main">
        {phone && (
          <header className="topbar topbar-frame" data-phone="">
            <IconButton size="lg" className="topbar-back" label="返回" icon={ChevronLeftGlyph} onClick={onBack} />
            {frame}
          </header>
        )}
        <div className="agent-chat-body">
          {locked ? (
            <LockedAgents />
          ) : missing ? (
            <EmptyState title="找不到这个 Agent" description="它可能已在别处删除。" action={<Button onClick={onBack}>回到列表</Button>} />
          ) : confirming ? (
            <EmptyState title="正在确认上一项修改" />
          ) : (
            <>
              <div className="agent-chat-intro">
                <AgentAvatar avatar={agent?.avatar ?? 'general'} size={56} />
                <h1>{earlier ? '新话题' : name}</h1>
                {!earlier && duty && <p>{duty}</p>}
              </div>
              {waiting.length > 0 && (
                <ResultStack shell={shell} owner={owner} results={waiting} writes={writes} className="agent-chat-results" />
              )}
            </>
          )}
        </div>
        {!locked && !missing && !confirming && (
          <div className="agent-chat-composer">
            <NewTopic key={owner} shell={shell} owner={owner} agent={agent} name={name} offline={offline} />
          </div>
        )}
      </div>
      {!phone && shell.profileShown && (
        <aside className="agent-chat-profile">
          <AgentProfile
            shell={shell}
            owner={owner}
            section={shell.profileShown.section}
            nonce={shell.profileShown.nonce}
            prefill={shell.profileShown.prefill}
            onClose={shell.closeProfile}
          />
        </aside>
      )}
    </div>
  )
}
