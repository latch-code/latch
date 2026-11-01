import { SquarePen } from 'lucide-react'
import { errorMessage } from '../core/api.ts'
import { WorkspaceRecovery } from '../components/WorkspaceRecovery.tsx'
import { projectFor } from '../composerChoice.ts'
import { APPROVAL_COPY, SESSION_STOP_TEXT } from '../core/securityCopy.ts'
import { ApprovalVisibilityContext } from '../hooks/useApprovalsInView.ts'
import { GettingStarted } from '../components/GettingStarted.tsx'
import { FindBar } from '../components/FindBar.tsx'
import { NewSession } from '../components/NewSession.tsx'
import { ApprovalStatuses } from '../components/ApprovalCard.tsx'
import { Banner } from '../components/Banner.tsx'
import { JumpLatest } from '../components/JumpLatest.tsx'
import { Transcript } from '../components/Transcript.tsx'
import { isLive, renderedMessages } from '../conversation.ts'
import { ChangesLinkContext } from '../conversation/changesLink.ts'
import { Button, InlineNotice, Loading } from '@latch/ui'
import { ConnectionBanners } from './ConnectionBanners.tsx'
import { HarnessChoices, SendingBubble, SessionComposer, SetupNotices } from './SessionComposers.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** Under the top bar: the notices and the conversation (or the new session). Phones draw it as paper. */
export function ConversationView({ shell }: { shell: ShellState }) {
  const {
    openPersonal,
    personalDraft,
    setPersonalGroupId,
    current,
    summary,
    composerRef,
    setToast,
    approvalBusy,
    cancelling,
    recoveryProjects,
    setRecoveryProjects,
    workspaceChanged,
    catalog,
    access,
    owner,
    gateFor,
    approvals,
    active,
    harnessInfo,
    harnessName,
    reading,
    run,
    approvalsInView,
    revealApprovals,
    frozenAt,
    changesLink,
    approvalVisibility,
    submission,
    choice,
    choose,
    jumpToLatest,
    block,
    stopCode,
    gate,
    sessionBlock,
    onDecide,
    statuses,
    cancelState,
    fallbackElapsed,
    providerName,
    retry,
    coarse,
    phone,
    setNewSheet,
    addAgentTrigger,
    setupTrigger,
    sheetComposerRef,
    findOpen,
    setFindOpen,
    startNew,
    openSettings,
    findReveal,
    topHarness,
    demo,
    suggest,
    snapshot,
    selectedId,
    refresh,
  } = shell
  return (
    <div className="workspace-body">
      <ConnectionBanners shell={shell} />
      {summary?.personal?.groupId && (
        <InlineNotice
          tone="neutral"
          action={
            <Button
              size="xs"
              onClick={() => {
                setPersonalGroupId(summary.personal!.groupId)
                openPersonal?.()
              }}>
              回到群聊
            </Button>
          }>
          这段记录来自个人助手群聊。
        </InlineNotice>
      )}
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
              : { allowed: false, reason: '请先恢复发起会话权限和可用的执行方式。' }
          }
          phase={submission.pending ? 'unknown' : submission.sending || cancelling.has(current.summary.id) ? 'busy' : 'idle'}
          onFork={(taskId, upToMessageId, workspaceId) => {
            const draft = submission.draft
            choose(null)
            submission.setFork({ taskId, upToMessageId, title: current.summary.title })
            submission.updateChoice({
              harnessId: current.summary.harnessId,
              workspaceId,
              mode: current.summary.mode ?? 'agent',
            })
            submission.setDraft(draft)
            if (phone) setNewSheet(true)
            requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
          }}
        />
      )}
      <Banner show={stopCode !== undefined} scope={selectedId ?? ''}>
        {stopCode && (
          <InlineNotice
            tone={stopCode === 'permission-drift' ? 'error' : 'warn'}
            secure
            action={
              <Button size="xs" onClick={startNew} icon={SquarePen}>
                新建会话
              </Button>
            }>
            {SESSION_STOP_TEXT[stopCode]}
          </InlineNotice>
        )}
      </Banner>
      <Banner show={Boolean(sessionBlock) && !workspaceChanged.has(selectedId ?? '')} scope={selectedId ?? ''}>
        {sessionBlock && <InlineNotice tone="neutral">{sessionBlock}</InlineNotice>}
      </Banner>
      {selectedId === null ? (
        <NewSession
          onboarding={
            !personalDraft && (
              <GettingStarted
                sessionCount={snapshot.tasks.length}
                ready={!block}
                project={catalog?.workspaces.find(item => item.id === choice.workspaceId)?.name ?? ''}
                remote={!access.local}
                firstTask={() => composerRef.current?.focus()}
                onAgent={() => {
                  if (block?.kind === 'model-required' && setupTrigger.current) setupTrigger.current.click()
                  else addAgentTrigger.current?.click()
                }}
                onProject={() => {
                  const picker = document.querySelector<HTMLButtonElement>('.composer [aria-label^="项目："]')
                  if (picker) picker.click()
                  else if (owner) openSettings('workspaces')
                  else composerRef.current?.focus()
                }}
              />
            )
          }
          harnesses={!personalDraft && catalog ? <HarnessChoices shell={shell} /> : undefined}
          title={personalDraft ? '和' + personalDraft.name + '聊聊' : undefined}
          composer={
            <>
              <SendingBubble shell={shell} />
              <SessionComposer shell={shell} />
            </>
          }
          demo={demo}
          mode={choice.mode}
          setup={<SetupNotices shell={shell} />}
          onSuggestion={suggest}
        />
      ) : (
        <div className="conversation">
          <div className="transcript-shell">
            {findOpen && current && (
              <FindBar
                sessionId={current.summary.id}
                revision={current.cursor}
                messages={current.messages}
                onReveal={findReveal}
                onClose={() => setFindOpen(false)}
              />
            )}
            <div className="transcript" ref={reading.containerRef} {...reading.handlers} tabIndex={0} aria-label="会话记录">
              <div className="transcript-content" ref={reading.contentRef}>
                {current === null ? (
                  <>
                    <Loading label="正在读取会话记录…" />
                    <SendingBubble shell={shell} />
                  </>
                ) : (
                  <ChangesLinkContext.Provider value={changesLink}>
                    <ApprovalStatuses.Provider value={statuses}>
                      <ApprovalVisibilityContext.Provider value={approvalVisibility}>
                        <Transcript
                          detail={current}
                          questionActions={{
                            deviceId: snapshot.device.id,
                            canAnswer: gate.kind === 'open' && sessionBlock === undefined,
                            onChanged: refresh,
                          }}
                          onCopyError={cause => setToast({ text: errorMessage(cause), tone: 'error' })}
                          onFork={
                            catalog?.features?.fork && access.scopes.has('run')
                              ? (upToMessageId, draft = '请接着这个会话继续。') => {
                                  submission.setFork({
                                    taskId: current.summary.id,
                                    upToMessageId,
                                    title: current.summary.title,
                                  })
                                  submission.updateChoice({
                                    harnessId: current.summary.harnessId,
                                    workspaceId: projectFor(catalog, current.summary),
                                    mode: current.summary.mode ?? 'agent',
                                  })
                                  choose(null)
                                  submission.setDraft(draft)
                                  if (phone) setNewSheet(true)
                                  requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
                                }
                              : undefined
                          }
                          approvals={approvals}
                          busy={approvalBusy}
                          onDecide={onDecide}
                          gateFor={gateFor}
                          harnessName={harnessName}
                          harness={topHarness}
                          personal={Boolean(summary?.personal)}
                          demo={demo}
                          active={active}
                          changes={{
                            // The Host shows a session's files only to a device whose data scope covers them.
                            enabled: catalog?.features?.changes === true && snapshot.device.dataScope === 'all',
                            undo: !access.scopes.has('run')
                              ? 'read-only'
                              : !access.local && harnessInfo?.source !== 'builtin'
                                ? 'mac-only'
                                : 'open',
                          }}
                          {...(run ? { onStop: run.onCancel } : {})}
                          onReveal={reading.reveal}
                          {...(frozenAt !== undefined ? { frozenAt } : {})}
                          cancelling={cancelState === 'cancelling'}
                          coarse={coarse}
                          providerName={providerName}
                          {...(fallbackElapsed !== undefined ? { fallbackElapsed } : {})}
                          {...(retry ? { retry } : {})}
                        />
                        <SendingBubble shell={shell} />
                      </ApprovalVisibilityContext.Provider>
                    </ApprovalStatuses.Provider>
                  </ChangesLinkContext.Provider>
                )}
                {current !== null && current.messages.length === 0 && !isLive(current) && approvals.length === 0 && !active && (
                  <p className="transcript-empty">会话记录会显示在这里。</p>
                )}
              </div>
            </div>
            {/* Keyed by session: another session's block count is not news here. */}
            <JumpLatest
              key={selectedId ?? ''}
              show={!reading.isFollowing}
              onJump={jumpToLatest}
              blocks={current ? renderedMessages(current).length : 0}
              waiting={
                approvals.length > 0 && approvalsInView === false
                  ? APPROVAL_COPY.waiting
                  : current?.questions?.length && !reading.isFollowing
                    ? '等你回答'
                    : undefined
              }
              onRevealWaiting={approvals.length > 0 ? revealApprovals : jumpToLatest}
            />
          </div>
          <div className="composer-dock">
            <SessionComposer shell={shell} />
          </div>
        </div>
      )}
    </div>
  )
}
