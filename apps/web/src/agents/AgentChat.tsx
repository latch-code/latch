import { useCallback, useEffect, useState } from 'react'

import { GENERAL_AGENT_ID } from '@latch/protocol'
import { Button, EmptyState, IconButton, ChevronLeftGlyph } from '@latch/ui'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { personalChat } from './chat.ts'
import { helperAbilities } from './helpers.ts'
import { fillDraft, openingActions } from './opening.ts'
import { ProfileSlot } from './AgentProfile.tsx'
import { takeDelegateFocus } from './delegateFocus.ts'
import { NewTopic } from './NewTopic.tsx'
import { agentHarnesses, GENERAL_NAME, readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { TopicFrame } from './TopicFrame.tsx'
import { ResultStack } from './TopicResults.tsx'
import { useWaitingResults } from './useAgentData.ts'
import { useAgentWrites } from './useAgentWrites.ts'

/**
 * The Agent speaks first: its face, turned to the person, and three things to ask that it can really do here (its name
 * and line are in the header above). Fixed, no model call; a click fills the input and sends nothing.
 */
function Opening({
  shell,
  owner,
  name,
  disabled,
  onFill,
}: {
  shell: ShellState
  owner: string
  name: string
  disabled: boolean
  onFill: (text: string) => void
}) {
  const { snapshot, catalog } = shell
  const general = owner === GENERAL_AGENT_ID
  const agent = general ? undefined : snapshot.customAgents?.find(item => item.id === owner)
  const harnessId = agent?.harnessId ?? 'standard'
  const harness = agentHarnesses(catalog ?? undefined).find(item => item.id === harnessId)
  const schedules = snapshot.automations?.filter(item => (general ? !item.customAgentId : item.customAgentId === owner)) ?? []
  const project = agent?.defaultProjectId ? catalog?.workspaces.find(item => item.id === agent.defaultProjectId)?.name : undefined
  const actions = openingActions({
    general,
    description: agent?.description,
    abilities: harness ? helperAbilities(catalog ?? undefined, harness) : [],
    mode: agent?.mode ?? 'agent',
    schedules,
    canAutomate: catalog?.features?.automations === true && (general || agent?.canAutomate === true),
    project,
  })
  return (
    <section className="agent-opening" aria-label={`${name}的开场`}>
      {/* The header right above says who it is and what it is for; here it only turns to the person. */}
      <AgentAvatar avatar={agent?.avatar ?? 'general'} size={40} />
      <div className="agent-opening-actions" role="group" aria-label="可以这样开始">
        {actions.map(action => (
          <Button
            key={action.id}
            size="sm"
            className="agent-opening-action"
            data-opening={action.id}
            disabled={disabled}
            onClick={() => {
              onFill(action.text)
            }}>
            {action.label}
          </Button>
        ))}
      </div>
    </section>
  )
}

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
  const draftState = useState('')
  const [, setDraft] = draftState
  const chat = personalChat(snapshot, owner)
  const pendingHere = shell.delegation.pending?.customAgentId === owner
  // Only while nothing has been said: a first message on its way, or another device's chat, has no opening.
  const opening = !locked && !missing && !confirming && chat?.state === 'empty' && !pendingHere
  const fill = (text: string) => {
    setDraft(previous => fillDraft(previous, text))
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.agent-chat-composer textarea')
      if (!input) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(input.value.length, input.value.length)
    })
  }
  return (
    <div className="agent-chat" data-profile={shell.profileShown && !phone ? '' : undefined}>
      <div className="agent-chat-main">
        <header className="topbar topbar-frame" data-phone={phone ? '' : undefined}>
          {phone && <IconButton size="lg" className="topbar-back" label="返回" icon={ChevronLeftGlyph} onClick={onBack} />}
          {frame}
        </header>
        {(locked || missing || confirming || waiting.length > 0 || opening) && (
          <div className="agent-chat-body">
            {opening && (
              <Opening
                shell={shell}
                owner={owner}
                name={name}
                disabled={!shell.access.scopes.has('run') || shell.delegation.sending}
                onFill={fill}
              />
            )}
            {locked ? (
              <LockedAgents />
            ) : missing ? (
              <EmptyState title="找不到这个 Agent" description="它可能已在别处删除。" action={<Button onClick={onBack}>回到列表</Button>} />
            ) : confirming ? (
              <EmptyState title="正在确认上一项修改" />
            ) : waiting.length > 0 ? (
              <ResultStack shell={shell} owner={owner} results={waiting} writes={writes} className="agent-chat-results" />
            ) : null}
          </div>
        )}
        {!locked && !missing && !confirming && (
          <div className="agent-chat-composer">
            <NewTopic key={owner} shell={shell} owner={owner} agent={agent} name={name} offline={offline} draftState={draftState} />
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
