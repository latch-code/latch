import { VisibleText } from '../components/VisibleText.tsx'
import { Info, ShieldAlert } from 'lucide-react'
import type { ModelRef } from '@latch/protocol'
import { entryKey } from '../composerChoice.ts'
import { CODE_ROOT_COPY, DECISION_COPY } from '../core/securityCopy.ts'
import { projectOf } from '../sessions.ts'
import { scopedTemplates } from '../hooks/usePromptTemplates.ts'
import { Composer } from '../components/Composer.tsx'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { NewSessionControls, SessionControls } from '../components/ComposerControls.tsx'
import { ContextRow, SetupCard } from '../components/NewSession.tsx'
import { HarnessChoice } from '../components/HarnessChoice.tsx'
import { PromptQueue } from '../components/PromptQueue.tsx'
import { SendingMessage } from '../components/SendingMessage.tsx'
import { Button, Collapse, Icon, InlineNotice } from '@latch/ui'
import type { ShellState } from './useShellLayout.tsx'

/** The message on its way, until the Host lists it. */
export function SendingBubble({ shell }: { shell: ShellState }) {
  const { sendingView } = shell
  if (!sendingView) return null
  return <SendingMessage key={sendingView.submission.requestId} view={sendingView} />
}

/** The input of the open session, or of the new-session page. */
export function SessionComposer({ shell }: { shell: ShellState }) {
  const {
    openPersonal,
    personalDraft,
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
    startsL3,
    gate,
    sessionBlock,
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
    addAgentTrigger,
    promptTemplates,
    openSettings,
    manageProviders,
    createProject,
    onlyBuiltIn,
    snapshot,
    selectedId,
    refresh,
  } = shell
  return (
    <Composer
      textareaRef={composerRef}
      lastPrompt={current?.messages.findLast(message => message.role === 'user')?.text}
      attachments={catalog?.features?.attachments === true && gate.kind === 'open' && !noteComposer ? attachmentDraft : undefined}
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
      label={noteComposer?.kind === 'note' ? DECISION_COPY.noteLabel : selectedId === null ? '新会话消息' : '继续对话'}
      placeholder={submission.pending === null ? (noteComposer?.placeholder ?? placeholder) : placeholder}
      draft={noteComposer?.kind === 'note' ? noteComposer.draft : submission.draft}
      onDraft={noteComposer?.kind === 'note' ? noteComposer.onDraft : setSubmissionDraft}
      pending={submission.pending}
      sending={submission.sending}
      error={
        (noteComposer?.kind === 'note' ? noteComposer.error : '')
        || submission.error
        || (actionError?.sessionId === selectedId ? actionError.text : '')
      }
      onRetry={() => {
        void retryDraft()
      }}
      canSend={gate.kind === 'open' && (selectedId === null ? block === null && !presenceDown : sessionBlock === undefined)}
      blockReason={block?.message ?? sessionBlock ?? startReason}
      readOnly={gate.kind === 'read-only' ? gate.text : gate.kind === 'stopped' ? '该会话不再接受输入。' : undefined}
      {...(noteComposer ? { hint: noteComposer.hint } : {})}
      {...(noteComposer?.kind === 'note'
        ? { answer: { label: DECISION_COPY.noteSubmit, onSubmit: noteComposer.submit, onCancel: noteComposer.cancel } }
        : {})}
      below={
        selectedId === null && catalog && !personalDraft ? (
          <>
            <ContextRow
              hostName={snapshot.hostName}
              fullAccess={startsL3}
              onComputer={() => {
                openSettings('computer')
              }}
            />
            {/* Captions open under the row like disclosures, so the input and everything above it stay put. */}
            <Collapse open={codeRootChoice !== undefined}>
              <p className="composer-notice" data-tint="warn" role="note">
                <Icon icon={ShieldAlert} size={14} />
                {codeRootChoice && `${CODE_ROOT_COPY.notice}${codeRootChoice.id === 'default' ? CODE_ROOT_COPY.startDir : ''}`}
              </p>
            </Collapse>
            <Collapse open={chosenScopeCaption !== undefined}>
              <p className="composer-notice" role="note">
                <Icon icon={Info} size={14} />
                <VisibleText text={chosenScopeCaption ?? ''} />
              </p>
            </Collapse>
            <Collapse open={onlyBuiltIn && owner}>
              <button
                type="button"
                className="new-session-hint"
                onClick={() => {
                  // The same place the add tile opens: the presets, added in place.
                  addAgentTrigger.current?.click()
                }}>
                还可以添加 Codex、OpenCode 等 Agent
              </button>
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
      queueable={canQueue && !noteComposer}
      queueTray={
        selectedId !== null && current?.queue ? (
          <PromptQueue
            key={selectedId}
            sessionId={selectedId}
            items={current.queue}
            canSend={gate.kind === 'open' && sessionBlock === undefined && !submission.pending}
            canRemove={access.scopes.has('run')}
            onChanged={refresh}
          />
        ) : undefined
      }
      inline={phone && selectedId !== null}
      controls={
        selectedId === null && personalDraft ? (
          <Button variant="ghost" onClick={() => openPersonal?.()}>
            {personalDraft.name}
          </Button>
        ) : selectedId === null ? (
          <NewSessionControls
            phone={false}
            catalog={catalog}
            choice={choice}
            onChoice={submission.updateChoice}
            disabled={submission.pending !== null || submission.sending || gate.kind !== 'open'}
            onManageProviders={manageProviders}
            onManageWorkspaces={
              owner
                ? () => {
                    openSettings('workspaces')
                  }
                : undefined
            }
            onCreateProject={createProject}
            onProvidersChanged={() => {
              void refresh()
            }}
            access={access}
          />
        ) : (
          summary
          && !summary.personal && (
            <SessionControls
              catalog={catalog}
              summary={summary}
              harness={harnessInfo}
              model={effectiveModel}
              current={currentModel}
              onModel={model => {
                submission.setOverride(summary.id, model)
              }}
              config={current?.config ?? []}
              configBusy={configBusy.get(summary.id) ?? null}
              configFeedback={configFeedback.get(summary.id)}
              onConfigRefresh={refreshConfig}
              onConfig={setConfig}
              phone={phone}
              access={access}
              onManageProviders={manageProviders}
              onProvidersChanged={() => {
                void refresh()
              }}
              locked={gate.kind !== 'open'}
            />
          )
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
    presenceDown,
    startReason,
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
      placeholder={placeholder}
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
        codeRootChoice ? (
          <p className="composer-notice" role="note">
            {CODE_ROOT_COPY.notice}
            {codeRootChoice.id === 'default' && CODE_ROOT_COPY.startDir}
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

export function HarnessChoices({ shell }: { shell: ShellState }) {
  const { personalDraft, catalog, access, owner, submission, choice, addAgentTrigger, openSettings, newChoicesLocked, refresh } = shell
  if (personalDraft || !catalog) return null
  return (
    <HarnessChoice
      addRef={addAgentTrigger}
      catalog={catalog}
      workspaceId={choice.workspaceId}
      value={choice.harnessId ? entryKey(choice.harnessId, choice.mode) : undefined}
      access={access}
      disabled={newChoicesLocked}
      onManage={owner ? () => openSettings('agents') : undefined}
      onChange={entry => submission.updateChoice({ harnessId: entry.harness.id, mode: entry.mode })}
      onAdded={agent => {
        submission.updateChoice({ harnessId: agent.id, mode: 'agent' })
        void refresh()
      }}
    />
  )
}

export function SetupNotices({ shell }: { shell: ShellState }) {
  const { catalog, access, owner, submission, block, setupTrigger, openSettings, refresh } = shell
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
      {block && (
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
            openSettings(block.kind === 'model-required' ? 'providers' : catalog ? 'agents' : 'plugins')
          }}
        />
      )}
    </>
  )
}
