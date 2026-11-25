import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

import { GENERAL_AGENT_ID, type CustomAgentSummary, type HarnessInfo, type HostCatalog, type WorktreeStart } from '@latch/protocol'
import { Badge, Button, ICON_STROKE, IconButton, FolderGlyph, HistoryGlyph, PlusGlyph, CloseGlyph } from '@latch/ui'
import { Composer } from '../composer/Composer.tsx'
import type { PromptInput } from '../composer/PromptEditor.tsx'
import { FolderControl } from '../composer/FolderControl.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { startBlock, worktreeProject, type ComposerChoice } from '../composerChoice.ts'
import { useMounted } from '../hooks/useMounted.ts'
import { useAttachments } from '../hooks/useAttachments.ts'
import { projectFolders, projectName } from '../projects.tsx'
import { CODE_ROOT_COPY } from '../core/securityCopy.ts'
import { CONNECTION_COPY } from '../core/hostState.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { generalSubmission, newTopicShowing, personalChat } from './chat.ts'
import { agentHarnesses, agentSessions, delegationChoice, delegationSubmission, generalChoice } from './model.ts'
import { CarryResults } from './CarryResults.tsx'
import { carriedText } from './scheduleModel.ts'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'

const COPY = defineCopy(
  {
    carry: '带入上次成果…',
    noPrevious: '还没有之前的话题',
    inProject: '在项目里做',
    noProject: '不在项目里',
    folderLimit: (limit: number, count: number) => `最多用 ${formatNumber(limit)} 个文件夹，这个项目有 ${formatNumber(count)} 个`,
    more: '更多',
    released: '已在 设置 › 设备 里释放，请移除后重新添加。',
    cannotRun: '这台设备不能开始会话',
    confirming: '正在确认聊天',
    continue: '打开聊天继续',
    modelNeeded: '先在这台 Mac 的 设置 › 模型服务 接上一个',
    cannotStart: '现在不能开始',
    harnessNeeded: '先在这台 Mac 的 设置 › Harness 里准备一个',
    openWithDraft: '带上草稿打开聊天',
    open: '打开聊天',
    attachmentsBeforeOpen: '打开聊天前请先在此移除附件，再到聊天中添加。',
    message: (name: string) => `给${name}发消息`,
    placeholder: (name: string) => `给${name}发消息…`,
    refused: (message: string) => `没有开始：${message}`,
    addAttachmentsAgain: '附件需要重新添加。',
    placeLead: '在 ',
    placeTail: ' 做',
    removeProject: '不在这个项目里做',
  },
  {
    carry: 'Bring in previous results…',
    noPrevious: 'No earlier topics yet',
    inProject: 'Work in a project',
    noProject: 'No project',
    folderLimit: (limit: number, count: number) =>
      `This Harness supports up to ${plural(limit, { one: '{n} folder', other: '{n} folders' })}. This project has ${formatNumber(count)}.`,
    more: 'More',
    released: 'These attachments were released in Settings › Devices. Remove them and add them again.',
    cannotRun: 'This device can’t start sessions',
    confirming: 'Confirming chat',
    continue: 'Open the chat to continue',
    modelNeeded: 'Add a model service under Settings › Models on this Mac',
    cannotStart: 'Can’t start right now',
    harnessNeeded: 'Set up a Harness under Settings › Harness on this Mac',
    openWithDraft: 'Open chat with draft',
    open: 'Open chat',
    attachmentsBeforeOpen: 'Remove attachments here before opening the chat, then add them there.',
    message: (name: string) => `Message ${name}`,
    placeholder: (name: string) => `Message ${name}…`,
    refused: (message: string) => `Couldn’t start. ${message}`,
    addAttachmentsAgain: 'Add the attachments again.',
    placeLead: 'Working in ',
    placeTail: '',
    removeProject: 'Remove this project from the topic',
  },
)

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
          label: COPY.carry,
          leading: <HistoryGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />,
          ...(canCarry ? {} : { disabled: true, disabledReason: COPY.noPrevious }),
          onSelect: onCarry,
        },
      ],
    },
    ...(!general && projects.length
      ? [
          {
            id: 'project',
            label: COPY.inProject,
            items: [
              {
                id: 'default',
                label: COPY.noProject,
                checked: (workspaceId ?? 'default') === 'default',
                onSelect: () => onProject('default'),
              },
              ...projects.map(project => {
                // The same guards as the project picker: the Host's reason and the Harness's folder limit.
                const folders = projectFolders(project).length
                const limit = harness?.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
                const blocked =
                  project.unavailable ?? (limit !== undefined && folders > limit ? COPY.folderLimit(limit, folders) : undefined)
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
      label={COPY.more}
      placement="top-start"
      sections={sections}
      className="agent-topic-plus"
      trigger={props => <IconButton {...props} icon={PlusGlyph} label={COPY.more} disabled={disabled} className="attachment-button" />}
    />
  )
}

/**
 * The first message uses the Agent's Harness and model. A pending attempt retains its own requestId.
 */
export function NewTopic({
  shell,
  owner,
  agent,
  name,
  offline,
  draftState,
  lead,
  showing,
}: {
  /** Whether this input's place is still what is shown when the Host answers a start; an Agent's own new topic by default. */
  showing?: (route: ShellState['route']) => boolean
  shell: ShellState
  /** The words typed, where the place keeps them itself (the 总览 keeps them while its chip changes who is addressed). */
  draftState?: [string, Dispatch<SetStateAction<string>>]
  /** What stands over the input: the 总览's chip of who is addressed. */
  lead?: ReactNode
  owner: string
  /** Absent for 通用. */
  agent: CustomAgentSummary | undefined
  name: string
  offline: boolean
}) {
  const { snapshot, delegation, access, preferences, coarse, catalog } = shell
  const general = owner === GENERAL_AGENT_ID
  const ownDraft = useState('')
  const [draft, setDraft] = draftState ?? ownDraft
  const [choice, setChoice] = useState<ComposerChoice>(() => (agent ? delegationChoice(agent) : generalChoice(catalog ?? undefined)))
  // The start point picked in 新工作树 (HEAD or another one), sent as picked.
  const [worktree, setWorktree] = useState<WorktreeStart | undefined>(undefined)
  const [carrying, setCarrying] = useState(false)
  const input = useRef<PromptInput>(null)
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
  // The helper's own Harness (Standard for new 通用 topics), never one picked here.
  const harness = agentHarnesses(catalog ?? undefined).find(item => item.id === (agent ? agent.harnessId : choice.harnessId))
  const pending = delegation.pending
  const mine = pending?.customAgentId === owner
  const chat = personalChat(snapshot, owner)
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
  // Back online with this Agent's first message unconfirmed: the same request goes once, and the Host answers it from
  // the chat it recorded if it took the first.
  const wasOffline = useRef(offline)
  useEffect(() => {
    const back = wasOffline.current && !offline
    wasOffline.current = offline
    if (back && mine && !delegation.sending) void delegation.retry()
  }, [offline])
  useEffect(() => {
    if (refused?.code === 'attachment-released' && attachments.items.some(item => item.ref && item.status !== 'refused'))
      attachments.markReleased(COPY.released)
  }, [refused, attachments.items, attachments.markReleased])
  if (!catalog) return null
  const project = general ? undefined : worktreeProject(catalog, choice, false)
  const place = general ? undefined : catalog.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')
  const sessions = agentSessions(snapshot.tasks, owner)
  const generalBlock = general ? startBlock(snapshot, generalChoice(catalog)) : null
  const available = agent ? agent.available : generalBlock === null
  const canStart = chat?.state === 'empty' && !offline && available && harness !== undefined && access.scopes.has('run')
  const blockReason = offline
    ? CONNECTION_COPY.offline
    : !access.scopes.has('run')
      ? COPY.cannotRun
      : catalog.features?.singleAgentChat !== true
        ? AGENT_SPACE_COPY.updateChat
        : !chat || chat.state === 'starting'
          ? COPY.confirming
          : chat.state === 'ready'
            ? COPY.continue
            : !available
              ? (agent?.unavailableReason
                ?? (generalBlock?.kind === 'model-required' ? COPY.modelNeeded : generalBlock?.message)
                ?? COPY.cannotStart)
              : !harness
                ? general
                  ? COPY.harnessNeeded
                  : COPY.cannotStart
                : undefined
  const opened = (sessionId: string | undefined) => {
    if (!sessionId || !mounted.current) return
    attachments.clear()
    setDraft('')
    setWorktree(undefined)
    if (showing ? showing(route.current) : newTopicShowing(route.current, owner)) shell.choose(sessionId)
  }
  const send = async () => {
    if (!harness || !canStart || locked || attachments.preparing) return
    const prompt = draft.trim()
    const submission = agent
      ? delegationSubmission({ agent, harness, choice, prompt, worktree, inProject: project !== undefined })
      : generalSubmission({ model: choice.model ?? catalog.defaults.model, prompt })
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
  const ready = chat?.state === 'ready' && !mine ? chat : undefined
  const continueChat = ready ? (
    <div className="agent-continue">
      <Button
        variant="primary"
        disabled={attachments.items.length > 0}
        onClick={() => shell.choose(ready.sessionId, () => setDraft(''), draft.trim() ? { appendDraft: draft } : undefined)}>
        {draft.trim() ? COPY.openWithDraft : COPY.open}
      </Button>
      {attachments.items.length > 0 && <p>{COPY.attachmentsBeforeOpen}</p>}
    </div>
  ) : null
  return (
    <div className="agent-delegate">
      {lead}
      {continueChat}
      {(!ready || draft.trim() || attachments.items.length > 0) && (
        <Composer
          showSlashButton={false}
          agentMentions={shell.agentMentions.source === owner ? shell.agentMentions : undefined}
          textareaRef={input}
          variant="new"
          label={COPY.message(name)}
          placeholder={COPY.placeholder(name)}
          draft={draft}
          onDraft={setDraft}
          pending={pending}
          {...(pending && !mine && pending.customAgentId
            ? {
                onOpenPending: () => {
                  shell.setRoute({ entry: 'agents', myAgent: { id: pending.customAgentId! } })
                },
              }
            : {})}
          sending={delegation.sending}
          error={refused ? COPY.refused(refused.message) : ''}
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
                      attachments.explain(COPY.addAttachmentsAgain)
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
                    {COPY.placeLead}
                    <VisibleText text={projectName(place)} />
                    {COPY.placeTail}
                  </span>
                  {place.id !== agent?.defaultProjectId && (
                    <IconButton
                      icon={CloseGlyph}
                      size="xs"
                      label={COPY.removeProject}
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
      )}
      {!ready && sessions.length > 0 && (
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
