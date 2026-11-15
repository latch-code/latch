import { useCallback, useEffect } from 'react'

import { GENERAL_AGENT_ID } from '@latch/protocol'
import { Button, EmptyState, IconButton, ChevronLeftGlyph } from '@latch/ui'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { ProfileSlot } from './AgentProfile.tsx'
import { takeDelegateFocus } from './delegateFocus.ts'
import { NewTopic } from './NewTopic.tsx'
import { GENERAL_NAME, readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { TopicFrame } from './TopicFrame.tsx'
import { ResultStack } from './TopicResults.tsx'
import { useWaitingResults } from './useAgentData.ts'
import { useAgentWrites } from './useAgentWrites.ts'

/**
 * An Agent before its first message. The header holds its identity and opens its profile.
 */
export function AgentChat({ shell, owner, onBack }: { shell: ShellState; owner: string; onBack: () => void }) {
  const { snapshot, phone, connection } = shell
  const offline = connection === 'offline'
  const general = owner === GENERAL_AGENT_ID
  const agent = general ? undefined : snapshot.customAgents?.find(item => item.id === owner)
  const confirming = !general && snapshot.customAgents === undefined
  const missing = !general && !confirming && agent === undefined
  const name = general ? GENERAL_NAME : (agent?.name ?? '')
  const locked = !readsAgents(snapshot)
  // Results of its schedules while it has no topic: they stay here, and the next topic keeps them.
  const { read: waitingRead } = useWaitingResults(snapshot, locked ? null : owner)
  const waiting = 'value' in waitingRead && waitingRead.value ? waitingRead.value.results : []
  const refreshShell = shell.refresh
  const writes = useAgentWrites(useCallback(() => void refreshShell(), [refreshShell]))
  // The overview shortcut asked for the input: it takes the keys once it is drawn.
  useEffect(() => {
    requestAnimationFrame(() => {
      takeDelegateFocus()
    })
  })
  const frame = !locked && !missing && <TopicFrame shell={shell} owner={owner} current={null} />
  return (
    <div className="agent-chat" data-profile={shell.profileShown && !phone ? '' : undefined}>
      <div className="agent-chat-main">
        <header className="topbar topbar-frame" data-phone={phone ? '' : undefined}>
          {phone && <IconButton size="lg" className="topbar-back" label="返回" icon={ChevronLeftGlyph} onClick={onBack} />}
          {frame}
        </header>
        {(locked || missing || confirming || waiting.length > 0) && (
          <div className="agent-chat-body">
            {locked ? (
              <LockedAgents />
            ) : missing ? (
              <EmptyState title="找不到这个 Agent" description="它可能已在别处删除。" action={<Button onClick={onBack}>回到列表</Button>} />
            ) : confirming ? (
              <EmptyState title="正在确认上一项修改" />
            ) : (
              <ResultStack shell={shell} owner={owner} results={waiting} writes={writes} className="agent-chat-results" />
            )}
          </div>
        )}
        {!locked && !missing && !confirming && (
          <div className="agent-chat-composer">
            <NewTopic key={owner} shell={shell} owner={owner} agent={agent} name={name} offline={offline} />
          </div>
        )}
      </div>
      {!phone && shell.profileShown && (
        <aside className="agent-chat-profile">
          <ProfileSlot owner={owner} />
        </aside>
      )}
    </div>
  )
}
