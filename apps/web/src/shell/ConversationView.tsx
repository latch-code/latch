import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { HarnessInfo } from '@latch/protocol'
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
import { renderedMessages } from '../conversation.ts'
import { ChangesLinkContext } from '../conversation/changesLink.ts'
import { Button, Hint, InlineNotice, Loading } from '@latch/ui'
import { MarkTile } from '../components/BrandTile.tsx'
import { ConnectionBanners } from './ConnectionBanners.tsx'
import { NewSessionTitle, SendingBubble, SessionComposer, SetupNotices } from './SessionComposers.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { SourceHandoffDock, type HandoffRequest } from '../handoffs/SourceHandoff.tsx'
import { TargetHandoffDock } from '../handoffs/TargetHandoff.tsx'
import { ReturnedResult } from '../handoffs/ReturnedResult.tsx'
import { placeByTime, quotedSummary } from '../handoffs/model.ts'

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
    handoffs,
  } = shell
  const handing = catalog?.features?.handoffs === true && current !== null && !current.summary.personal
  const [handoffRequest, setHandoffRequest] = useState<HandoffRequest | null>(null)
  const handoffNonce = useRef(0)
  // The text last selected in the conversation and the messages it lies in: a message action takes it along.
  const selected = useRef<{ text: string; ids: string[]; at: number } | null>(null)
  useEffect(() => {
    if (!handing) return
    const read = () => {
      const selection = document.getSelection()
      const text = selection?.toString().trim()
      if (!selection || !text || selection.rangeCount === 0) return
      const within = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest('.transcript [data-message-id]')
      const ids = [within(selection.anchorNode), within(selection.focusNode)].flatMap(row =>
        row ? [row.getAttribute('data-message-id')!] : [],
      )
      if (ids.length) selected.current = { text, ids, at: Date.now() }
    }
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  }, [handing])
  const handOff = (messageIds: string[]) => {
    const last = selected.current
    const text = last && Date.now() - last.at < 60_000 && last.ids.every(id => messageIds.includes(id)) ? last.text : undefined
    selected.current = null
    handoffNonce.current += 1
    setHandoffRequest({ nonce: handoffNonce.current, sessionId: current!.summary.id, messageIds, ...(text ? { text } : {}) })
  }
  const returned = handing
    ? handoffs.handoffs.filter(
        item => item.sourceSessionId === current.summary.id && (item.result || (item.contentRemoved && item.status === 'returned')),
      )
    : []
  const placeReturned = (turns: ReadonlyArray<{ key: string; at: number | undefined }>) => {
    const placed = placeByTime(
      turns,
      returned.map(item => ({ at: item.result?.at ?? item.updatedAt, item })),
    )
    return new Map(
      [...placed].map(([key, items]) => [
        key,
        items.map(({ item }) => {
          const target = snapshot.tasks.find(task => task.id === item.targetSessionId)
          const targetId = item.targetSessionId
          return (
            <ReturnedResult
              key={item.id}
              handoff={item}
              targetTitle={target ? target.title || '未命名会话' : undefined}
              {...(target ? { onOpenTarget: () => choose(target.id) } : {})}
              {...(targetId && catalog?.features?.filePreview
                ? {
                    onOpenFile: (file: { root: string; path: string }) =>
                      shell.openFile({ sessionId: targetId, reference: file.path, rootId: file.root }),
                  }
                : {})}
              {...(target
                ? {
                    onOpenMessage: (messageId: string) => {
                      shell.selectSearchHit({
                        sessionId: target.id,
                        messageId,
                        title: target.title,
                        snippet: '',
                        match: { start: 0, end: 0 },
                        updatedAt: target.updatedAt,
                        archived: target.archived === true,
                      })
                    },
                  }
                : {})}
              {...(access.scopes.has('run')
                ? {
                    onQuote: (text: string) => {
                      submission.setDraft(previous => quotedSummary(previous, text))
                      requestAnimationFrame(() => composerRef.current?.focus())
                    },
                  }
                : {})}
            />
          )
        }),
      ]),
    )
  }
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
                    {current.summary.firstStart && harnessInfo && <FirstStartNote harness={harnessInfo} />}
                    {current.summary.worktree?.unfiltered !== undefined && (
                      <div className="session-start-note" role="note">
                        <Hint label={`${current.summary.worktree.unfiltered} 个文件的 filter 没有运行`}>
                          新工作树里这些文件的 filter（例如 Git LFS）没有运行，留成了 Git 里存的样子；要用 Git LFS 文件时，在终端里运行 git
                          lfs pull。
                        </Hint>
                      </div>
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
                      {...(handing ? { onHandoff: handOff } : {})}
                      {...(returned.length ? { placed: placeReturned } : {})}
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
            {handing && (
              <>
                <SourceHandoffDock
                  key={current.summary.id}
                  shell={shell}
                  request={handoffRequest}
                  onTaken={() => setHandoffRequest(null)}
                  handoffs={handoffs}
                />
                <TargetHandoffDock key={`target:${current.summary.id}`} shell={shell} handoffs={handoffs} />
              </>
            )}
            <SessionComposer shell={shell} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The timeline's first row in an external Harness's session, once per launch in a project: the Harness's mark and that
 * Latch does not isolate it, always in view; what it can do behind ⓘ.
 */
function FirstStartNote({ harness }: { harness: HarnessInfo }) {
  const name = harness.capabilities.display.label
  const note = harness.permission?.approvals === 'none' ? MODE_COPY.firstStartUnasked(name) : MODE_COPY.firstStart(name)
  return (
    <div className="session-start-note" role="note">
      <Hint lead={<MarkTile mark={harness.capabilities.display.mark} size={14} />} label={note.label}>
        {note.detail}
      </Hint>
    </div>
  )
}
