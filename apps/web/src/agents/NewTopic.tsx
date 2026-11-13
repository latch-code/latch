import { useEffect, useRef, useState } from 'react'

import { GENERAL_AGENT_ID, type CustomAgentSummary, type HarnessInfo, type HostCatalog, type WorktreeStart } from '@latch/protocol'
import { Badge, ICON_STROKE, IconButton, FolderGlyph, HistoryGlyph, PlusGlyph, CloseGlyph } from '@latch/ui'
import { Composer } from '../composer/Composer.tsx'
import { FolderControl } from '../composer/FolderControl.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { worktreeProject, type ComposerChoice } from '../composerChoice.ts'
import { useMounted } from '../hooks/useMounted.ts'
import { useAttachments } from '../hooks/useAttachments.ts'
import { projectFolders, projectName } from '../projects.tsx'
import { CODE_ROOT_COPY } from '../core/securityCopy.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { generalSubmission, newTopicShowing } from './chat.ts'
import { agentHarnesses, agentSessions, delegationChoice, delegationSubmission, generalChoice } from './model.ts'
import { CarryResults } from './CarryResults.tsx'
import { carriedText } from './scheduleModel.ts'

/**
 * A helper's ＋: 带入上次成果 from its earlier topics, and 在项目里做 for this one topic (a helper of yours only; 通用 has
 * no project). The Harness, the model, thinking and permission are not here: they are the helper's, in its 设置.
 */
function topicSections({
  catalog,
  harness,
  general,
  workspaceId,
  canCarry,
  onCarry,
  onProject,
}: {
  catalog: HostCatalog
  harness: HarnessInfo | undefined
  general: boolean
  workspaceId: string | undefined
  canCarry: boolean
  onCarry: () => void
  onProject: (id: string) => void
}) {
  const projects = catalog.workspaces.filter(workspace => workspace.id !== 'default')
  const sections: MenuSection[] = [
    {
      id: 'carry',
      items: [
        {
          id: 'carry',
          label: '带入上次成果…',
          leading: <HistoryGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />,
          ...(canCarry ? {} : { disabled: true, disabledReason: '还没有之前的话题' }),
          onSelect: onCarry,
        },
      ],
    },
    ...(!general && projects.length
      ? [
          {
            id: 'project',
            label: '在项目里做',
            items: [
              {
                id: 'default',
                label: '不在项目里',
                checked: (workspaceId ?? 'default') === 'default',
                onSelect: () => onProject('default'),
              },
              ...projects.map(project => {
                // The same guards as the project picker: the Host's reason, the Harness's folder limit, Latch's own folder.
                const folders = projectFolders(project).length
                const limit = harness?.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
                const blocked =
                  project.unavailable
                  ?? (limit !== undefined && folders > limit ? `最多用 ${limit} 个文件夹，这个项目有 ${folders} 个` : undefined)
                return {
                  id: project.id,
                  label: projectName(project),
                  checked: project.id === workspaceId,
                  ...(project.codeRoot ? { tag: <Badge tone="warn">{CODE_ROOT_COPY.badge}</Badge> } : {}),
                  ...(blocked ? { disabled: true, disabledReason: blocked } : {}),
                  onSelect: () => onProject(project.id),
                }
              }),
            ],
          },
        ]
      : []),
  ]
  return sections
}

function TopicPlus({ sections, disabled }: { sections: MenuSection[]; disabled: boolean }) {
  return (
    <Menu
      label="更多"
      placement="top-start"
      sections={sections}
      className="agent-topic-plus"
      trigger={props => <IconButton {...props} icon={PlusGlyph} label="更多" disabled={disabled} className="attachment-button" />}
    />
  )
}

/**
 * A new topic's input: the next message starts a new session of the helper, on its own Harness, model and project; this
 * topic alone may work in another project, and 带入上次成果 quotes earlier topics. With 通用 it is a conversation without a
 * project. The request this device sent and has no answer for is kept apart from any session's draft and retried with
 * its own requestId; once the Host answers, the new topic opens.
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
  const [choice, setChoice] = useState<ComposerChoice>(() => (agent ? delegationChoice(agent) : generalChoice(catalog ?? undefined)))
  // The start point picked in 新工作树 (HEAD or another one), sent as picked.
  const [worktree, setWorktree] = useState<WorktreeStart | undefined>(undefined)
  const [carrying, setCarrying] = useState(false)
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
  // The helper's own Harness (通用's is the Host's default that can take it), never one picked here.
  const harness = agentHarnesses(catalog ?? undefined).find(item => item.id === (agent ? agent.harnessId : choice.harnessId))
  const pending = delegation.pending
  const mine = pending?.customAgentId === owner
  const refused = delegation.refused?.customAgentId === owner ? delegation.refused : null
  const locked = delegation.sending || pending !== null
  const attachable = catalog?.features?.attachments === true && access.scopes.has('run')
  const attachments = useAttachments({
    enabled: attachable,
    selection: {
      harnessId: harness?.id ?? '',
      workspaceId: choice.workspaceId ?? 'default',
      mode: choice.mode,
      ...(harness?.capabilities.models.owner === 'latch' && choice.model ? { model: choice.model } : {}),
    },
    revision: JSON.stringify([harness?.status, harness?.attachmentsReported ?? null]),
    locked,
  })
  useEffect(() => {
    if (refused?.code === 'attachment-released' && attachments.items.some(item => item.ref && item.status !== 'refused'))
      attachments.markReleased('已在 设置 › 设备 里释放，请移除后重新添加。')
  }, [refused, attachments.items, attachments.markReleased])
  if (!catalog) return null
  const project = general ? undefined : worktreeProject(catalog, choice, false)
  const place = general ? undefined : catalog.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')
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
          ? general
            ? '先在这台 Mac 的 设置 › Harness 里准备一个'
            : '现在不能开始'
          : undefined
  const opened = (sessionId: string | undefined) => {
    if (!sessionId || !mounted.current) return
    attachments.clear()
    setDraft('')
    setWorktree(undefined)
    if (newTopicShowing(route.current, owner)) shell.choose(sessionId)
  }
  const send = async () => {
    if (!harness || !canStart || locked || attachments.preparing) return
    const prompt = draft.trim()
    const submission = agent
      ? delegationSubmission({ agent, harness, choice, prompt, worktree, inProject: project !== undefined })
      : generalSubmission({ harness, model: choice.model, prompt })
    const ids = await attachments.wait()
    if (!ids || !mounted.current) return
    opened(await delegation.start({ ...submission, ...(ids.length ? { attachmentIds: ids } : {}) }))
  }
  const draftLocked = locked || attachments.preparing
  const chooseProject = (workspaceId: string) => {
    setChoice(previous => ({ ...previous, workspaceId }))
    setWorktree(undefined)
  }
  const menu = topicSections({
    catalog,
    harness,
    general,
    workspaceId: choice.workspaceId,
    canCarry: sessions.length > 0,
    onCarry: () => setCarrying(true),
    onProject: chooseProject,
  })
  return (
    <div className="agent-delegate">
      <Composer
        showSlashButton={false}
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
                if (back) {
                  if (pending?.attachmentIds?.length) {
                    attachments.clear()
                    attachments.explain('附件需要重新添加。')
                  }
                  setDraft(previous => (previous.trim() ? previous : back.text))
                }
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
        attachments={attachable ? attachments : undefined}
        attachmentMenu={menu}
        controls={attachable ? undefined : <TopicPlus sections={menu} disabled={draftLocked || offline} />}
        below={
          place ? (
            <div className="agent-delegate-where">
              <span className="agent-delegate-place">
                <FolderGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <span>
                  在 <VisibleText text={projectName(place)} /> 做
                </span>
                {place.id !== agent?.defaultProjectId && (
                  <IconButton
                    icon={CloseGlyph}
                    size="xs"
                    label="不在这个项目里做"
                    disabled={draftLocked || offline}
                    onClick={() => {
                      chooseProject(agent?.defaultProjectId ?? 'default')
                    }}
                  />
                )}
              </span>
              {project && (
                <FolderControl project={project} worktree={worktree} onWorktree={setWorktree} disabled={draftLocked || offline} />
              )}
            </div>
          ) : undefined
        }
      />
      {sessions.length > 0 && (
        <CarryResults
          sessions={sessions}
          disabled={draftLocked}
          phone={shell.phone}
          asked={carrying}
          onClosed={() => {
            setCarrying(false)
          }}
          onCarry={results => {
            setDraft(previous => carriedText(previous, results))
            requestAnimationFrame(() => {
              input.current?.focus({ preventScroll: true })
            })
          }}
        />
      )}
    </div>
  )
}
