import { Info, ShieldAlert } from 'lucide-react'
import type { ModelRef, SessionConfigOption } from '@latch/protocol'
import { Button, Collapse, Icon, InlineNotice } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { engineLimitNote, fullAccessStartNote, harnessName, sameModel } from '../composerChoice.ts'
import { APPROVAL_COPY, CODE_ROOT_COPY } from '../core/securityCopy.ts'
import { projectOf } from '../sessions.ts'
import { scopedTemplates } from '../hooks/usePromptTemplates.ts'
import { ApprovalDrawer } from '../composer/ApprovalDrawer.tsx'
import { Composer } from '../composer/Composer.tsx'
import { AgentChip, BranchLabel, FoldMenu, MoreMenu, UsageRing } from '../composer/Footer.tsx'
import { DraftModelControl, SessionModelControl } from '../composer/ModelControl.tsx'
import { PermissionChip } from '../composer/PermissionChip.tsx'
import { agentModelControls } from '../composer/modelReasoning.ts'
import { contextUse, permissionView } from '../composer/permission.ts'
import { QuestionDrawer, useQuestionDrawer } from '../composer/QuestionDrawer.tsx'
import { QueueDrawer } from '../composer/QueueDrawer.tsx'
import { WorkspaceRecovery } from '../composer/WorkspaceRecovery.tsx'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { ModeSwitch, ProjectPicker } from '../components/Pickers.tsx'
import { EngineQuestion, SetupCard } from '../newSession/NewSession.tsx'
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

/** The new-session page's question: the project is an inline picker, and with none the footer offers one. */
export function NewSessionTitle({ shell }: { shell: ShellState }) {
  const { personalDraft, catalog, choice, submission, newChoicesLocked, access, owner, openSettings, createProject } = shell
  if (personalDraft) return <>和{personalDraft.name}聊聊</>
  const project =
    choice.mode !== 'chat' ? catalog?.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default') : undefined
  if (!catalog || !project)
    return (
      <>
        要做什么<span className="new-session-mark">？</span>
      </>
    )
  return (
    <>
      在{' '}
      <ProjectPicker
        access={access}
        catalog={catalog}
        value={choice.workspaceId}
        disabled={newChoicesLocked}
        harness={catalog.harnesses.find(item => item.id === choice.harnessId)}
        inline
        onManage={owner ? () => openSettings('workspaces') : undefined}
        onCreate={createProject}
        onChange={workspaceId => {
          submission.updateChoice({ workspaceId })
        }}
      />{' '}
      里做什么<span className="new-session-mark">？</span>
    </>
  )
}

/** The input of the open session, or of the new-session page. */
export function SessionComposer({ shell }: { shell: ShellState }) {
  const {
    openPersonal,
    personalDraft,
    startsL3,
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
    presenceDown,
    startReason,
    coarse,
    preferences,
    phone,
    promptTemplates,
    openSettings,
    manageProviders,
    createProject,
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
  const permission =
    selectedId === null || !summary
      ? undefined
      : permissionView({
          harness: harnessInfo,
          ...(current?.permission ? { permission: current.permission } : {}),
          config: current?.config ?? [],
          access,
          ...(gate.kind === 'open' ? {} : { locked: gate.kind === 'read-only' ? gate.text : '该会话不再接受输入。' }),
        })
  const chooseOption = (option: SessionConfigOption, value: string) => {
    if (configBusy.has(selectedId ?? '')) return
    void Promise.resolve(setConfig(option.id, value))
  }
  // An agent's model control holds these when it has one, so they appear once.
  const otherOptions =
    harnessInfo?.models !== 'host' && agentModelControls(current?.config ?? []).primary
      ? []
      : (current?.config ?? []).filter(option => option.category === 'model_config')
  const use = selectedId === null ? undefined : contextUse(current?.usageReport)
  const branch = selectedId === null ? undefined : summary?.branch
  const chatOnly =
    selectedId === null && !personalDraft
      ? (() => {
          const harness = catalog?.harnesses.find(item => item.id === choice.harnessId)
          return harness?.modes.includes('chat') && harness.modes.includes('agent')
            ? {
                value: choice.mode === 'chat',
                onChange: (value: boolean) => {
                  submission.updateChoice({ mode: value ? 'chat' : 'agent' })
                },
              }
            : undefined
        })()
      : undefined
  const engineNote = catalog && block === null && choice.mode !== 'chat' ? engineLimitNote(catalog, access) : undefined
  const fullAccessNote = selectedId === null && !personalDraft && startsL3 && chosenHarness ? fullAccessStartNote(chosenHarness) : undefined
  const noProject =
    selectedId === null
    && catalog
    && !personalDraft
    && choice.mode !== 'chat'
    && (choice.workspaceId === undefined || choice.workspaceId === 'default')
  const showControls = selectedId === null ? !personalDraft : !!summary && !summary.personal && gate.kind === 'open'
  const drawers = (
    <>
      {current && workspaceChanged.has(current.summary.id) && (
        <WorkspaceRecovery
          source={current}
          workspaces={catalog?.workspaces ?? []}
          workspaceId={recoveryProjects.get(current.summary.id)}
          onWorkspaceChange={workspaceId => setRecoveryProjects(previous => new Map(previous).set(current.summary.id, workspaceId))}
          forkSupported={catalog?.features?.fork === true}
          local={access.local}
          harness={harnessInfo}
          runGate={
            access.scopes.has('run') && harnessInfo?.status === 'ready'
              ? { allowed: true }
              : { allowed: false, reason: '请先恢复发起会话权限和可用的引擎。' }
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
          asker={harnessInfo ? harnessName(harnessInfo) : 'Agent'}
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
      commands={current?.commands}
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
      sending={submission.sending}
      error={noteComposer?.error || submission.error || (actionError?.sessionId === selectedId ? actionError.text : '')}
      onRetry={() => {
        void retryDraft()
      }}
      canSend={gate.kind === 'open' && (selectedId === null ? block === null && !presenceDown : sessionBlock === undefined)}
      blockReason={block?.message ?? sessionBlock ?? startReason}
      readOnly={gate.kind === 'read-only' ? gate.text : gate.kind === 'stopped' ? placeholder : undefined}
      {...(answer ? { answer } : {})}
      drawers={drawers}
      stepBack={approvals.length > 0 || answersQuestion}
      below={
        selectedId === null && catalog && !personalDraft ? (
          <>
            {/* Captions open under the input like disclosures, so the input and everything above it stay put. */}
            <Collapse open={fullAccessNote !== undefined}>
              <p className="composer-notice" data-tint="warn" role="note">
                <Icon icon={ShieldAlert} size={14} />
                {fullAccessNote}
              </p>
            </Collapse>
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
            <Collapse open={engineNote !== undefined}>
              <p className="composer-engine-note" role="note">
                {engineNote}
              </p>
            </Collapse>
          </>
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
      queueable={canQueue && !answer}
      inline={phone && selectedId !== null}
      meta={
        showControls && !phone ? (
          <>
            {noProject && catalog && (
              <ProjectPicker
                access={access}
                catalog={catalog}
                harness={catalog.harnesses.find(item => item.id === choice.harnessId)}
                value={undefined}
                disabled={newChoicesLocked}
                onManage={owner ? () => openSettings('workspaces') : undefined}
                onCreate={createProject}
                onChange={workspaceId => {
                  submission.updateChoice({ workspaceId })
                }}
              />
            )}
            {branch && <BranchLabel branch={branch} />}
            {use && <UsageRing use={use} />}
            <MoreMenu chatOnly={chatOnly} options={otherOptions} disabled={newChoicesLocked} onOption={chooseOption} />
            <FoldMenu
              permission={permission}
              branch={branch}
              use={use}
              options={otherOptions}
              chatOnly={chatOnly}
              disabled={newChoicesLocked}
              onOption={chooseOption}
            />
          </>
        ) : undefined
      }
      controls={
        selectedId === null && personalDraft ? (
          <Button variant="ghost" onClick={() => openPersonal?.()}>
            {personalDraft.name}
          </Button>
        ) : !showControls ? null : !catalog ? (
          selectedId === null ? (
            <ModeSwitch
              value={choice.mode}
              disabled={newChoicesLocked}
              onChange={mode => {
                submission.updateChoice({ mode })
              }}
            />
          ) : null
        ) : (
          <>
            <AgentChip />
            {selectedId === null ? (
              <DraftModelControl
                catalog={catalog}
                choice={choice}
                onChoice={submission.updateChoice}
                access={access}
                disabled={newChoicesLocked}
                onManageEngines={manageEngines}
                onManageModels={manageProviders}
                onProvidersChanged={() => {
                  void refresh()
                }}
                onEngineAdded={agent => {
                  submission.updateChoice({ harnessId: agent.id, mode: 'agent' })
                  void refresh()
                }}
              />
            ) : (
              summary && (
                <SessionModelControl
                  catalog={catalog}
                  harness={harnessInfo}
                  model={effectiveModel}
                  current={currentModel}
                  onModel={model => {
                    submission.setOverride(summary.id, model && sameModel(model, currentModel) ? undefined : model)
                    if (model) setToast({ text: `下一轮起用 ${model.model}`, tone: 'ok' })
                  }}
                  config={current?.config ?? []}
                  busy={configBusy.get(summary.id) ?? null}
                  {...(configFeedback.get(summary.id) ? { feedback: configFeedback.get(summary.id)! } : {})}
                  onRefresh={refreshConfig}
                  onConfig={setConfig}
                  permission={permission}
                  onManageEngines={manageEngines}
                  onManageModels={manageProviders}
                />
              )
            )}
            {permission?.chip && <PermissionChip view={permission} onChoose={chooseOption} />}
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
    access,
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
    presenceDown,
    startReason,
    startsL3,
    chosenHarness,
    coarse,
    preferences,
    sheetComposerRef,
    promptTemplates,
  } = shell
  const engineNote = catalog && block === null && choice.mode !== 'chat' ? engineLimitNote(catalog, access) : undefined
  const fullAccessNote = startsL3 && chosenHarness ? fullAccessStartNote(chosenHarness) : undefined
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
      canSend={gate.kind === 'open' && block === null && !presenceDown}
      blockReason={block?.message ?? startReason}
      readOnly={gate.kind === 'read-only' ? gate.text : undefined}
      below={
        codeRootChoice || engineNote || fullAccessNote ? (
          <>
            {fullAccessNote && (
              <p className="composer-notice" data-tint="warn" role="note">
                {fullAccessNote}
              </p>
            )}
            {codeRootChoice && (
              <p className="composer-notice" role="note">
                {CODE_ROOT_COPY.notice}
              </p>
            )}
            {engineNote && (
              <p className="composer-engine-note" role="note">
                {engineNote}
              </p>
            )}
          </>
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
  const { catalog, access, owner, submission, block, choice, setupTrigger, openSettings, refresh } = shell
  return (
    <>
      {submission.fork && (
        <InlineNotice tone="neutral">
          正在从「{submission.fork.title ?? submission.fork.taskId}」分叉。文件不会复制或回滚；同一项目中的会话共用项目文件夹。
          <Button size="xs" variant="ghost" onClick={() => submission.setFork(null)}>
            取消分叉
          </Button>
        </InlineNotice>
      )}
      {block?.kind === 'engine-required' && catalog && (
        <EngineQuestion catalog={catalog} access={access} choice={choice} onChoice={submission.updateChoice} />
      )}
      {block && block.kind !== 'engine-required' && (
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
      )}
    </>
  )
}
