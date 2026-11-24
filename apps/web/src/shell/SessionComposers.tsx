import { SHELL_COPY } from './copy.ts'
import { useState } from 'react'
import { FAILURE_ACTION_LABEL, failureAction, type FailureStep } from '../conversation/failureAction.ts'
import { Eraser, GitFork } from 'lucide-react'
import { NOT_ACCEPTED_5XX, type ModelRef, type SessionConfigOption, type TaskSummary } from '@latch/protocol'
import { Button, Collapse, Hint, Icon, InlineNotice, FolderGlyph, HistoryGlyph, ShieldAlertGlyph, Drawer, ValuePicker } from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import {
  draftConfig,
  harnessName,
  nothingInstalled,
  projectFor,
  sameModel,
  loginHarness,
  servicePick,
  startConfig,
  withLadderMode,
  worktreeProject,
} from '../composerChoice.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { FORK_CONTINUATION_PROMPT, forkSource } from '../forkChoice.ts'
import { APPROVAL_COPY, CODE_ROOT_COPY, computerName } from '../core/securityCopy.ts'
import { CONNECTION_COPY } from '../core/hostState.ts'
import { projectOf } from '../sessions.ts'
import { seedWaiting } from '../history/model.ts'
import { basename } from '../format.ts'
import { scopedTemplates } from '../hooks/usePromptTemplates.ts'
import { useHarnessCommands } from '../hooks/useHarnessCommands.ts'
import { ApprovalDrawer } from '../composer/ApprovalDrawer.tsx'
import { ConversationReferencePicker, REFERENCE_COPY } from '../conversation/ConversationReferencePicker.tsx'
import { Composer } from '../composer/Composer.tsx'
import { CodexTeam } from '../composer/CodexTeam.tsx'
import { canStartTeam } from '../teams/model.ts'
import { draftRound, leadTeamOf, memberChoices, useTeamRound } from '../teams/rounds.ts'
import { MemberTile } from '../teams/TeamGraph.tsx'
import { TEAM_COPY, memberWords } from '../teams/copy.ts'
import { HarnessLimitChip, ServiceBudgetChip } from '../usage/UsageChip.tsx'
import { ComposerControl, openControlWhenShown } from '../composer/ComposerControl.tsx'
import { composerActions } from './composerActions.ts'
import { MoreMenu } from '../composer/Footer.tsx'
import { canSwitchBranch } from '../composer/BranchSwitch.tsx'
import { FolderControl, ProjectBranch } from '../composer/FolderControl.tsx'
import { ComposerStatus, FolderSegment, statusRoute } from '../composer/ComposerStatus.tsx'
import { SessionVitalsLine } from '../composer/VitalsStrip.tsx'
import { DraftHarnessControl, forkBusy, SessionHarnessControl, type SessionFork } from '../composer/ModelControl.tsx'
import { DraftModelControl, SessionModelControl } from '../composer/ModelPanel.tsx'
import { ComposerPermission, type ComposerPermissionState } from '../composer/ComposerPermission.tsx'
import { ConfigFeedback } from '../composer/ThinkingControl.tsx'
import { composerOptions, configUnknownBar, ownModelName } from '../composer/modelReasoning.ts'
import { draftPermission, draftRead, permissionView } from '../composer/permission.ts'
import { helperPermissionBlocked } from '../agents/personWords.ts'
import { readOnSelect, readsOnPermission, useReading } from '../composer/harnessCatalogue.tsx'
import { QuestionDrawer, useQuestionDrawer } from '../composer/QuestionDrawer.tsx'
import { QueueDrawer } from '../composer/QueueDrawer.tsx'
import { WorkspaceRecovery } from '../composer/WorkspaceRecovery.tsx'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { ModeSwitch, ProjectPicker } from '../components/Pickers.tsx'
import { HarnessInstallCard, SetupCard } from '../newSession/NewSession.tsx'
import { StartComputer } from '../newSession/StartComputer.tsx'
import { hostView } from '../core/permissions.ts'
import { DraftLoginNotice } from '../components/HarnessLogin.tsx'
import { loginSurface } from '../panel/terminal/loginRuns.ts'
import { SendingMessage } from '../components/SendingMessage.tsx'
import {
  askSideQuestion,
  currentSideQuestion,
  ReplaceSideQuestionDialog,
  sideQuestionBlock,
  sideQuestionOf,
  sideQuestionRefusal,
  type SideQuestion,
} from '../conversation/SideQuestion.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { speakerOf } from '../agents/model.ts'
import { RouteWarning } from '../agents/parts.tsx'
import { defineCopy } from '../core/i18n.ts'

const COMPOSER_COPY = defineCopy(
  {
    service: (harness: string) => `${harness} 用的模型服务`,
    project: (name: string) => `项目 ${name}`,
    rebuild: '第一条消息会把重建的对话文字一起发给',
    fork: (title: string) => `从「${title}」分叉`,
    moved: (title: string) => `接着「${title}」聊`,
    editFirst: (title: string) => `改写「${title}」的第一条`,
    askIn: '想在 ',
    askAfter: ' 里做什么？',
    ask: '想做什么？',
    skipProject: '不选项目直接开始',
    pickProject: '选一个项目',
    place: '在哪里开始',
    purpose: '模式',
    browsePlugins: '浏览插件',
    regular: '常规',
    creation: '创造模式',
    creatorTitle: '想为 Latch 做什么？',
    creatorScope: '在专用文件夹以 Agent 模式开发；插件经你审阅和启用后生效。',
    creatorHelp: '用对话制作插件、界面，或组合技能和工具。在专用文件夹以 Agent 模式开发。',
    creatorUnsupported: '请选择支持创造模式的 Harness。',
    creatorPrompt: '描述想要的功能、界面或工作方法',
    busy: '正在切换，请稍后。',
    files: '输入消息 · @ 引用文件',
    commands: '输入消息 · / 选择命令',
    filesAndCommands: '输入消息 · @ 引用文件 · / 选择命令',
  },
  {
    service: (harness: string) => `Model service used by ${harness}`,
    project: (name: string) => `Project ${name}`,
    rebuild: 'The first message sends the reconstructed conversation to',
    fork: (title: string) => `Fork from “${title}”`,
    moved: (title: string) => `Continue “${title}”`,
    editFirst: (title: string) => `Edit the first message of “${title}”`,
    askIn: 'What should we build in ',
    askAfter: '?',
    ask: 'What should we build?',
    skipProject: 'Start without a project',
    pickProject: 'Choose a project',
    place: 'Where it starts',
    purpose: 'Mode',
    browsePlugins: 'Browse plugins',
    regular: 'Standard',
    creation: 'Creation mode',
    creatorTitle: 'What should we make for Latch?',
    creatorScope: 'Develop in Agent mode in a dedicated folder. Review and enable the plugin when it is ready.',
    creatorHelp: 'Create plugins, interfaces or combinations of skills and tools with an agent in a dedicated folder.',
    creatorUnsupported: 'Choose a Harness that supports creation mode.',
    creatorPrompt: 'Describe the feature, interface or workflow you want',
    busy: 'Switching. Try again in a moment.',
    files: 'Message · @ mention files',
    commands: 'Message · / commands',
    filesAndCommands: 'Message · @ files · / commands',
  },
)

/** The message on its way, until the Host lists it. */
export function SendingBubble({ shell }: { shell: ShellState }) {
  const { sendingView } = shell
  if (!sendingView) return null
  return <SendingMessage key={sendingView.submission.requestId} view={sendingView} />
}

/** A project's name on the headline is cut past this many characters; its hover shows it whole. */
const LONG_PROJECT = 28

/**
 * The start page's headline over its input: 「想在 〈项目〉 里做什么？」, the project's name with a dotted underline that
 * opens the project list, and under it one small action, 「不选项目直接开始」. With no project chosen it asks
 * 「想做什么？」 and the small line 「选一个项目」 opens the list. What the list offers (不选项目, adding one, the reason a
 * folder was refused) is the project picker's own.
 */
function HomeHeadline({ shell }: { shell: ShellState }) {
  const { catalog, choice, newChoicesLocked, access, owner, openSettings, createProject, projectAsk, chooseProject } = shell
  // Going on with another Harness is not a new question: the conversation so far stands where the headline would.
  if (!catalog || shell.submission.fork?.moved) return null
  if (shell.creator)
    return (
      <div className="home-headline" data-backdrop-clear="">
        <h2 className="home-headline-ask">{COMPOSER_COPY.creatorTitle}</h2>
        <p className="home-headline-sub">{COMPOSER_COPY.creatorScope}</p>
      </div>
    )
  const project = catalog.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')
  const name = project ? escapeHiddenCharacters(project.name || basename(project.path)) : undefined
  const picker = (face: string | undefined) => (
    <ProjectPicker
      inline
      access={access}
      catalog={catalog}
      value={project?.id ?? (choice.projectSkipped ? 'default' : undefined)}
      disabled={newChoicesLocked}
      harness={catalog.harnesses.find(item => item.id === choice.harnessId)}
      onManage={owner ? () => openSettings('workspaces') : undefined}
      onCreate={createProject}
      onChange={chooseProject}
      openRequest={projectAsk.request}
      notice={projectAsk.notice}
      noProjectRefusal={shell.noProjectRefusal}
      onClosed={projectAsk.clearNotice}
      {...(face !== undefined ? { face } : {})}
      {...(name && name.length > LONG_PROJECT ? { hint: name } : {})}
    />
  )
  return (
    <div className="home-headline" data-backdrop-clear="">
      <h2 className="home-headline-ask">
        {name ? (
          <>
            {COMPOSER_COPY.askIn}
            <span className="home-headline-project">{picker(name)}</span>
            {COMPOSER_COPY.askAfter}
          </>
        ) : (
          COMPOSER_COPY.ask
        )}
      </h2>
      {(!name || !shell.noProjectRefusal) && (
        <p className="home-headline-sub">
          {name ? (
            <button type="button" className="home-headline-skip" disabled={newChoicesLocked} onClick={() => chooseProject('default')}>
              {COMPOSER_COPY.skipProject}
            </button>
          ) : (
            <span className="home-headline-pick">{picker(COMPOSER_COPY.pickProject)}</span>
          )}
        </p>
      )}
    </div>
  )
}

/**
 * Where a session outside a saved project works, as 设置 names it: the Host's 默认文件夹 (不选项目 there, for a session or
 * one of 我的 Agent), never that folder's own name; a folder of its own goes by its name.
 */
export function placeName(summary: Pick<TaskSummary, 'cwd' | 'workspaceId' | 'sessionFolder'>): string | undefined {
  if (!summary.cwd) return undefined
  return summary.workspaceId === 'default' && !summary.sessionFolder ? SHELL_COPY.defaultFolder : basename(summary.cwd)
}

/** The sentence a fork's input starts with, as a fork from a turn's footer does. */

/**
 * Opens one of the four controls once the page that holds it is drawn, as its key would: the new-session page mounts
 * its own composer after the session's goes, so the trigger is looked for over the next frames.
 */

/**
 * A refused send's own next steps beside its reason, when its code names one this device can take. The text stayed in
 * the input, so 重试 sends it again; it is offered for a Harness that could not start, which may start the next time.
 */
export function composerFailure(
  code: string | undefined,
  owner: boolean,
  openSettings: (section: 'engines' | 'providers') => void,
  retry: () => void,
): { errorActions?: Array<{ label: string; run: () => void }> } {
  const step = failureAction(code)
  // The Harness answered with an error of its own (a session in use elsewhere): nothing was taken, and it may pass.
  if (step === 'retry' && code !== undefined && NOT_ACCEPTED_5XX.has(code))
    return { errorActions: [{ label: FAILURE_ACTION_LABEL.retry, run: retry }] }
  if (step !== 'model' && step !== 'harness' && step !== 'providers') return {}
  const actions: Array<{ label: string; run: () => void }> = []
  if ((owner ? OWNER_FAILURE_STEPS : DEVICE_FAILURE_STEPS).includes(step))
    actions.push({ label: FAILURE_ACTION_LABEL[step], run: () => takeFailureStep(step, openSettings) })
  if (step === 'harness') actions.push({ label: FAILURE_ACTION_LABEL.retry, run: retry })
  return actions.length ? { errorActions: actions } : {}
}

/** The failure steps a device takes: anyone may pick another model; only the owner changes 设置. */
export const OWNER_FAILURE_STEPS: readonly FailureStep[] = ['harness', 'model', 'providers']
export const DEVICE_FAILURE_STEPS: readonly FailureStep[] = ['model']

/** Takes a failure's next step: the composer's model menu, or the section of 设置 its fix is in. */
export function takeFailureStep(step: FailureStep, openSettings: (section: 'engines' | 'providers') => void): void {
  if (step === 'model') openControlWhenShown('model', 10, false)
  else openSettings(step === 'harness' ? 'engines' : 'providers')
}

/**
 * One of the composer's four controls, named for what a key that opens it looks for: the trigger is the button inside.
 * The pickers come from `@latch/ui` and draw their own trigger, so the name sits on this wrapper.
 */

/** The draft's real start choices, for the home's input. */
function useDraftHarnessCommands(shell: ShellState, enabled: boolean) {
  const { catalog, chosenHarness, choice, access, submission } = shell
  const cacheEnabled =
    enabled
    && !!chosenHarness
    && !!chosenHarness.commandCatalogue
    && chosenHarness.status === 'ready'
    && access.scopes.has('view')
    && shell.connection === 'connected'
    && submission.pending === null
    && submission.fork === null
    && !submission.worktree
  const service = cacheEnabled ? servicePick(catalog, chosenHarness, choice.config) : undefined
  const model = service ?? choice.model
  const picks = cacheEnabled
    ? startConfig(chosenHarness, choice.config).filter(
        pick => !service || chosenHarness?.catalogue?.options.find(option => option.id === pick.configId)?.category !== 'model',
      )
    : []
  const project = cacheEnabled ? catalog?.workspaces.find(item => item.id === (choice.workspaceId ?? 'default')) : undefined
  const provider = cacheEnabled && model ? catalog?.providers.find(item => item.id === model.providerId) : undefined
  return useHarnessCommands(
    cacheEnabled
      ? {
          harnessId: chosenHarness.id,
          workspaceId: choice.workspaceId,
          mode: choice.mode,
          ...(model ? { model } : {}),
          ...(picks.length ? { config: picks } : {}),
        }
      : undefined,
    cacheEnabled
      ? JSON.stringify([
          shell.snapshot.instanceId,
          shell.snapshot.host.hostId,
          shell.snapshot.device.id,
          shell.snapshot.device.dataScope,
          shell.snapshot.device.scopes,
          chosenHarness.commandCatalogue?.generation,
          project && [project.id, project.path, project.unavailable, project.folders],
          provider && [provider.id, provider.kind, model && provider.modelCapabilities?.[model.model]],
          shell.snapshot.tasks
            .filter(task => task.harnessId === chosenHarness.id && (task.workspaceId ?? 'default') === (choice.workspaceId ?? 'default'))
            .map(task => [task.id, task.commandsVersion ?? ''])
            .sort(([left], [right]) => left!.localeCompare(right!)),
        ])
      : '',
  )
}

/** The input of the open session, or the home's, which starts one. */
export function SessionComposer({
  shell: base,
  home = false,
  pendingInTranscript = false,
  visible = true,
  sidePanel,
}: {
  shell: ShellState
  home?: boolean
  pendingInTranscript?: boolean
  visible?: boolean
  sidePanel?: SideQuestion | undefined
}) {
  const shell = home
    ? { ...base, ...base.homeComposerState, composerRef: base.homeComposerRef }
    : base.inputTarget === 'new'
      ? { ...base, submission: { ...base.submission, draft: base.sessionInput.draft }, attachmentDraft: base.sessionInput.attachments }
      : base
  const {
    chosenHarness,
    current,
    summary,
    composerRef,
    actionError,
    configBusy,
    configFeedback,
    catalog,
    access,
    owner,
    canQueue,
    steer,
    harnessInfo,
    submission,
    choice,
    attachmentDraft,
    setSubmissionDraft,
    mentionChoice,
    sendDraft,
    sendPrompt,
    retryDraft,
    abandonPending,
    abandoning,
    pendingQueued,
    setConfig,
    refreshConfig,
    retryConfig,
    abandonConfig,
    block,
    chosenScopeCaption,
    gate,
    sessionBlock,
    earlierDraft,
    noteComposer,
    codeRootChoice,
    currentModel,
    effectiveModel,
    run,
    placeholder,
    coarse,
    preferences,
    phone,
    promptTemplates,
    openSettings,
    startNew,
    manageProviders,
    selectedId,
    refresh,
    approvals,
    approvalIndex,
    setApprovalIndex,
    selectApproval,
    gateFor,
    approvalBusy,
    statuses,
    onDecide,
    setToast,
    newChoicesLocked,
    workspaceChanged,
    recoveryProjects,
    setRecoveryProjects,
    cancelling,
    choose,
  } = shell
  const cachedCommands = useDraftHarnessCommands(shell, selectedId === null && (!home || shell.route.start === true))
  const commandHarness = selectedId === null ? chosenHarness : harnessInfo
  const manageEngines = owner ? () => openSettings('engines') : undefined
  // A refusal the new session's own block already says (a Harness found too old once sent) is said there once.
  const refusal = selectedId === null && block !== null && submission.error === block.message ? '' : submission.error
  // The open session leads a team: its members after `@`, and a draft that names them goes to them as a round.
  const leadTeam =
    catalog?.features?.teams && access.scopes.has('run') && selectedId !== null && current?.summary.id === selectedId
      ? leadTeamOf(shell.snapshot.teams, selectedId)
      : undefined
  const choices = leadTeam ? memberChoices(leadTeam, shell.snapshot.tasks) : undefined
  const textOnly = (attachmentDraft?.items.length ?? 0) > 0 || (mentionChoice?.refs.length ?? 0) > 0
  const named = choices ? draftRound(submission.draft, choices) : undefined
  const roundDraft = named && textOnly ? { ...named, ready: false, reason: TEAM_COPY.textOnly } : named
  const teamRound = useTeamRound(leadTeam?.id, refresh)
  const roundFailure = teamRound.status.state === 'failed' && teamRound.status.key === submission.draft ? teamRound.status.reason : ''
  const sendRound = async () => {
    if (!roundDraft?.ready) return
    const sent = await teamRound.send(
      roundDraft.itemIds.map(itemId => ({ itemId, prompt: roundDraft.prompt })),
      submission.draft,
    )
    if (sent) setSubmissionDraft('')
  }
  // A text rebuild sends its rebuilt conversation with the first message, to the service that answers it.
  const seedService =
    current && current.summary.id === selectedId && seedWaiting(current.summary, current.messages)
      ? (current.summary.providerId && shell.providerName(current.summary.providerId))
        || COMPOSER_COPY.service(harnessInfo ? harnessName(harnessInfo) : 'Harness')
      : undefined
  // Latch's own sentences name the computer on any page but the Latch app on it.
  const computer = access.local ? undefined : computerName(shell.snapshot.hostName)
  const lastMessage = current?.summary.id === selectedId ? current?.messages.at(-1) : undefined
  // The latest turn into a new session, where the Host can fork and this device may start one. The Host refuses a turn
  // that has not ended, so the row says to wait instead.
  const fork: SessionFork | undefined =
    current && lastMessage && catalog?.features?.fork === true && access.scopes.has('run')
      ? {
          ...(shell.active ? { blocked: forkBusy() } : {}),
          onFork: () => {
            const draft = submission.draft.trim() ? submission.draft : FORK_CONTINUATION_PROMPT
            shell.startNewDraft({ draft }, () => {
              submission.setFork({
                taskId: current.summary.id,
                upToMessageId: lastMessage.id,
                title: current.summary.title,
                choice: {
                  harnessId: current.summary.harnessId,
                  workspaceId: projectFor(catalog, current.summary),
                  mode: current.summary.mode ?? 'agent',
                },
                source: forkSource(current, harnessInfo),
              })
              if (!phone) openControlWhenShown('harness')
            })
          },
          // The same conversation on another Harness that is ready here: its record goes along, and the two read as one.
          moves: (catalog.harnesses ?? [])
            .filter(item => item.id !== current.summary.harnessId && item.status === 'ready')
            .slice(0, 8)
            .map(item => ({
              harness: item,
              onMove: () => {
                const draft = submission.draft
                shell.startNewDraft({ draft }, () => {
                  submission.setFork({
                    taskId: current.summary.id,
                    upToMessageId: lastMessage.id,
                    moved: true,
                    title: current.summary.title,
                    choice: {
                      harnessId: item.id,
                      workspaceId: projectFor(catalog, current.summary),
                      mode: current.summary.mode ?? 'agent',
                    },
                    source: forkSource(current, harnessInfo),
                  })
                })
              },
            })),
        }
      : undefined
  const questionActions = {
    deviceId: shell.snapshot.device.id,
    canAnswer: gate.kind === 'open' && sessionBlock === undefined,
    onChanged: refresh,
    onSettledElsewhere: (text: string) => setToast({ text, tone: 'ok' }),
  }
  const asked = useQuestionDrawer(current?.questions?.[0], selectedId ?? '', questionActions)
  const answersQuestion = asked !== undefined && !asked.locked && gate.kind === 'open' && !earlierDraft.held
  const draftReading = useReading(chosenHarness)
  const permission =
    selectedId === null
      ? draftPermission(
          chosenHarness,
          choice.mode,
          withLadderMode(chosenHarness, draftConfig(chosenHarness, choice.config)?.config, choice.config),
          draftRead(chosenHarness, access, draftReading),
          access.scopes,
        )
      : !summary
        ? undefined
        : permissionView({
            harness: harnessInfo,
            mode: summary.mode,
            ...(current?.permission ? { permission: current.permission } : {}),
            config: current?.config ?? [],
            access,
            ...(gate.kind === 'open' ? {} : { locked: gate.kind === 'read-only' ? gate.text : SHELL_COPY.noInput }),
          })
  const chooseOption = (option: SessionConfigOption, value: string) => {
    // A draft keeps the pick for its start; a session takes it now.
    if (selectedId === null) {
      submission.updateChoice({ config: { ...choice.config, [option.id]: value } })
      return
    }
    if (configBusy.has(selectedId)) return
    void Promise.resolve(setConfig(option.id, value))
  }
  const switchSessionModel = (model: ModelRef | undefined) => {
    if (!summary) return
    submission.setOverride(summary.id, model && sameModel(model, currentModel) ? undefined : model)
  }
  const otherOptions = composerOptions(current?.config ?? [], harnessInfo?.capabilities.models.owner === 'latch')
  // A new-context send that did not start has cleared it on the Host already: there is nothing left to keep.
  const hostCleared = current?.contextCleared === true && current.summary.id === selectedId
  // A topic of 我的 Agent talks to the helper: the input, ＋ and send only. Its model, thinking and permission are the
  // helper's settings, and what the permission means for safety stays in its frame (TopicFrame), not here.
  const speaker = selectedId !== null ? speakerOf(shell.snapshot, summary) : undefined
  const showControls = speaker === undefined && (selectedId === null || (!!summary && !summary.personal && gate.kind !== 'stopped'))
  const permissionChange = selectedId !== null ? configFeedback.get(selectedId) : undefined
  // The permission is a control of its own, right after the Harness: its glyph on the line, its modes in its popover.
  const modeId = permission?.option?.id
  const composerPermission: ComposerPermissionState | undefined =
    permission && catalog && (selectedId === null || summary)
      ? {
          // While another of the session's settings is being written, the other modes wait for it, with why; a choice is
          // never dropped unsaid.
          view:
            selectedId !== null && configBusy.has(selectedId) && permission.rows
              ? {
                  ...permission,
                  rows: permission.rows.map(row =>
                    row.current || row.disabledReason ? row : { ...row, disabledReason: COMPOSER_COPY.busy },
                  ),
                }
              : permission,
          onChoose: value => {
            if (permission.option) chooseOption(permission.option, value)
          },
          ...(selectedId !== null && modeId !== undefined && configBusy.get(selectedId) === modeId ? { pending: true } : {}),
          ...(permissionChange && modeId !== undefined && permissionChange.configId === modeId
            ? { feedback: <ConfigFeedback feedback={permissionChange} onRefresh={refreshConfig} /> }
            : {}),
          // A draft's modes come from the same read as its model list, so opening the popover first asks as well.
          ...(selectedId === null && !newChoicesLocked
            ? {
                onOpen: () => {
                  if (readsOnPermission(chosenHarness, access)) readOnSelect(chosenHarness, refresh)
                },
              }
            : {}),
        }
      : undefined
  const permissionBlocked =
    selectedId !== null && helperPermissionBlocked(current, permissionChange?.kind === 'unknown' ? permissionChange.configId : undefined)
  const worktreeOffer = selectedId === null ? worktreeProject(catalog, choice, submission.fork !== null) : undefined
  const branchSwitchable = canSwitchBranch(shell.snapshot, shell.access, shell.connection)
  const status = (() => {
    if (selectedId === null) {
      const project = catalog?.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')
      const place = worktreeOffer ? (
        <FolderControl
          project={worktreeOffer}
          worktree={submission.worktree}
          onWorktree={submission.setWorktree}
          disabled={newChoicesLocked}
          branch={project?.branch}
          starts
          switchBranch={branchSwitchable}
        />
      ) : project && choice.mode !== 'chat' ? (
        <>
          <FolderSegment
            name={project.name || basename(project.path)}
            tip={COMPOSER_COPY.project(project.name || basename(project.path))}
          />
          {project.branch && <ProjectBranch projectId={project.id} branch={project.branch} switchable={branchSwitchable} />}
        </>
      ) : undefined
      const route = statusRoute(catalog, chosenHarness, {
        picked: servicePick(catalog, chosenHarness, choice.config),
        model: ownModelName(draftConfig(chosenHarness, choice.config)?.config),
      })
      return <ComposerStatus place={place} route={route} phone={phone} />
    }
    // A session's input has no status line: where it works and what it used are the title row's. Only a route that
    // needs saying (a service the next turn fails on, a turn that went around Latch) is said, in its own short line.
    if (!summary || (!speaker && summary.personal)) return null
    return summary.modelRoute && catalog ? <RouteWarning catalog={catalog} route={summary.modelRoute} /> : null
  })()
  // Keyed, in order: the stack slides each one in and out as it comes and goes.
  const drawers = [
    current && workspaceChanged.has(current.summary.id) && (
      <WorkspaceRecovery
        key="recovery"
        source={current}
        workspaces={catalog?.workspaces ?? []}
        workspaceId={recoveryProjects.get(current.summary.id)}
        onWorkspaceChange={workspaceId => setRecoveryProjects(previous => new Map(previous).set(current.summary.id, workspaceId))}
        forkSupported={catalog?.features?.fork === true}
        harness={harnessInfo}
        runGate={
          access.scopes.has('run') && harnessInfo?.status === 'ready'
            ? { allowed: true }
            : { allowed: false, reason: SHELL_COPY.restoreAccess }
        }
        phase={submission.pending ? 'unknown' : submission.sending || cancelling.has(current.summary.id) ? 'busy' : 'idle'}
        onFork={(taskId, upToMessageId, workspaceId) => {
          const draft = submission.draft
          shell.startNewDraft({ draft }, () => {
            submission.setFork({
              taskId,
              upToMessageId,
              title: current.summary.title,
              choice: { harnessId: current.summary.harnessId, workspaceId, mode: current.summary.mode ?? 'agent' },
              source: forkSource(current, harnessInfo),
            })
          })
        }}
      />
    ),
    asked && (
      <QuestionDrawer
        key="question"
        presentation="conversation"
        state={asked}
        asker={speaker?.name ?? (harnessInfo ? harnessName(harnessInfo) : 'Harness')}
        canAnswer={questionActions.canAnswer}
        onOther={() => {
          earlierDraft.release()
          composerRef.current?.focus()
        }}
      />
    ),
    approvals.length > 0 && (
      <ApprovalDrawer
        key="approval"
        presentation="conversation"
        builtin={summary?.harnessId === 'standard'}
        {...(speaker ? { requester: speaker.name } : {})}
        approvals={approvals}
        messages={current?.messages ?? []}
        index={approvalIndex}
        onIndex={setApprovalIndex}
        gateFor={gateFor}
        busy={approvalBusy}
        statuses={statuses}
        onDecide={onDecide}
        canRetry={shell.canRetryApproval}
        onCheck={shell.checkApproval}
        rejectWithNote={noteComposer?.rejectWithNote}
        {...(run ? { onStop: run.onCancel } : {})}
      />
    ),
    selectedId !== null && (submission.clearing || hostCleared) && (
      <Drawer key="clearing" className="clearing-drawer" label={SHELL_COPY.clearContext}>
        <Icon icon={Eraser} size={14} />
        <p role="status">
          <strong>{SHELL_COPY.nextContext}</strong>
          {hostCleared && <span>{SHELL_COPY.cleared}</span>}
        </p>
        {!hostCleared && (
          <Button size="xs" onClick={() => shell.armClear(false)}>
            {SHELL_COPY.keepContext}
          </Button>
        )}
      </Drawer>
    ),
    selectedId !== null && selectedId === current?.summary.id && current.queue && current.queue.length > 0 && (
      <QueueDrawer
        key={`queue:${selectedId}`}
        sessionId={selectedId}
        items={current.queue}
        canSend={gate.kind === 'open' && sessionBlock === undefined && !submission.pending && shell.connection === 'connected'}
        canRemove={access.scopes.has('run') && shell.connection === 'connected'}
        queueControl={catalog?.features?.queueControl === true}
        steerRunId={steer && !cancelling.has(selectedId) ? current.summary.runId : undefined}
        running={shell.active || current.approvals.length > 0}
        onRemovedUnknown={text => setToast({ text, tone: 'error' })}
        onChanged={refresh}
      />
    ),
  ]
  const words = submission.pending === null ? (noteComposer?.placeholder ?? placeholder) : placeholder
  // A session no longer listed cannot be opened, so its retry stays here and gets the Host's definitive answer.
  const held = submission.pending
  const pendingHome =
    held === null
      ? undefined
      : held.sessionId === undefined
        ? null
        : shell.snapshot.tasks.some(task => task.id === held.sessionId)
          ? held.sessionId
          : undefined
  // /btw: a side question beside this session, offered where its Harness can fork into a chat; it never joins the turn.
  const sideOffered =
    selectedId !== null && !!current && current.summary.id === selectedId && !!summary && !summary.personal && access.scopes.has('run')
  const sideRefusal = sideOffered ? sideQuestionRefusal(catalog, harnessInfo) : undefined
  const sideQuestion = sideOffered && !sideRefusal ? sideQuestionOf(submission.draft) : undefined
  // `/btw …` where it is not available stays in the input with the reason; it never goes to the Harness.
  const sideBlocked = sideQuestionBlock(submission.draft, sideOffered, sideRefusal)
  // No network on this device: the text stays a draft, and Enter obeys the same gate as the button.
  const offline = shell.connection === 'offline'
  const mayAskSide =
    current
    && sideOffered
    && !sideRefusal
    && visible
    && !offline
    && gate.kind === 'open'
    && !sessionBlock
    && !permissionBlocked
    && !submission.pending
    && !submission.sending
      ? current
      : undefined
  const [replaceSide, setReplaceSide] = useState<{ draft: string; question: string; requestId: string }>()
  const replacement =
    mayAskSide && sidePanel && replaceSide?.requestId === sidePanel.body.requestId && replaceSide.draft === submission.draft
      ? replaceSide
      : undefined
  if (replaceSide && !replacement) setReplaceSide(undefined)
  const sendSideQuestion = (question: string) => {
    if (!mayAskSide || !question) return
    const previous = currentSideQuestion(mayAskSide.summary.id)
    if (previous) {
      const draft = sideQuestion === question ? submission.draft : `/btw ${question}`
      if (draft !== submission.draft) setSubmissionDraft(draft)
      setReplaceSide({ draft, question, requestId: previous.body.requestId })
      return
    }
    const sent = askSideQuestion(mayAskSide, question, projectFor(catalog, mayAskSide.summary), shell.active)
    if (sent) setSubmissionDraft('')
  }
  const answer = asked
    ? answersQuestion
      ? {
          kind: 'question' as const,
          onSubmit: () => {
            asked.answerOther(submission.draft.trim())
            setSubmissionDraft('')
          },
        }
      : undefined
    : noteComposer
      ? { kind: 'reject' as const, onSubmit: noteComposer.submit }
      : sideQuestion !== undefined && current
        ? {
            kind: 'question' as const,
            onSubmit: () => sendSideQuestion(sideQuestion),
          }
        : undefined
  // A Harness on its own login shows its subscription's limits; a draft or session on one of Latch's services shows that
  // service's budget instead, never the subscription's.
  const draftService = selectedId === null && catalog && chosenHarness ? servicePick(catalog, chosenHarness, choice.config) : undefined
  const sessionService =
    selectedId === null || !summary
      ? undefined
      : (summary.modelRoute?.providerId ?? (harnessInfo?.capabilities.models.owner === 'latch' ? summary.providerId : undefined))
  const serviceId = draftService?.providerId ?? sessionService
  const ownLogin = selectedId === null ? (draftService ? undefined : chosenHarness) : summary && !serviceId ? harnessInfo : undefined
  const usageChip = !catalog ? undefined : serviceId ? (
    <ServiceBudgetChip
      providerId={serviceId}
      name={catalog.providers.find(provider => provider.id === serviceId)?.name ?? serviceId}
      revision={current?.messages.length}
    />
  ) : ownLogin && ownLogin.capabilities.models.owner === 'harness' ? (
    <HarnessLimitChip harness={ownLogin} />
  ) : undefined
  // Where in the project the new session starts, one quiet line under the input: the computer, then the project folder
  // or a new worktree, then the branch. The project itself is the headline's.
  const homePlace = home ? (
    <div className="home-place" role="group" aria-label={COMPOSER_COPY.place}>
      <StartComputer hostId={hostView(base.snapshot)?.hostId} disabled={newChoicesLocked} />
      {(base.creatorAvailable || base.creator) && !submission.fork && !base.board && (
        <span>
          <ValuePicker
            label={COMPOSER_COPY.purpose}
            value={base.creator ? 'creator' : 'regular'}
            size="xs"
            width="lg"
            align="start"
            disabled={newChoicesLocked}
            onValueChange={next => {
              base.chooseCreator(next === 'creator')
            }}
            options={[
              { value: 'regular', label: COMPOSER_COPY.regular },
              {
                value: 'creator',
                label: COMPOSER_COPY.creation,
                description: COMPOSER_COPY.creatorHelp,
                ...(!base.creatorAvailable || !chosenHarness?.pluginCreation || !chosenHarness.modes.includes('agent')
                  ? { disabledReason: COMPOSER_COPY.creatorUnsupported }
                  : base.creatorBlockedReason
                    ? { disabledReason: base.creatorBlockedReason }
                    : {}),
              },
            ]}
          />
        </span>
      )}
      {base.canBrowseMarketplace && !base.board && (
        <Button variant="ghost" size="xs" data-marketplace-nav="" onClick={base.openMarketplace}>
          {COMPOSER_COPY.browsePlugins}
        </Button>
      )}
      {!base.creator && worktreeOffer && (
        <FolderControl
          project={worktreeOffer}
          worktree={submission.worktree}
          onWorktree={submission.setWorktree}
          disabled={newChoicesLocked}
          branch={catalog?.workspaces.find(item => item.id === choice.workspaceId)?.branch}
          starts
          switchBranch={branchSwitchable}
        />
      )}
      {!phone && showControls && <span className="home-place-end">{usageChip}</span>}
    </div>
  ) : undefined
  // The input can take a request for the agent: nothing runs, waits or is being sent.
  const teamPrepare =
    gate.kind === 'open'
    && !shell.active
    && !sessionBlock
    && !sideBlocked
    && !permissionBlocked
    && !answer
    && !submission.pending
    && !submission.sending
  // This session would take a message now, as the send button would: queued behind a running turn where the Host queues.
  const teamSend =
    !offline
    && gate.kind === 'open'
    && sessionBlock === undefined
    && !sideBlocked
    && !permissionBlocked
    && !answer
    && !submission.pending
    && !submission.sending
    && (!shell.active || canQueue)
  const canSend =
    !offline
    && !(home && base.creator && base.creatorBlocked)
    && gate.kind === 'open'
    && (selectedId === null ? block === null : sessionBlock === undefined)
    && !sideBlocked
    && !permissionBlocked
  const commands = selectedId === null ? cachedCommands?.commands : current?.commands
  const skills = selectedId === null ? cachedCommands?.skills : current?.skills
  const actions = composerActions(shell, 'slash', sendSideQuestion)
  const templates = scopedTemplates(
    promptTemplates,
    selectedId === null
      ? (choice.workspaceId ?? catalog?.defaults.workspaceId)
      : summary && catalog
        ? projectOf(summary, catalog.workspaces)?.id
        : undefined,
    selectedId === null ? choice.harnessId : summary?.harnessId,
  )
  // During a turn or an answer, the placeholder says how to send that message.
  const showHints = canSend && !shell.active && !asked && !answer && !noteComposer && !submission.pending && !submission.sending && !speaker
  const mentionFiles = showHints && mentionChoice.enabled && (selectedId === null ? !!mentionChoice.workspaceId : !!summary?.cwd)
  const chooseCommand =
    showHints
    && (selectedId === null ? choice.mode !== 'chat' : summary?.mode !== 'chat')
    && (actions.some(action => !action.unavailable) || !!commands?.length || !!skills?.length || templates.length > 0)
  const inputHint = mentionFiles
    ? chooseCommand
      ? COMPOSER_COPY.filesAndCommands
      : COMPOSER_COPY.files
    : chooseCommand
      ? COMPOSER_COPY.commands
      : words
  const [referencing, setReferencing] = useState<string>()
  const referenceTarget =
    current?.canReferenceConversation && current.summary.id === selectedId && !answer && gate.kind === 'open' && canSend
      ? current.summary
      : undefined
  const composer = (
    <>
      {referenceTarget && referencing === referenceTarget.id && (
        <ConversationReferencePicker
          key={referenceTarget.id + shell.snapshot.device.id}
          target={referenceTarget}
          tasks={shell.snapshot.tasks}
          phone={phone}
          close={() => setReferencing(undefined)}
          select={(id, title) => {
            submission.setDraft(
              previous =>
                [previous.trimEnd(), `[conversation-ref:${id}] ${title.replace(/[\r\n]/gu, ' ')} · read_conversation_reference`]
                  .filter(Boolean)
                  .join('\n') + '\n',
            )
            setReferencing(undefined)
            requestAnimationFrame(() => composerRef.current?.focus())
          }}
        />
      )}
      <Composer
        attachmentMenu={
          referenceTarget
            ? [
                {
                  id: 'context',
                  items: [{ id: 'reference', label: REFERENCE_COPY.title, onSelect: () => setReferencing(referenceTarget.id) }],
                },
              ]
            : undefined
        }
        showSlashButton={speaker === undefined}
        textareaRef={composerRef}
        lastPrompt={current?.messages.findLast(message => message.role === 'user')?.text}
        attachments={
          !(home && base.creator) && catalog?.features?.attachments === true && gate.kind === 'open' && !answer
            ? attachmentDraft
            : undefined
        }
        fileMentions={mentionChoice}
        members={
          choices && catalog
            ? {
                mention: {
                  label: TEAM_COPY.member,
                  items: choices.map(choice => {
                    const harness = catalog.harnesses.find(item => item.id === choice.harnessId)
                    return {
                      id: choice.itemId,
                      token: choice.token,
                      name: choice.name,
                      title: choice.title,
                      media: <MemberTile harnessId={choice.harnessId} harnesses={catalog.harnesses} />,
                      // Its task under its name, then its Harness.
                      description: choice.name === choice.title ? (harness ? harnessName(harness) : choice.harnessId) : choice.title,
                      source: memberWords(choice.member.state),
                      ...(choice.disabled ? { disabled: choice.disabled } : {}),
                    }
                  }),
                },
                marks: choices.map(choice => ({
                  ...choice,
                  media: <MemberTile harnessId={choice.harnessId} harnesses={catalog.harnesses} size={16} />,
                })),
                ...(roundDraft ? { round: { ready: roundDraft.ready, ...(roundDraft.reason ? { reason: roundDraft.reason } : {}) } } : {}),
                sending: teamRound.status.state === 'sending',
                sendLabel: TEAM_COPY.sendToMembers,
              }
            : undefined
        }
        commands={commands}
        skills={skills}
        skillsTruncated={selectedId === null ? cachedCommands?.skillsTruncated : current?.skillsTruncated}
        commandSource={
          commandHarness
            ? {
                name: harnessName(commandHarness),
                media: <HarnessTile harness={commandHarness} size={16} />,
                firstTurn: !!seedService || (!!summary?.agent && !current?.messages.some(message => message.role === 'user')),
                ...(selectedId === null
                  ? { previousSession: !!cachedCommands, awaitingSession: !!commandHarness.commandCatalogue && !cachedCommands }
                  : {}),
              }
            : undefined
        }
        actions={actions}
        onCreateTemplate={owner ? () => openSettings('general') : undefined}
        historyScope={{ deviceId: shell.snapshot.device.id, harnessId: selectedId === null ? choice.harnessId : summary?.harnessId }}
        templates={templates}
        variant={selectedId === null ? 'new' : 'session'}
        label={noteComposer ? APPROVAL_COPY.rejectPlaceholder : selectedId === null ? SHELL_COPY.message : SHELL_COPY.continueChat}
        placeholder={home && base.creator ? COMPOSER_COPY.creatorPrompt : inputHint}
        draft={submission.draft}
        onDraft={setSubmissionDraft}
        pending={submission.pending}
        pendingInTranscript={pendingInTranscript}
        {...(pendingHome === undefined || pendingHome === selectedId
          ? {}
          : {
              onOpenPending: () => {
                choose(pendingHome, () => {
                  if (pendingHome === null) base.showHome()
                })
              },
            })}
        sending={submission.sending}
        error={
          noteComposer?.error
          || refusal
          || roundFailure
          || (actionError?.sessionId === selectedId ? actionError.text : '')
          || (sideBlocked ?? '')
        }
        {...(!noteComposer?.error && refusal
          ? composerFailure(submission.errorCode, owner, openSettings, () => {
              void sendDraft()
            })
          : {})}
        pendingReason={offline ? CONNECTION_COPY.offline : submission.pendingReason}
        onRetry={() => {
          void retryDraft()
        }}
        onAbandon={() => {
          void abandonPending()
        }}
        abandoning={abandoning}
        abandonHeld={submission.sendingElsewhere ? SHELL_COPY.retryElsewhere : undefined}
        pendingNote={pendingQueued === 'waiting' ? SHELL_COPY.queued : pendingQueued === 'parked' ? SHELL_COPY.parked : undefined}
        canSend={canSend}
        blockReason={
          offline
            ? CONNECTION_COPY.offline
            : home && base.creator && base.creatorBlocked
              ? COMPOSER_COPY.creatorUnsupported
              : (block?.message ?? sessionBlock ?? sideBlocked)
        }
        readOnly={
          gate.kind === 'read-only'
            ? gate.text
            : gate.kind === 'stopped'
              ? placeholder
              : permissionBlocked
                ? SHELL_COPY.unverified
                : undefined
        }
        {...(gate.kind === 'read-only' && gate.reason ? { readOnlyReason: gate.reason } : {})}
        {...(answer ? { answer } : {})}
        drawers={drawers}
        stepBack={approvals.length > 0 || answersQuestion}
        status={home ? undefined : status}
        vitals={
          !home && selectedId !== null && summary && !speaker && !summary.personal ? (
            <SessionVitalsLine summary={summary} detail={current} harness={harnessInfo} phone={phone} />
          ) : undefined
        }
        below={
          selectedId === null && catalog ? (
            <>
              {!phone && homePlace}
              {/* Captions open under the input like disclosures, so the input and everything above it stay put. */}
              <Collapse open={codeRootChoice !== undefined}>
                <p className="composer-notice" data-tint="warn" role="note">
                  <Icon icon={ShieldAlertGlyph} size={14} />
                  {codeRootChoice && CODE_ROOT_COPY.notice}
                </p>
              </Collapse>
              <Collapse open={chosenScopeCaption !== undefined}>
                <div className="composer-notice composer-scope" role="note">
                  {chosenScopeCaption && (
                    <Hint lead={<Icon icon={FolderGlyph} size={14} />} label={<VisibleText text={chosenScopeCaption.label} />}>
                      {chosenScopeCaption.detail && <VisibleText text={chosenScopeCaption.detail} />}
                    </Hint>
                  )}
                </div>
              </Collapse>
            </>
          ) : seedService ? (
            <div className="composer-notice composer-seed" data-tint="warn" role="note">
              {/* Where the rebuilt text goes is the words' tooltip; the short line keeps its amber. */}
              <Hint
                className="agent-permission-note is-warn"
                lead={<Icon icon={HistoryGlyph} size={14} />}
                label={SHELL_COPY.rebuildWarning}>
                {COMPOSER_COPY.rebuild} <VisibleText text={seedService} />
              </Hint>
            </div>
          ) : undefined
        }
        vitalsLead={
          !seedService && current && selectedId === current.summary.id ? (
            <CodexTeam
              key={current.summary.id}
              detail={current}
              onApproval={selectApproval}
              run={run}
              team={
                shell.catalog?.features?.teams && access.scopes.has('run') && canStartTeam(current.summary, shell.snapshot.teams)
                  ? {
                      summary: current.summary,
                      catalog: shell.catalog,
                      deviceId: shell.snapshot.device.id,
                      access,
                      refresh: shell.refresh,
                      onManageModels: manageProviders,
                      computer,
                      prepare: {
                        draft: submission.draft,
                        open: teamPrepare,
                        put: value => {
                          setSubmissionDraft(value)
                          requestAnimationFrame(() => composerRef.current?.focus())
                        },
                      },
                      send: { open: teamSend, go: sendPrompt },
                    }
                  : undefined
              }
            />
          ) : undefined
        }
        // A phone keeps the place over its input, first in reading order as it is on screen.
        {...(phone && homePlace ? { over: homePlace } : {})}
        confirmation={
          <InlineConfirm active={submission.sending || (selectedId !== null && configBusy.has(selectedId))} className="composer-confirm" />
        }
        onSubmit={() => {
          // Members named in it: a round to them, never a message to this session.
          if (roundDraft) void sendRound()
          else void sendDraft()
        }}
        onQueue={() => {
          void sendDraft(true)
        }}
        sendKey={preferences.sendKey}
        coarse={coarse}
        run={run}
        configUnknown={configUnknownBar(
          selectedId === null ? undefined : configFeedback.get(selectedId),
          harnessInfo ? harnessName(harnessInfo) : 'Harness',
          refreshConfig,
          retryConfig,
          abandonConfig,
        )}
        queueable={canQueue && !answer && (!attachmentDraft?.items.length || catalog?.features?.queueAttachments === true)}
        steerable={steer && !answer && !attachmentDraft?.items.length && !submission.draft.includes('[conversation-ref:')}
        inline={phone}
        meta={!showControls || phone ? undefined : <MoreMenu options={otherOptions} disabled={newChoicesLocked} onOption={chooseOption} />}
        // The limit arrives seconds after a turn starts and leaves with the Host's memory: last before send at every width,
        // so the controls before it stay where they are.
        // On the start page the limit ends the line that says where the session starts.
        usage={showControls && !(home && !phone) ? usageChip : undefined}
        controls={
          !showControls ? null : !catalog ? (
            selectedId === null ? (
              <ModeSwitch
                value={choice.mode}
                disabled={newChoicesLocked}
                onChange={mode => {
                  submission.updateChoice({ mode })
                }}
              />
            ) : null
          ) : selectedId === null ? (
            <>
              <ComposerControl name="harness">
                <DraftHarnessControl
                  catalog={catalog}
                  choice={choice}
                  onChoice={submission.updateChoice}
                  access={access}
                  disabled={newChoicesLocked}
                  onManage={manageEngines}
                  onAdded={agent => {
                    submission.updateChoice({ harnessId: agent.id })
                    void refresh()
                  }}
                  onDefaultsChanged={async () => {
                    await refresh()
                    submission.forgetDraftPick()
                  }}
                  onRead={refresh}
                  computer={computer}
                />
              </ComposerControl>
              <ComposerControl name="permission">
                <ComposerPermission permission={composerPermission} />
              </ComposerControl>
              <ComposerControl name="model">
                <DraftModelControl
                  withLevel
                  catalog={catalog}
                  choice={choice}
                  onChoice={submission.updateChoice}
                  access={access}
                  disabled={newChoicesLocked}
                  onManageModels={manageProviders}
                  onProvidersChanged={() => {
                    void refresh()
                  }}
                  onRead={refresh}
                  computer={computer}
                />
              </ComposerControl>
            </>
          ) : (
            summary && (
              <>
                {harnessInfo && (
                  <ComposerControl name="harness">
                    <SessionHarnessControl harness={harnessInfo} admin={access.admin} onNewSession={startNew} fork={fork} />
                  </ComposerControl>
                )}
                <ComposerControl name="permission">
                  <ComposerPermission permission={composerPermission} />
                </ComposerControl>
                <ComposerControl name="model">
                  <SessionModelControl
                    withLevel
                    catalog={catalog}
                    harness={harnessInfo}
                    model={effectiveModel}
                    current={currentModel}
                    reported={summary.model}
                    onModel={switchSessionModel}
                    config={current?.config ?? []}
                    busy={configBusy.get(summary.id) ?? null}
                    {...(configFeedback.get(summary.id) ? { feedback: configFeedback.get(summary.id)! } : {})}
                    onRefresh={refreshConfig}
                    onConfig={setConfig}
                    onManageModels={manageProviders}
                    locked={gate.kind === 'read-only' ? gate.text : undefined}
                    route={summary.modelRoute}
                    computer={computer}
                  />
                </ComposerControl>
              </>
            )
          )
        }
        trailing={
          !showControls || !catalog || (selectedId !== null && !summary) ? null : (
            <>{phone && selectedId !== null && <MoreMenu options={otherOptions} disabled={newChoicesLocked} onOption={chooseOption} />}</>
          )
        }
      />
    </>
  )
  // The start page asks first, over its input; a session's input, and the start's input held under a pending send, do not.
  if (!home || pendingInTranscript)
    return (
      <>
        {!home && visible && shell.showCreatorDraft && !(shell.panelVisible && shell.panelSelected === 'changes') && (
          <div data-draft-place="conversation" ref={shell.setCreatorDraftTarget} />
        )}
        {composer}
        {replacement && mayAskSide && sidePanel && (
          <ReplaceSideQuestionDialog
            phase={sidePanel.phase}
            onKeep={() => setReplaceSide(undefined)}
            onReplace={() => {
              const firstStatus = shell.snapshot.tasks.find(task => task.id === sidePanel.forkId)?.status
              const sent = askSideQuestion(mayAskSide, replacement.question, projectFor(catalog, mayAskSide.summary), shell.active, {
                requestId: replacement.requestId,
                status: firstStatus,
              })
              setReplaceSide(undefined)
              if (sent) setSubmissionDraft('')
            }}
          />
        )}
      </>
    )
  return (
    <>
      <HomeHeadline shell={base} />
      {composer}
    </>
  )
}

export function SetupNotices({ shell }: { shell: ShellState }) {
  const { catalog, access, owner, submission, block, setupTrigger, openSettings, refresh, chosenHarness, choice } = shell
  return (
    <>
      <DraftLoginNotice
        harness={loginHarness(catalog, chosenHarness, choice.config)}
        allowed={access.scopes.has('run')}
        surface={loginSurface(catalog?.features)}
        onRead={refresh}
      />
      {/* A move to another Harness says itself on the line over the input, with its own way back. */}
      {submission.fork && !submission.fork.moved && (
        <InlineNotice
          tone="neutral"
          className="fork-notice"
          action={
            <Button size="xs" variant="ghost" onClick={() => submission.setFork(null)}>
              {SHELL_COPY.cancelFork}
            </Button>
          }>
          <Hint
            lead={<Icon icon={GitFork} size={14} />}
            label={
              <VisibleText
                text={
                  submission.fork.moved
                    ? COMPOSER_COPY.moved(submission.fork.title ?? submission.fork.taskId)
                    : submission.fork.upToMessageId
                      ? COMPOSER_COPY.fork(submission.fork.title ?? submission.fork.taskId)
                      : COMPOSER_COPY.editFirst(submission.fork.title ?? submission.fork.taskId)
                }
              />
            }>
            {SHELL_COPY.forkFiles}
          </Hint>
          {submission.forkMissed.map(line => (
            <span key={line} className="fork-missed">
              {line}
            </span>
          ))}
        </InlineNotice>
      )}
      {nothingInstalled(block, catalog, access) ? (
        <HarnessInstallCard
          access={access}
          onRecheck={refresh}
          onSettings={() => {
            openSettings('providers')
          }}
          onSaved={(model: ModelRef) => {
            submission.updateChoice({ model })
            void refresh()
          }}
        />
      ) : (
        block && (
          <SetupCard
            triggerRef={setupTrigger}
            block={block}
            owner={owner}
            providers={
              owner && catalog
                ? {
                    access,
                    onSettings: () => openSettings('providers'),
                    onSaved: (model: ModelRef) => {
                      submission.updateChoice({ model })
                      void refresh()
                    },
                  }
                : undefined
            }
            onSetup={() => {
              openSettings(block.kind === 'model-required' ? 'providers' : catalog ? 'engines' : 'plugins')
            }}
          />
        )
      )}
    </>
  )
}
