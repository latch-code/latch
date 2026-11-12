import { useEffect, useRef, useState } from 'react'

import { GENERAL_AGENT_ID, type CustomAgentSummary, type HostCatalog, type WorktreeStart } from '@latch/protocol'
import { Composer } from '../composer/Composer.tsx'
import { DraftHarnessControl } from '../composer/ModelControl.tsx'
import { FolderControl } from '../composer/FolderControl.tsx'
import { ModelPicker, ProjectPicker } from '../components/Pickers.tsx'
import { worktreeProject, type ComposerChoice } from '../composerChoice.ts'
import { useMounted } from '../hooks/useMounted.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { generalSubmission, newTopicShowing } from './chat.ts'
import { agentHarnesses, agentSessions, delegationChoice, delegationSubmission, usesHostModels } from './model.ts'
import { CarryResults } from './CarryResults.tsx'
import { carriedText } from './scheduleModel.ts'

/** 通用's first picks: the Host's default Harness where it can take 通用, else the first that can; no project. */
function generalChoice(catalog: HostCatalog | undefined): ComposerChoice {
  const harnesses = agentHarnesses(catalog)
  const harness = harnesses.find(item => item.id === catalog?.defaults.harnessId) ?? harnesses[0]
  return {
    mode: 'chat',
    workspaceId: 'default',
    ...(harness ? { harnessId: harness.id } : {}),
    ...(catalog?.defaults.model ? { model: catalog.defaults.model } : {}),
  }
}

/**
 * A new topic's input: the next message starts a new session of the Agent, on its own Harness, model and project, each
 * changeable for this session (Harnesses that can receive an Agent only), with 带入上次成果 from its earlier topics. With
 * 通用 it is a conversation without a project. The request this device sent and has no answer for is kept apart from any
 * session's draft and retried with its own requestId; once the Host answers, the new topic opens.
 */
export function NewTopic({
  shell,
  owner,
  agent,
  name,
  offline,
}: {
  shell: ShellState
  owner: string
  /** Absent for 通用. */
  agent: CustomAgentSummary | undefined
  name: string
  offline: boolean
}) {
  const { snapshot, delegation, access, preferences, coarse, catalog } = shell
  const general = owner === GENERAL_AGENT_ID
  const [draft, setDraft] = useState('')
  const [choice, setChoice] = useState<ComposerChoice>(() => (agent ? delegationChoice(agent) : generalChoice(catalog)))
  // The start point picked in 新工作树 (HEAD or another one), sent as picked.
  const [worktree, setWorktree] = useState<WorktreeStart | undefined>(undefined)
  const input = useRef<HTMLTextAreaElement>(null)
  // Where the person is when the Host answers, not when they sent.
  const route = useRef(shell.route)
  const mounted = useMounted()
  useEffect(() => {
    route.current = shell.route
  })
  // A new definition from the Host starts the picks again from its defaults.
  useEffect(() => {
    if (agent) setChoice(delegationChoice(agent))
  }, [agent?.id, agent?.revision])
  if (!catalog) return null
  // Only Harnesses that can receive an Agent, and no pin from this page: the pin is the new session's.
  const agentCatalog: HostCatalog = {
    ...catalog,
    harnesses: agentHarnesses(catalog),
    ...(catalog.features ? { features: { ...catalog.features, pinnedDefaults: undefined } } : {}),
  }
  const harness = agentCatalog.harnesses.find(item => item.id === choice.harnessId)
  const pending = delegation.pending
  const mine = pending?.customAgentId === owner
  const refused = delegation.refused?.customAgentId === owner ? delegation.refused : null
  const project = general ? undefined : worktreeProject(catalog, choice, false)
  const sessions = agentSessions(snapshot.tasks, owner)
  const available = agent ? agent.available : true
  const canStart = !offline && available && harness !== undefined && access.scopes.has('run')
  const blockReason = offline
    ? 'Mac 不在线，恢复后再发'
    : !access.scopes.has('run')
      ? '这台设备不能开始会话'
      : !available
        ? (agent?.unavailableReason ?? '现在不能开始')
        : !harness
          ? '先选 Harness'
          : undefined
  const opened = (sessionId: string | undefined) => {
    if (!sessionId || !mounted.current) return
    setDraft('')
    setWorktree(undefined)
    if (newTopicShowing(route.current, owner)) shell.choose(sessionId)
  }
  const send = async () => {
    if (!harness || !canStart) return
    const prompt = draft.trim()
    const submission = agent
      ? delegationSubmission({ agent, harness, choice, prompt, worktree, inProject: project !== undefined })
      : generalSubmission({ harness, model: choice.model, prompt })
    opened(await delegation.start(submission))
  }
  const locked = delegation.sending || pending !== null
  return (
    <div className="agent-delegate">
      <Composer
        textareaRef={input}
        variant="new"
        label={`给${name}发消息`}
        placeholder={`给${name}发消息…`}
        draft={draft}
        onDraft={setDraft}
        pending={pending}
        {...(pending && !mine && pending.customAgentId
          ? {
              onOpenPending: () => {
                shell.openMyAgent({ id: pending.customAgentId!, topic: 'new' })
              },
            }
          : {})}
        sending={delegation.sending}
        error={refused ? `没有开始：${refused.message}` : ''}
        {...(mine && delegation.reason ? { pendingReason: delegation.reason } : {})}
        onRetry={() => {
          void delegation.retry().then(opened)
        }}
        {...(mine
          ? {
              onAbandon: () => {
                const back = delegation.abandon()
                if (back) setDraft(previous => (previous.trim() ? previous : back.text))
              },
            }
          : {})}
        canSend={canStart}
        {...(blockReason ? { blockReason } : {})}
        onSubmit={() => {
          void send()
        }}
        sendKey={preferences.sendKey}
        coarse={coarse}
        controls={
          <>
            <DraftHarnessControl
              catalog={agentCatalog}
              choice={choice}
              access={access}
              disabled={locked || offline}
              onChoice={patch => {
                setChoice(previous => ({ ...previous, ...patch }))
              }}
              onRead={shell.refresh}
            />
            {usesHostModels(harness) && (
              <ModelPicker
                catalog={catalog}
                value={choice.model}
                access={access}
                disabled={locked || offline}
                onChange={model => {
                  setChoice(previous => ({ ...previous, model: { providerId: model.providerId, model: model.model } }))
                }}
              />
            )}
          </>
        }
        below={
          <div className="agent-delegate-where">
            {!general && (
              <ProjectPicker
                catalog={catalog}
                harness={harness}
                access={access}
                value={choice.workspaceId}
                disabled={locked || offline}
                onChange={workspaceId => {
                  setChoice(previous => ({ ...previous, workspaceId }))
                  setWorktree(undefined)
                }}
              />
            )}
            {project && <FolderControl project={project} worktree={worktree} onWorktree={setWorktree} disabled={locked || offline} />}
            <span className="agent-form-spacer" />
            {sessions.length > 0 && (
              <CarryResults
                sessions={sessions}
                disabled={locked}
                phone={shell.phone}
                onCarry={results => {
                  setDraft(previous => carriedText(previous, results))
                  requestAnimationFrame(() => {
                    input.current?.focus({ preventScroll: true })
                  })
                }}
              />
            )}
          </div>
        }
      />
    </div>
  )
}
