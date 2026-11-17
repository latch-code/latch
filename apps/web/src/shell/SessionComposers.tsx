import { FAILURE_ACTION_LABEL, failureAction, type FailureStep } from '../conversation/failureAction.ts'
import { Eraser, GitFork } from 'lucide-react'
import { NOT_ACCEPTED_5XX, type ModelRef, type SessionConfigOption, type TaskSummary } from '@latch/protocol'
import { Button, Collapse, Hint, Icon, InlineNotice, FolderGlyph, HistoryGlyph, ShieldAlertGlyph, LaptopGlyph, Drawer } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
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
import { forkSource } from '../forkChoice.ts'
import { APPROVAL_COPY, CODE_ROOT_COPY, computerName } from '../core/securityCopy.ts'
import { DEVICE_OFFLINE } from '../core/hostState.ts'
import { projectOf } from '../sessions.ts'
import { seedWaiting } from '../history/model.ts'
import { basename } from '../format.ts'
import { scopedTemplates } from '../hooks/usePromptTemplates.ts'
import { useHarnessCommands } from '../hooks/useHarnessCommands.ts'
import { ApprovalDrawer } from '../composer/ApprovalDrawer.tsx'
import { Composer } from '../composer/Composer.tsx'
import { CodexTeam } from '../composer/CodexTeam.tsx'
import { HarnessLimitChip, ServiceBudgetChip } from '../usage/UsageChip.tsx'
import { ComposerControl, openControlWhenShown } from '../composer/ComposerControl.tsx'
import { composerActions } from './composerActions.ts'
import { MoreMenu } from '../composer/Footer.tsx'
import { FolderControl } from '../composer/FolderControl.tsx'
import { BranchSegment, ComposerStatus, FolderSegment, statusRoute } from '../composer/ComposerStatus.tsx'
import { SessionVitalsLine } from '../composer/VitalsStrip.tsx'
import { DraftHarnessControl, FORK_BUSY, SessionHarnessControl, type SessionFork } from '../composer/ModelControl.tsx'
import { DraftModelControl, DraftThinkingControl, SessionModelControl, SessionThinkingControl } from '../composer/ModelPanel.tsx'
import { PermissionChip } from '../composer/PermissionChip.tsx'
import { composerOptions, configUnknownBar, modelWords, ownModelName } from '../composer/modelReasoning.ts'
import { draftPermission, draftRead, permissionView } from '../composer/permission.ts'
import { helperPermissionBlocked } from '../agents/personWords.ts'
import { readOnSelect, readsOnPermission, useReading } from '../composer/harnessCatalogue.tsx'
import { QuestionDrawer, useQuestionDrawer } from '../composer/QuestionDrawer.tsx'
import { QueueDrawer } from '../composer/QueueDrawer.tsx'
import { WorkspaceRecovery } from '../composer/WorkspaceRecovery.tsx'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { ModeSwitch, ProjectPicker } from '../components/Pickers.tsx'
import { HarnessInstallCard, SetupCard } from '../newSession/NewSession.tsx'
import { DraftLoginNotice } from '../components/HarnessLogin.tsx'
import { loginSurface } from '../panel/terminal/loginRuns.ts'
import { SendingMessage } from '../components/SendingMessage.tsx'
import { askSideQuestion, sideQuestionBlock, sideQuestionOf, sideQuestionRefusal } from '../conversation/SideQuestion.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { speakerOf } from '../agents/model.ts'
import { RouteWarning } from '../agents/parts.tsx'

/** The message on its way, until the Host lists it. */
export function SendingBubble({ shell }: { shell: ShellState }) {
  const { sendingView } = shell
  if (!sendingView) return null
  return <SendingMessage key={sendingView.submission.requestId} view={sendingView} />
}

/** On a phone the input has no room for the part after the two spaces, which teaches @ and /. */
const phoneWords = (words: string) => words.split('  ')[0]!

/** The home input's project: the one chosen, or 不选项目, which starts in the Host's default folder. */
function HomeProject({ shell }: { shell: ShellState }) {
  const { catalog, choice, newChoicesLocked, access, owner, openSettings, createProject, projectAsk, chooseProject } = shell
  if (!catalog) return '新会话'
  const project = catalog.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')
  return (
    <ProjectPicker
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
      onClosed={projectAsk.clearNotice}
    />
  )
}

/**
 * Where a session outside a saved project works, as 设置 names it: the Host's 默认文件夹 (不选项目 there, for a session or
 * one of 我的 Agent), never that folder's own name; a folder of its own goes by its name.
 */
export function placeName(summary: Pick<TaskSummary, 'cwd' | 'workspaceId' | 'sessionFolder'>): string | undefined {
  if (!summary.cwd) return undefined
  return summary.workspaceId === 'default' && !summary.sessionFolder ? '默认文件夹' : basename(summary.cwd)
}

/** The sentence a fork's input starts with, as a fork from a turn's footer does. */
const FORK_PROMPT = '请接着这个会话继续。'

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
export function SessionComposer({ shell: base, home = false }: { shell: ShellState; home?: boolean }) {
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
  // A text rebuild sends its rebuilt conversation with the first message, to the service that answers it.
  const seedService =
    current && current.summary.id === selectedId && seedWaiting(current.summary, current.messages)
      ? (current.summary.providerId && shell.providerName(current.summary.providerId))
        || `${harnessInfo ? harnessName(harnessInfo) : 'Harness'} 用的模型服务`
      : undefined
  // Latch's own sentences name the computer on any page but the Latch app on it.
  const computer = access.local ? undefined : computerName(shell.snapshot.hostName)
  const lastMessage = current?.summary.id === selectedId ? current?.messages.at(-1) : undefined
  // The latest turn into a new session, where the Host can fork and this device may start one. The Host refuses a turn
  // that has not ended, so the row says to wait instead.
  const fork: SessionFork | undefined =
    current && lastMessage && catalog?.features?.fork === true && access.scopes.has('run')
      ? {
          ...(shell.active ? { blocked: FORK_BUSY } : {}),
          onFork: () => {
            const draft = submission.draft.trim() ? submission.draft : FORK_PROMPT
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
        }
      : undefined
  const questionActions = {
    deviceId: shell.snapshot.device.id,
    canAnswer: gate.kind === 'open' && sessionBlock === undefined,
    onChanged: refresh,
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
        )
      : !summary
        ? undefined
        : permissionView({
            harness: harnessInfo,
            mode: summary.mode,
            ...(current?.permission ? { permission: current.permission } : {}),
            config: current?.config ?? [],
            access,
            ...(gate.kind === 'open' ? {} : { locked: gate.kind === 'read-only' ? gate.text : '该会话不再接受输入。' }),
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
    if (model) setToast({ text: `下一轮起用 ${modelWords(model)}`, tone: 'ok' })
  }
  const otherOptions = composerOptions(current?.config ?? [], harnessInfo?.capabilities.models.owner === 'latch')
  // A new-context send that did not start has cleared it on the Host already: there is nothing left to keep.
  const hostCleared = current?.contextCleared === true && current.summary.id === selectedId
  // A topic of 我的 Agent talks to the helper: the input, ＋ and send only. Its model, thinking and permission are the
  // helper's settings, and what the permission means for safety stays in its frame (TopicFrame), not here.
  const speaker = selectedId !== null ? speakerOf(shell.snapshot, summary) : undefined
  const showControls = speaker === undefined && (selectedId === null || (!!summary && !summary.personal && gate.kind !== 'stopped'))
  const permissionChange = selectedId !== null ? configFeedback.get(selectedId) : undefined
  const permissionBlocked =
    selectedId !== null && helperPermissionBlocked(current, permissionChange?.kind === 'unknown' ? permissionChange.configId : undefined)
  const worktreeOffer = selectedId === null ? worktreeProject(catalog, choice, submission.fork !== null) : undefined
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
        />
      ) : project && choice.mode !== 'chat' ? (
        <>
          <FolderSegment name={project.name || basename(project.path)} tip={`项目 ${project.name || basename(project.path)}`} />
          {project.branch && <BranchSegment branch={project.branch} />}
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
            : { allowed: false, reason: '请先恢复发起会话权限和可用的 Harness。' }
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
        rejectLabel={noteComposer?.rejectLabel}
        {...(run ? { onStop: run.onCancel } : {})}
      />
    ),
    selectedId !== null && (submission.clearing || hostCleared) && (
      <Drawer key="clearing" className="clearing-drawer" label="清空上下文">
        <Icon icon={Eraser} size={14} />
        <p role="status">
          <strong>下一条消息开始新的上下文</strong>
          {hostCleared && <span>上下文已经清空</span>}
        </p>
        {!hostCleared && (
          <Button size="xs" onClick={() => shell.armClear(false)}>
            保留上下文
          </Button>
        )}
      </Drawer>
    ),
    selectedId !== null && current?.queue && current.queue.length > 0 && (
      <QueueDrawer
        key={`queue:${selectedId}`}
        sessionId={selectedId}
        items={current.queue}
        canSend={gate.kind === 'open' && sessionBlock === undefined && !submission.pending && shell.connection !== 'offline'}
        canRemove={access.scopes.has('run')}
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
            onSubmit: () => {
              if (!sideQuestion) return
              setSubmissionDraft('')
              void askSideQuestion(current, sideQuestion, projectFor(catalog, current.summary), shell.active)
            },
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
  return (
    <Composer
      showSlashButton={speaker === undefined}
      textareaRef={composerRef}
      lastPrompt={current?.messages.findLast(message => message.role === 'user')?.text}
      attachments={catalog?.features?.attachments === true && gate.kind === 'open' && !answer ? attachmentDraft : undefined}
      fileMentions={mentionChoice}
      commands={selectedId === null ? cachedCommands?.commands : current?.commands}
      skills={selectedId === null ? cachedCommands?.skills : current?.skills}
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
      actions={composerActions(shell)}
      onCreateTemplate={owner ? () => openSettings('general') : undefined}
      historyScope={{ deviceId: shell.snapshot.device.id, harnessId: selectedId === null ? choice.harnessId : summary?.harnessId }}
      templates={scopedTemplates(
        promptTemplates,
        selectedId === null
          ? (choice.workspaceId ?? catalog?.defaults.workspaceId)
          : summary && catalog
            ? projectOf(summary, catalog.workspaces)?.id
            : undefined,
        selectedId === null ? choice.harnessId : summary?.harnessId,
      )}
      variant={selectedId === null ? 'new' : 'session'}
      label={noteComposer ? APPROVAL_COPY.rejectPlaceholder : selectedId === null ? '新会话消息' : '继续对话'}
      placeholder={home ? '想让 Agent 做什么？' : phone ? phoneWords(words) : words}
      draft={submission.draft}
      onDraft={setSubmissionDraft}
      pending={submission.pending}
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
      error={noteComposer?.error || refusal || (actionError?.sessionId === selectedId ? actionError.text : '') || (sideBlocked ?? '')}
      {...(!noteComposer?.error && refusal
        ? composerFailure(submission.errorCode, owner, openSettings, () => {
            void sendDraft()
          })
        : {})}
      pendingReason={offline ? DEVICE_OFFLINE : submission.pendingReason}
      onRetry={() => {
        void retryDraft()
      }}
      onAbandon={() => {
        void abandonPending()
      }}
      abandoning={abandoning}
      abandonHeld={submission.sendingElsewhere ? '另一个窗口正在重试' : undefined}
      pendingNote={
        pendingQueued === 'waiting' ? '队列里有同样的一条在等待' : pendingQueued === 'parked' ? '队列里有同样的一条已暂停' : undefined
      }
      canSend={
        !offline
        && gate.kind === 'open'
        && (selectedId === null ? block === null : sessionBlock === undefined)
        && !sideBlocked
        && !permissionBlocked
      }
      blockReason={offline ? DEVICE_OFFLINE : (block?.message ?? sessionBlock ?? sideBlocked)}
      readOnly={
        gate.kind === 'read-only'
          ? gate.text
          : gate.kind === 'stopped'
            ? placeholder
            : permissionBlocked
              ? '权限没确认，暂不能发送'
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
      locationPosition={home && phone ? 'toolbar' : 'top'}
      location={
        home ? (
          <div className="home-composer-location">
            <HomeProject shell={base} />
            {worktreeOffer && (
              <FolderControl
                project={worktreeOffer}
                worktree={submission.worktree}
                onWorktree={submission.setWorktree}
                disabled={newChoicesLocked}
                branch={catalog?.workspaces.find(item => item.id === choice.workspaceId)?.branch}
                starts
              />
            )}
            {phone && (
              <span className="home-composer-computer">
                <Icon icon={LaptopGlyph} size={14} />
                {computerName(base.snapshot.hostName)}
              </span>
            )}
          </div>
        ) : undefined
      }
      below={
        selectedId === null && catalog ? (
          <>
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
          <p className="composer-notice composer-seed" data-tint="warn" role="note">
            <Icon icon={HistoryGlyph} size={14} />
            <span>
              按文字重建，不是原样恢复 · 第一条消息会把重建的对话文字一起发给 <VisibleText text={seedService} />
            </span>
          </p>
        ) : undefined
      }
      vitalsLead={
        !seedService && current && selectedId === current.summary.id ? (
          <CodexTeam
            key={current.summary.id}
            detail={current}
            draft={submission.draft}
            canPrepare={
              gate.kind === 'open'
              && !shell.active
              && !sessionBlock
              && !sideBlocked
              && !permissionBlocked
              && !answer
              && !submission.pending
              && !submission.sending
            }
            onPrepare={value => {
              setSubmissionDraft(value)
              requestAnimationFrame(() => composerRef.current?.focus())
            }}
            onApproval={selectApproval}
            run={run}
          />
        ) : undefined
      }
      confirmation={
        <InlineConfirm active={submission.sending || (selectedId !== null && configBusy.has(selectedId))} className="composer-confirm" />
      }
      onSubmit={() => {
        void sendDraft()
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
      queueable={canQueue && !answer}
      steerable={steer && !answer}
      inline={phone}
      meta={!showControls || phone ? undefined : <MoreMenu options={otherOptions} disabled={newChoicesLocked} onOption={chooseOption} />}
      // The limit arrives seconds after a turn starts and leaves with the Host's memory: last before send at every width,
      // so the controls before it stay where they are.
      usage={showControls ? usageChip : undefined}
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
            <ComposerControl name="model">
              <DraftModelControl
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
                  <SessionHarnessControl harness={harnessInfo} onNewSession={startNew} fork={fork} />
                </ComposerControl>
              )}
              <ComposerControl name="model">
                <SessionModelControl
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
          <>
            <ComposerControl name="thinking">
              {selectedId === null ? (
                <DraftThinkingControl
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
              ) : (
                <SessionThinkingControl
                  catalog={catalog}
                  harness={harnessInfo}
                  model={effectiveModel}
                  current={currentModel}
                  onModel={switchSessionModel}
                  config={current?.config ?? []}
                  busy={configBusy.get(selectedId) ?? null}
                  {...(configFeedback.get(selectedId) ? { feedback: configFeedback.get(selectedId)! } : {})}
                  onRefresh={refreshConfig}
                  onConfig={setConfig}
                  onManageModels={manageProviders}
                  locked={gate.kind === 'read-only' ? gate.text : undefined}
                  route={summary?.modelRoute}
                  reported={summary?.model}
                  computer={computer}
                />
              )}
            </ComposerControl>
            <ComposerControl name="permission">
              {permission ? (
                <PermissionChip
                  view={permission}
                  onChoose={chooseOption}
                  // A draft's modes come from the same read as its model list, so opening this first asks as well.
                  {...(selectedId === null && !newChoicesLocked
                    ? {
                        onOpenChange: (open: boolean) => {
                          if (open && readsOnPermission(chosenHarness, access)) readOnSelect(chosenHarness, refresh)
                        },
                      }
                    : {})}
                />
              ) : (
                <button type="button" className="chip chip-permission" disabled>
                  <span className="chip-text">权限</span>
                </button>
              )}
            </ComposerControl>
            {phone && selectedId !== null && <MoreMenu options={otherOptions} disabled={newChoicesLocked} onOption={chooseOption} />}
          </>
        )
      }
    />
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
      {submission.fork && (
        <InlineNotice
          tone="neutral"
          className="fork-notice"
          action={
            <Button size="xs" variant="ghost" onClick={() => submission.setFork(null)}>
              取消分叉
            </Button>
          }>
          <Hint
            lead={<Icon icon={GitFork} size={14} />}
            label={<VisibleText text={`从「${submission.fork.title ?? submission.fork.taskId}」分叉`} />}>
            文件不会复制或回滚；同一项目中的会话共用项目文件夹。
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
