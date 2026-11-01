import { ShieldAlert } from 'lucide-react'
import { errorMessage } from '../core/api.ts'
import { projectFor } from '../composerChoice.ts'
import { APPROVAL_COPY, RECOVERY_COPY } from '../core/securityCopy.ts'
import { FindBar } from '../components/FindBar.tsx'
import { NewSession } from '../newSession/NewSession.tsx'
import { Banner } from '../components/Banner.tsx'
import { JumpLatest } from '../components/JumpLatest.tsx'
import { Transcript } from '../components/Transcript.tsx'
import { isLive, renderedMessages } from '../conversation.ts'
import { ChangesLinkContext } from '../conversation/changesLink.ts'
import { Button, InlineNotice, Loading } from '@latch/ui'
import { ConnectionBanners } from './ConnectionBanners.tsx'
import { NewSessionTitle, SendingBubble, SessionComposer, SetupNotices } from './SessionComposers.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** Under the top bar: the notices and the conversation (or the new session). Phones draw it as paper. */
export function ConversationView({ shell }: { shell: ShellState }) {
  const {
    openPersonal,
    setPersonalGroupId,
    current,
    summary,
    composerRef,
    setToast,
    workspaceChanged,
    catalog,
    access,
    approvals,
    active,
    harnessInfo,
    harnessName,
    reading,
    run,
    frozenAt,
    changesLink,
    submission,
    choice,
    choose,
    jumpToLatest,
    stopCode,
    stopText,
    stopRetry,
    retryStopped,
    refusedInput,
    sessionBlock,
    cancelState,
    fallbackElapsed,
    providerName,
    retry,
    coarse,
    phone,
    setNewSheet,
    sheetComposerRef,
    findOpen,
    setFindOpen,
    findFocus,
    startNew,
    findReveal,
    snapshot,
    topHarness,
    demo,
    selectedId,
  } = shell
  const forkChoice = () => ({
    harnessId: current?.summary.harnessId,
    workspaceId: projectFor(catalog, current?.summary),
    mode: current?.summary.mode ?? ('agent' as const),
  })
  // Same engine, same project, in a fork when the Host can make one; what was being written goes along.
  const continueInNew = () => {
    if (!current || !catalog?.features?.fork || !access.scopes.has('run')) {
      startNew()
      return
    }
    const last = current.messages.at(-1)
    if (!last) {
      startNew()
      return
    }
    // A prompt refused on its way back never sat in the input, so it goes along in place of the empty one.
    const draft = submission.draft || (refusedInput?.from === 'send' ? (refusedInput.prompt ?? '') : '')
    choose(null)
    submission.setFork({
      taskId: current.summary.id,
      upToMessageId: last.id,
      title: current.summary.title,
      choice: forkChoice(),
    })
    submission.setDraft(draft)
    if (phone) setNewSheet(true)
    requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
  }
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
      <Banner show={Boolean(sessionBlock) && !workspaceChanged.has(selectedId ?? '')} scope={selectedId ?? ''}>
        {sessionBlock && <InlineNotice tone="neutral">{sessionBlock}</InlineNotice>}
      </Banner>
      {selectedId === null ? (
        <NewSession
          title={<NewSessionTitle shell={shell} />}
          composer={
            <>
              <SendingBubble shell={shell} />
              <SessionComposer shell={shell} />
            </>
          }
          setup={<SetupNotices shell={shell} />}
        />
      ) : (
        <div className="conversation">
          <div className="transcript-shell">
            {findOpen && current && (
              <FindBar
                sessionId={current.summary.id}
                revision={current.cursor}
                messages={current.messages}
                focusRequest={findFocus}
                fallbackFocus={composerRef}
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
                    <Transcript
                      detail={current}
                      onCopyError={cause => setToast({ text: errorMessage(cause), tone: 'error' })}
                      onFork={
                        catalog?.features?.fork && access.scopes.has('run')
                          ? (upToMessageId, draft = '请接着这个会话继续。') => {
                              submission.setFork({
                                taskId: current.summary.id,
                                upToMessageId,
                                title: current.summary.title,
                                choice: forkChoice(),
                              })
                              choose(null)
                              submission.setDraft(draft)
                              if (phone) setNewSheet(true)
                              requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
                            }
                          : undefined
                      }
                      approvals={approvals}
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
            />
          </div>
          <div className="composer-dock">
            {stopCode && (
              <p
                className="composer-stop"
                data-secure=""
                data-tone={stopCode === 'permission-drift' ? 'err' : stopCode === 'permission-unverified' ? 'warn' : undefined}
                role="status">
                <ShieldAlert size={14} aria-hidden="true" />
                <span>{stopText}</span>
                {stopRetry && (
                  <Button size="xs" onClick={retryStopped}>
                    {APPROVAL_COPY.retry}
                  </Button>
                )}
                <Button size="xs" onClick={continueInNew}>
                  {RECOVERY_COPY.continueInNew}
                </Button>
              </p>
            )}
            <SessionComposer shell={shell} />
          </div>
        </div>
      )}
    </div>
  )
}
