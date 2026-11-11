import type { ReactNode } from 'react'
import { Eraser, Info, ShieldAlert } from 'lucide-react'
import type { ModelRef, SessionConfigOption } from '@latch/protocol'
import { Button, Collapse, Icon, InlineNotice } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { draftConfig, harnessName, nothingInstalled, sameModel, worktreeProject } from '../composerChoice.ts'
import { forkSource } from '../forkChoice.ts'
import { APPROVAL_COPY, CODE_ROOT_COPY } from '../core/securityCopy.ts'
import { projectOf } from '../sessions.ts'
import { scopedTemplates } from '../hooks/usePromptTemplates.ts'
import { ApprovalDrawer } from '../composer/ApprovalDrawer.tsx'
import { Composer } from '../composer/Composer.tsx'
import { BranchLabel, MoreMenu, UsageRing } from '../composer/Footer.tsx'
import { FolderControl, WorktreeLabel } from '../composer/FolderControl.tsx'
import { DraftHarnessControl, DraftModelControl, SessionHarnessControl, SessionModelControl } from '../composer/ModelControl.tsx'
import { PermissionChip } from '../composer/PermissionChip.tsx'
import { DraftThinkingControl, SessionThinkingControl } from '../composer/ThinkingControl.tsx'
import { composerOptions, modelWords } from '../composer/modelReasoning.ts'
import { contextUse, draftPermission, draftRead, permissionView } from '../composer/permission.ts'
import { readOnSelect, readsOnPermission, useReading } from '../composer/harnessCatalogue.tsx'
import { QuestionDrawer, useQuestionDrawer } from '../composer/QuestionDrawer.tsx'
import { QueueDrawer } from '../composer/QueueDrawer.tsx'
import { WorkspaceRecovery } from '../composer/WorkspaceRecovery.tsx'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { ModeSwitch, ProjectPicker } from '../components/Pickers.tsx'
import { HarnessInstallCard, SetupCard } from '../newSession/NewSession.tsx'
import { DraftLoginNotice } from '../components/HarnessLogin.tsx'
import { SendingMessage } from '../components/SendingMessage.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** The message on its way, until the Host lists it. */
export function SendingBubble({ shell }: { shell: ShellState }) {
  const { sendingView } = shell
  if (!sendingView) return null
  return <SendingMessage key={sendingView.submission.requestId} view={sendingView} />
}

/** On a phone the input has no room for the part after the two spaces, which teaches @ and /. */
const phoneWords = (words: string) => words.split('  ')[0]!

/** The new-session page's question: the project is a picker in it, named when there is one and offered when there is not. */
export function NewSessionTitle({ shell }: { shell: ShellState }) {
  const { catalog, choice, newChoicesLocked, access, owner, openSettings, createProject, projectAsk, chooseProject } = shell
  const question = (
    <>
      要做什么<span className="new-session-mark">？</span>
    </>
  )
  if (!catalog) return question
  const project = catalog.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')
  const picker = (
    <ProjectPicker
      access={access}
      catalog={catalog}
      value={project?.id ?? (choice.projectSkipped ? 'default' : undefined)}
      disabled={newChoicesLocked}
      harness={catalog.harnesses.find(item => item.id === choice.harnessId)}
      inline={project !== undefined}
      onManage={owner ? () => openSettings('workspaces') : undefined}
      onCreate={createProject}
      onChange={chooseProject}
      openRequest={projectAsk.request}
      notice={projectAsk.notice}
      onClosed={projectAsk.clearNotice}
    />
  )
  if (project)
    return (
      <>
        在 {picker} 里做什么<span className="new-session-mark">？</span>
      </>
    )
  return (
    <span className="new-session-question">
      <span>{question}</span>
      {picker}
    </span>
  )
}

/**
 * One of the composer's four controls, named for what a key that opens it looks for: the trigger is the button inside.
 * The pickers come from `@latch/ui` and draw their own trigger, so the name sits on this wrapper.
 */
function ComposerControl({ name, children }: { name: 'harness' | 'model' | 'thinking' | 'permission'; children: ReactNode }) {
  return (
    <div className="composer-control" data-composer-control={name}>
      {children}
    </div>
  )
}

/** The input of the open session, or of the new-session page. */
export function SessionComposer({ shell }: { shell: ShellState }) {
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
    setConfig,
    refreshConfig,
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
    setNewSheet,
    sheetComposerRef,
  } = shell
  const manageEngines = owner ? () => openSettings('engines') : undefined
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
          draftConfig(chosenHarness, choice.config)?.config,
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
  const use = selectedId === null ? undefined : contextUse(current?.usageReport)
  // A new-context send that did not start has cleared it on the Host already: there is nothing left to keep.
  const hostCleared = current?.contextCleared === true && current.summary.id === selectedId
  const branch =
    selectedId === null
      ? catalog?.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')?.branch
      : summary?.branch
  const showControls = selectedId === null || (!!summary && !summary.personal && gate.kind !== 'stopped')
  const worktreeOffer = selectedId === null ? worktreeProject(catalog, choice, submission.fork !== null) : undefined
  const drawers = (
    <>
      {current && workspaceChanged.has(current.summary.id) && (
        <WorkspaceRecovery
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
            choose(null)
            submission.setFork({
              taskId,
              upToMessageId,
              title: current.summary.title,
              choice: { harnessId: current.summary.harnessId, workspaceId, mode: current.summary.mode ?? 'agent' },
              source: forkSource(current, harnessInfo),
            })
            submission.setDraft(draft)
            if (phone) setNewSheet(true)
            requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
          }}
        />
      )}
      {asked && (
        <QuestionDrawer
          state={asked}
          asker={harnessInfo ? harnessName(harnessInfo) : 'Harness'}
          canAnswer={questionActions.canAnswer}
          onOther={() => {
            earlierDraft.release()
            composerRef.current?.focus()
          }}
        />
      )}
      {approvals.length > 0 && (
        <ApprovalDrawer
          approvals={approvals}
          messages={current?.messages ?? []}
          index={approvalIndex}
          onIndex={setApprovalIndex}
          gateFor={gateFor}
          busy={approvalBusy}
          statuses={statuses}
          onDecide={onDecide}
          rejectLabel={noteComposer?.rejectLabel}
          {...(run ? { onStop: run.onCancel } : {})}
        />
      )}
      {selectedId !== null && (submission.clearing || hostCleared) && (
        <section className="composer-drawer clearing-drawer" aria-label="清空上下文">
          <Icon icon={Eraser} size={14} />
          <p role="status">
            <strong>下一条消息开始新的上下文</strong>
            <span>
              {hostCleared ? '上下文已经清空，' : ''}
              {harnessInfo ? harnessName(harnessInfo) : 'Harness'} 看不到之前的消息，记录仍留在这里。
            </span>
          </p>
          {!hostCleared && (
            <Button size="xs" onClick={() => shell.armClear(false)}>
              保留上下文
            </Button>
          )}
        </section>
      )}
      {selectedId !== null && current?.queue && current.queue.length > 0 && (
        <QueueDrawer
          key={selectedId}
          sessionId={selectedId}
          items={current.queue}
          canSend={gate.kind === 'open' && sessionBlock === undefined && !submission.pending}
          canRemove={access.scopes.has('run')}
          onChanged={refresh}
        />
      )}
    </>
  )
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
      : undefined
  return (
    <Composer
      textareaRef={composerRef}
      lastPrompt={current?.messages.findLast(message => message.role === 'user')?.text}
      attachments={catalog?.features?.attachments === true && gate.kind === 'open' && !answer ? attachmentDraft : undefined}
      fileMentions={mentionChoice}
      commands={shell.active ? current?.commands?.filter(command => !command.idleOnly) : current?.commands}
      {...(shell.clearable && !shell.active
        ? {
            actions: [
              {
                name: 'clear',
                description: '清空上下文：之后的消息从头开始，记录仍留在这里',
                run: () => shell.armClear(true),
              },
            ],
          }
        : {})}
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
      placeholder={phone ? phoneWords(words) : words}
      draft={submission.draft}
      onDraft={setSubmissionDraft}
      pending={submission.pending}
      {...(pendingHome === undefined || pendingHome === selectedId
        ? {}
        : {
            onOpenPending: () => {
              choose(pendingHome)
              if (phone && pendingHome === null) setNewSheet(true)
            },
          })}
      sending={submission.sending}
      error={noteComposer?.error || submission.error || (actionError?.sessionId === selectedId ? actionError.text : '')}
      onRetry={() => {
        void retryDraft()
      }}
      canSend={gate.kind === 'open' && (selectedId === null ? block === null : sessionBlock === undefined)}
      blockReason={block?.message ?? sessionBlock}
      readOnly={gate.kind === 'read-only' ? gate.text : gate.kind === 'stopped' ? placeholder : undefined}
      {...(answer ? { answer } : {})}
      drawers={drawers}
      stepBack={approvals.length > 0 || answersQuestion}
      below={
        <>
          {(worktreeOffer || branch || (selectedId !== null && summary?.worktree)) && (
            <div className="composer-context">
              {worktreeOffer && (
                <FolderControl
                  project={worktreeOffer}
                  worktree={submission.worktree}
                  onWorktree={submission.setWorktree}
                  disabled={newChoicesLocked}
                />
              )}
              {summary?.worktree && selectedId !== null ? (
                <WorktreeLabel branch={summary.branch ?? summary.worktree.branch} />
              ) : (
                branch && !(worktreeOffer && submission.worktree) && <BranchLabel branch={branch} />
              )}
            </div>
          )}
          {selectedId === null && catalog && (
            <>
              {/* Captions open under the input like disclosures, so the input and everything above it stay put. */}
              <Collapse open={codeRootChoice !== undefined}>
                <p className="composer-notice" data-tint="warn" role="note">
                  <Icon icon={ShieldAlert} size={14} />
                  {codeRootChoice && CODE_ROOT_COPY.notice}
                </p>
              </Collapse>
              <Collapse open={chosenScopeCaption !== undefined}>
                <p className="composer-notice" role="note">
                  <Icon icon={Info} size={14} />
                  <VisibleText text={chosenScopeCaption ?? ''} />
                </p>
              </Collapse>
            </>
          )}
        </>
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
      queueable={canQueue && !answer}
      steerable={steer && !answer}
      inline={phone && selectedId !== null}
      meta={
        showControls && !phone ? (
          <>
            {use && <UsageRing use={use} />}
            <MoreMenu options={otherOptions} disabled={newChoicesLocked} onOption={chooseOption} />
          </>
        ) : undefined
      }
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
              />
            </ComposerControl>
          </>
        ) : (
          summary && (
            <>
              {harnessInfo && (
                <ComposerControl name="harness">
                  <SessionHarnessControl harness={harnessInfo} onNewSession={startNew} />
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
                  onRead={refresh}
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
                  locked={gate.kind === 'read-only' ? gate.text : undefined}
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

/** Phones: the new-session sheet holds its own input, whose 开始 is in the sheet's header. */
export function SheetComposer({ shell }: { shell: ShellState }) {
  const {
    catalog,
    submission,
    choice,
    attachmentDraft,
    setSubmissionDraft,
    mentionChoice,
    sendDraft,
    retryDraft,
    block,
    gate,
    codeRootChoice,
    placeholder,
    coarse,
    preferences,
    sheetComposerRef,
    promptTemplates,
  } = shell
  return (
    <Composer
      textareaRef={sheetComposerRef}
      fileMentions={mentionChoice}
      attachments={catalog?.features?.attachments === true && gate.kind === 'open' ? attachmentDraft : undefined}
      templates={scopedTemplates(promptTemplates, choice.workspaceId ?? catalog?.defaults.workspaceId, choice.harnessId)}
      variant="sheet"
      label="新会话消息"
      placeholder={phoneWords(placeholder)}
      draft={submission.draft}
      onDraft={setSubmissionDraft}
      pending={submission.pending}
      sending={submission.sending}
      error={submission.error}
      onRetry={() => {
        void retryDraft()
      }}
      canSend={gate.kind === 'open' && block === null}
      blockReason={block?.message}
      readOnly={gate.kind === 'read-only' ? gate.text : undefined}
      below={
        codeRootChoice ? (
          <p className="composer-notice" role="note">
            {CODE_ROOT_COPY.notice}
          </p>
        ) : undefined
      }
      onSubmit={() => {
        void sendDraft()
      }}
      sendKey={preferences.sendKey}
      coarse={coarse}
      confirmation={<InlineConfirm active={submission.sending} rank={1} className="composer-confirm" />}
      controls={null}
    />
  )
}

export function SetupNotices({ shell }: { shell: ShellState }) {
  const { catalog, access, owner, submission, block, setupTrigger, openSettings, refresh, chosenHarness } = shell
  return (
    <>
      <DraftLoginNotice
        harness={chosenHarness?.status === 'ready' ? chosenHarness : undefined}
        allowed={access.scopes.has('run')}
        terminal={catalog?.features?.loginTerminal === true}
      />
      {submission.fork && (
        <InlineNotice tone="neutral">
          正在从「{submission.fork.title ?? submission.fork.taskId}」分叉。文件不会复制或回滚；同一项目中的会话共用项目文件夹。
          {chosenHarness?.capabilities.fork === 'native' && submission.fork.source?.harnessId === chosenHarness.id && (
            <span className="fork-own">
              在同一个文件夹里，{chosenHarness.capabilities.display.label}{' '}
              用它自己的记录分叉，带上到这一轮为止的完整上下文；做不到时改为以文字带上，并在会话里说明。
            </span>
          )}
          {submission.forkMissed.map(line => (
            <span key={line} className="fork-missed">
              {line}
            </span>
          ))}
          <Button size="xs" variant="ghost" onClick={() => submission.setFork(null)}>
            取消分叉
          </Button>
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
