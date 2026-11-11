import { ShieldAlert } from 'lucide-react'
import { api, errorMessage } from '../core/api.ts'
import { listsFoundHarnesses, projectFor } from '../composerChoice.ts'
import { forkSource } from '../forkChoice.ts'
import { APPROVAL_COPY, MODE_COPY, RECOVERY_COPY } from '../core/securityCopy.ts'
import { FindBar } from '../components/FindBar.tsx'
import { FoundHarnessesCard, NewSession, RecentSessions } from '../newSession/NewSession.tsx'
import { recentProjectSessions } from '../sessions.ts'
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
    refresh,
    connection,
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
      source: forkSource(current, harnessInfo),
    })
    submission.setDraft(draft)
    if (phone) setNewSheet(true)
    requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
  }
  return (
    <div className="workspace-body">
      <ConnectionBanners shell={shell} />
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
          found={listsFoundHarnesses(catalog, snapshot.tasks.length, access) ? <FoundHarnessesCard onRecheck={refresh} /> : undefined}
          recent={
            catalog && choice.workspaceId && choice.workspaceId !== 'default' && !submission.fork ? (
              <RecentSessions
                snapshot={snapshot}
                sessions={recentProjectSessions(
                  choice.workspaceId,
                  snapshot.tasks.filter(task => !task.archived),
                  catalog.workspaces,
                )}
                onOpen={choose}
              />
            ) : undefined
          }
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
                    {current.summary.firstStart && harnessInfo && (
                      <p className="session-start-note" role="note">
                        {harnessInfo.permission?.approvals === 'none'
                          ? `${MODE_COPY.agentDecidesLine(harnessInfo.capabilities.display.label)}。`
                          : MODE_COPY.firstStart(harnessInfo.capabilities.display.label)}
                      </p>
                    )}
                    {current.summary.worktree?.unfiltered !== undefined && (
                      <p className="session-start-note" role="note">
                        新工作树里有 {current.summary.worktree.unfiltered} 个文件的 filter（例如 Git LFS）没有运行，留成了 Git
                        里存的样子；要用 Git LFS 文件时，在终端里运行 git lfs pull。
                      </p>
                    )}
                    <Transcript
                      detail={current}
                      onSource={choose}
                      onCopyError={cause => setToast({ text: errorMessage(cause), tone: 'error' })}
                      onFork={
                        catalog?.features?.fork && access.scopes.has('run')
                          ? (upToMessageId, draft = '请接着这个会话继续。') => {
                              submission.setFork({
                                taskId: current.summary.id,
                                upToMessageId,
                                title: current.summary.title,
                                choice: forkChoice(),
                                source: forkSource(current, harnessInfo),
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
                      login={
                        harnessInfo?.login
                          ? { harnessId: harnessInfo.id, login: harnessInfo.login, terminal: catalog?.features?.loginTerminal === true }
                          : undefined
                      }
                      harness={topHarness}
                      demo={demo}
                      active={active}
                      changes={{
                        // The Host shows a session's files only to a device whose data scope covers them.
                        enabled: catalog?.features?.changes === true && snapshot.device.dataScope === 'all',
                        undo: current.summary.personal || !access.scopes.has('run') ? 'read-only' : 'open',
                        // As the 改动 tab reads it: nothing can be written until the connection is back.
                        offline: connection === 'reconnecting' || connection === 'offline',
                      }}
                      {...(run ? { onStop: run.onCancel } : {})}
                      {...(current.summary.personal
                        ? {}
                        : {
                            onStopSubagent: async (subagentId: string) => {
                              try {
                                await api(`tasks/${encodeURIComponent(current.summary.id)}/stop-subagent`, {
                                  method: 'POST',
                                  body: { subagentId },
                                })
                              } catch (cause) {
                                setToast({ text: errorMessage(cause), tone: 'error' })
                                throw cause
                              }
                            },
                          })}
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
