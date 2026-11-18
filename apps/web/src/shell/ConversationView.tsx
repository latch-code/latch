import { SHELL_COPY } from './copy.ts'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { readsProjectFiles, type HarnessInfo } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'
import { sessionReadOnly } from '../core/permissions.ts'
import { projectFor } from '../composerChoice.ts'
import { FORK_CONTINUATION_PROMPT, forkSource } from '../forkChoice.ts'
import { APPROVAL_COPY, RECOVERY_COPY } from '../core/securityCopy.ts'
import { FindBar } from '../components/FindBar.tsx'
import { RebuildLostDialog } from '../history/RebuildLost.tsx'
import { harnessName as harnessLabel } from '../composerChoice.ts'
import { Banner } from '../components/Banner.tsx'
import { JumpLatest } from '../components/JumpLatest.tsx'
import { ConversationRail } from '../components/ConversationRail.tsx'
import { Transcript } from '../components/Transcript.tsx'
import { FillPlace } from '../panel/terminal/fills.ts'
import { isLive, liveMessageId, renderedMessages } from '../conversation.ts'
import { ChangesLinkContext } from '../conversation/changesLink.ts'
import { useTranscriptProjection } from '../conversation/useTranscriptProjection.ts'
import { Backdrop, Button, FolderGlyph, Hint, InlineNotice, Skeleton, HistoryGlyph, ShieldAlertGlyph, type BackdropLevel } from '@latch/ui'
import { ConnectionBanners } from './ConnectionBanners.tsx'
import { DEVICE_FAILURE_STEPS, OWNER_FAILURE_STEPS, SendingBubble, SessionComposer, takeFailureStep } from './SessionComposers.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { SourceHandoffDock, type HandoffRequest } from '../handoffs/SourceHandoff.tsx'
import { TargetHandoffDock } from '../handoffs/TargetHandoff.tsx'
import { ReturnedResult } from '../handoffs/ReturnedResult.tsx'
import { placeByTime, quotedSummary } from '../handoffs/model.ts'
import { useTopicProposals } from '../agents/TopicProposals.tsx'
import { useSessionBoardProposals } from '../board/SessionProposals.tsx'
import { SideQuestionPanel, useSideQuestion } from '../conversation/SideQuestion.tsx'
import { useTopicResults } from '../agents/TopicResults.tsx'
import { speakerOf } from '../agents/model.ts'
import { loginSurface } from '../panel/terminal/loginRuns.ts'
import { useOpenedMark } from '../core/attend.ts'
import { useEditFrom } from '../conversation/EditFrom.tsx'
import type { SendingMessage as SendingView } from '../core/sendingMessage.ts'
import { SendingMessage } from '../components/SendingMessage.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    openRebuilt: (title: string) => `打开「${title}」`,
    unfiltered: (count: number) => `${count} 个文件的 filter 没有运行`,
    unfilteredHint:
      '新工作树里这些文件的 filter（例如 Git LFS）没有运行，留成了 Git 里存的样子；要用 Git LFS 文件时，在终端里运行 git lfs pull。',
    homeUnavailable: '工作文件夹不可用',
  },
  {
    openRebuilt: (title: string) => `Open “${title}”`,
    unfiltered: (count: number) => `Filters skipped for ${count} files`,
    unfilteredHint:
      'Git filters such as Git LFS were skipped for these files in the new worktree. The files contain the data stored in Git. To get the Git LFS files, run git lfs pull in the terminal.',
    homeUnavailable: 'Work folder unavailable',
  },
)

/** A typical first turn's bubble and reply in the same content column as the loaded transcript. */
function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton" role="status" aria-label={SHELL_COPY.loadingTranscript}>
      <div className="message-user">
        <Skeleton width="48%" height={40} />
      </div>
      <div className="turn-reply">
        <Skeleton width={88} height={16} />
        <Skeleton width="89%" height={18} />
        <Skeleton width="72%" height={18} />
      </div>
    </div>
  )
}

/** Under the top bar: the notices and the conversation (or the new session). Phones draw it as paper. */
export function ConversationView({
  shell,
  visible,
  backdrop,
  starting,
}: {
  shell: ShellState
  visible: boolean
  backdrop: BackdropLevel
  starting: SendingView | null
}) {
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
    choose,
    jumpToLatest,
    stopCode,
    stopText,
    stopRetry,
    retryStopped,
    homeStop,
    retryHome,
    refusedInput,
    sessionBlock,
    cancelState,
    fallbackElapsed,
    providerName,
    retry,
    coarse,
    phone,
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
    rebuiltInto,
    owner,
    openSettings,
  } = shell
  const sideQuestion = useSideQuestion(selectedId)
  const showTranscript = visible && !(phone && sideQuestion)
  const showBackdrop = showTranscript && backdrop !== 'off'
  // Only a conversation in view marks a failed run opened: not under the start page, settings, a page or the board.
  const source = shell.itemReturn?.target
  const canMarkOpened = !source || (!source.messageId && !source.userMessageId) || (source.runId && current?.summary.runId === source.runId)
  useOpenedMark(current?.summary, !!canMarkOpened && visible && (access.legacy || access.scopes.has('view')), connection === 'connected')
  const projection = useTranscriptProjection(current)
  const handing = catalog?.features?.handoffs === true && current !== null && !current.summary.personal
  // A topic of 我的 Agent is a conversation with the helper: it answers, under its own face and name.
  const speaker = current ? speakerOf(snapshot, current.summary) : undefined
  const placeProposals = useTopicProposals(shell, current)
  const placeResults = useTopicResults(shell, current)
  const placeBoard = useSessionBoardProposals(shell, current)
  const [handoffRequest, setHandoffRequest] = useState<HandoffRequest | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  // A session brought in as it was whose Harness lost it: rebuilt as text, through the same choice as an import.
  const lostImport =
    stopCode === 'harness-session-lost'
    && current?.summary.imported?.mode === 'native'
    && catalog?.features?.historyImport === 1
    && access.scopes.has('run')
  const importedFrom = current?.summary.imported && catalog?.harnesses.find(item => item.id === current.summary.imported!.from)
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
              targetTitle={target ? target.title || SHELL_COPY.untitled : undefined}
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
  const mayEdit = !!current && access.scopes.has('run')
  const editFrom = useEditFrom({
    sessionId: current?.summary.id,
    agentMode: current?.summary.mode !== 'chat',
    changes: catalog?.features?.changes === true,
    dataScope: snapshot.device.dataScope,
    phone,
    // This device's unconfirmed message holds the composer until it settles; an edit would take its place.
    held: () => (submission.pending ? SHELL_COPY.pendingEdit : undefined),
    onToast: (text, tone = 'ok') => setToast({ text, tone }),
    onEdit: (_message, before, draft) => {
      if (!current) return
      choose(null)
      // The first message has nothing before it: in a fork, it goes on from where the fork began; otherwise the Host
      // starts a new session from this one (`editOf`), as private as it and marked where it began from outside content.
      const from = before
        ? { taskId: current.summary.id, upToMessageId: before, title: current.summary.title }
        : current.summary.forkOf
          ? {
              taskId: current.summary.forkOf.taskId,
              upToMessageId: current.summary.forkOf.upToMessageId,
              title: current.summary.forkOf.title,
            }
          : { taskId: current.summary.id, title: current.summary.title }
      submission.setFork({ ...from, choice: forkChoice(), source: forkSource(current, harnessInfo) })
      submission.setDraft(draft.text)
      shell.seedEdit({ refs: draft.refs, attachments: draft.attachments })
      shell.showHome()
    },
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
    shell.showHome()
  }
  return (
    <div className={showBackdrop ? 'workspace-body ui-backdrop-host' : 'workspace-body'}>
      {showBackdrop && <Backdrop className="workbench-backdrop" level={backdrop} running={active && frozenAt === undefined ? 1 : 0} />}
      <ConnectionBanners shell={shell} />
      {!starting && (
        <Banner show={Boolean(sessionBlock) && !workspaceChanged.has(selectedId ?? '')} scope={selectedId ?? ''}>
          {sessionBlock && <InlineNotice tone="neutral">{sessionBlock}</InlineNotice>}
        </Banner>
      )}
      {starting ? (
        <div className="conversation" key={starting.submission.requestId}>
          <div className="transcript-shell">
            <div className="transcript" tabIndex={0} aria-label={SHELL_COPY.transcript}>
              <div className="transcript-content">
                <SendingMessage view={starting} showUnknown={false} />
              </div>
            </div>
          </div>
          <div className="composer-dock">
            <SessionComposer shell={shell} home pendingInTranscript />
          </div>
        </div>
      ) : selectedId === null ? null : (
        <div className="conversation">
          <div className="transcript-shell">
            {showBackdrop && <span className="transcript-backdrop-clear" data-backdrop-clear="" aria-hidden="true" />}
            {findOpen && current && (
              <FindBar
                sessionId={current.summary.id}
                revision={current.sync?.revision ?? current.cursor}
                messages={current.messages}
                focusRequest={findFocus}
                fallbackFocus={composerRef}
                onReveal={findReveal}
                onClose={() => setFindOpen(false)}
              />
            )}
            {current && (
              <ConversationRail
                key={`rail:${current.summary.id}`}
                turns={projection.turns}
                liveId={isLive(current) ? liveMessageId(current) : undefined}
                getReadingMessageId={reading.getReadingMessageId}
                subscribeToReadingAnchor={reading.subscribeToReadingAnchor}
                onReveal={reading.reveal}
              />
            )}
            <div
              className="transcript"
              ref={reading.containerRef}
              {...reading.handlers}
              data-backdrop-scroll={showBackdrop ? '' : undefined}
              tabIndex={0}
              aria-label={SHELL_COPY.transcript}>
              <div className="transcript-content" ref={reading.contentRef}>
                {current === null ? (
                  <>
                    {!shell.sendingView && <TranscriptSkeleton />}
                    <SendingBubble shell={shell} />
                  </>
                ) : (
                  <FillPlace.Provider
                    value={shell.canTerminal && shell.terminalTarget?.sessionId === current.summary.id ? current.summary.id : undefined}>
                    <ChangesLinkContext.Provider value={changesLink}>
                      {current.summary.worktree?.unfiltered !== undefined && (
                        <div className="session-start-note" role="note">
                          <Hint label={COPY.unfiltered(current.summary.worktree.unfiltered)}>{COPY.unfilteredHint}</Hint>
                        </div>
                      )}
                      <Transcript
                        detail={current}
                        observeStream={showTranscript && frozenAt === undefined}
                        projection={projection}
                        replyViewport={reading.containerRef}
                        onSource={choose}
                        failureSteps={owner ? OWNER_FAILURE_STEPS : access.scopes.has('run') ? DEVICE_FAILURE_STEPS : undefined}
                        checkUnknown={access.scopes.has('run')}
                        onFailureStep={step => takeFailureStep(step, openSettings)}
                        onCopyError={cause => setToast({ text: errorMessage(cause), tone: 'error' })}
                        {...(mayEdit && catalog?.features?.fork
                          ? { onEditFrom: (message, before) => void editFrom.start(message, before) }
                          : {})}
                        onFork={
                          catalog?.features?.fork && access.scopes.has('run')
                            ? (upToMessageId, draft = FORK_CONTINUATION_PROMPT) => {
                                submission.setFork({
                                  taskId: current.summary.id,
                                  upToMessageId,
                                  title: current.summary.title,
                                  choice: forkChoice(),
                                  source: forkSource(current, harnessInfo),
                                })
                                choose(null)
                                submission.setDraft(draft)
                                shell.showHome()
                              }
                            : undefined
                        }
                        approvals={approvals}
                        harnessName={harnessName}
                        {...(speaker ? { speaker } : {})}
                        login={
                          harnessInfo?.login
                            ? {
                                harnessId: harnessInfo.id,
                                login: harnessInfo.login,
                                // In this session's 终端 tab, where it can have one.
                                surface: loginSurface(
                                  catalog?.features,
                                  current.summary.archived || current.summary.personal ? undefined : current.summary.id,
                                ),
                              }
                            : undefined
                        }
                        harness={topHarness}
                        demo={demo}
                        active={active}
                        changes={{
                          // The Host shows a session's files only to a device whose data scope covers them.
                          enabled: catalog?.features?.changes === true && readsProjectFiles(snapshot.device.dataScope),
                          undo: sessionReadOnly(current.summary) || !access.scopes.has('run') ? 'read-only' : 'open',
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
                        {...(returned.length || placeProposals || placeResults || placeBoard
                          ? {
                              placed: (turns: ReadonlyArray<{ key: string; at: number | undefined }>) =>
                                // After a turn, what it proposed comes first (想定时), then the results of what was
                                // set up since, which can only come later.
                                joinPlaced(
                                  joinPlaced(
                                    joinPlaced(returned.length ? placeReturned(turns) : undefined, placeProposals?.(turns)),
                                    placeBoard?.(turns),
                                  ),
                                  placeResults?.(turns),
                                ),
                            }
                          : {})}
                        {...(frozenAt !== undefined ? { frozenAt } : {})}
                        cancelling={cancelState === 'cancelling'}
                        coarse={coarse}
                        providerName={providerName}
                        {...(fallbackElapsed !== undefined ? { fallbackElapsed } : {})}
                        {...(retry ? { retry } : {})}
                      />
                      <SendingBubble shell={shell} />
                    </ChangesLinkContext.Provider>
                  </FillPlace.Provider>
                )}
              </div>
            </div>
            {/* Keyed by session: another session's block count is not news here. */}
            <JumpLatest
              key={`latest:${selectedId}`}
              show={!reading.isFollowing}
              onJump={jumpToLatest}
              blocks={current ? renderedMessages(current).length : 0}
            />
          </div>
          <div className="composer-dock" data-backdrop-clear={showBackdrop ? '' : undefined}>
            {rebuiltInto && (
              <p className="composer-stop history-rebuilt" role="status">
                <HistoryGlyph size={14} aria-hidden="true" />
                <span>{SHELL_COPY.rebuiltNewSession}</span>
                <Button size="xs" onClick={() => choose(rebuiltInto.id)}>
                  {COPY.openRebuilt(rebuiltInto.title || SHELL_COPY.untitled)}
                </Button>
              </p>
            )}
            {stopCode && !rebuiltInto && (
              <p
                className="composer-stop"
                data-secure=""
                data-tone={stopCode === 'permission-drift' ? 'err' : stopCode === 'permission-unverified' ? 'warn' : undefined}
                role="status">
                <ShieldAlertGlyph size={14} aria-hidden="true" />
                <span>{stopText}</span>
                {stopRetry && (
                  <Button size="xs" onClick={retryStopped}>
                    {APPROVAL_COPY.retry}
                  </Button>
                )}
                {lostImport && (
                  <Button size="xs" icon={HistoryGlyph} onClick={() => setRebuilding(true)}>
                    {SHELL_COPY.rebuild}
                  </Button>
                )}
                <Button size="xs" onClick={continueInNew}>
                  {RECOVERY_COPY.continueInNew}
                </Button>
              </p>
            )}
            {homeStop && !rebuiltInto && !stopCode && (
              <div className="composer-stop" role="status">
                <Hint label={COPY.homeUnavailable} lead={<FolderGlyph size={14} aria-hidden="true" />}>
                  {homeStop.reason}
                </Hint>
                <Button size="xs" onClick={retryHome}>
                  {APPROVAL_COPY.retry}
                </Button>
              </div>
            )}
            {rebuilding && lostImport && current && catalog && (
              <RebuildLostDialog
                phone={phone}
                catalog={catalog}
                summary={current.summary}
                sourceLabel={importedFrom ? harnessLabel(importedFrom) : current.summary.imported!.from}
                onClose={() => setRebuilding(false)}
                onOpen={taskId => {
                  setRebuilding(false)
                  choose(taskId)
                  void refresh()
                }}
              />
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
            {selectedId && (
              <SideQuestionPanel
                key={selectedId}
                sourceId={selectedId}
                question={sideQuestion}
                observeStream={visible && frozenAt === undefined}
                tasks={shell.snapshot.tasks ?? []}
                phone={phone}
                onInsert={text => {
                  submission.setDraft(previous => (previous.trim() ? `${previous}\n\n${text}` : text))
                  composerRef.current?.focus()
                }}
                onOpen={id => choose(id)}
              />
            )}
            <SessionComposer shell={shell} />
          </div>
        </div>
      )}
      {editFrom.dialog}
    </div>
  )
}

/** Two sets of rows placed in the timeline, each slot's rows in order. */
function joinPlaced(
  first: ReadonlyMap<string, ReactNode> | undefined,
  second: ReadonlyMap<string, ReactNode> | undefined,
): ReadonlyMap<string, ReactNode> {
  const joined = new Map<string, ReactNode>(first)
  for (const [key, node] of second ?? [])
    joined.set(
      key,
      joined.has(key) ? (
        <>
          {joined.get(key)}
          {node}
        </>
      ) : (
        node
      ),
    )
  return joined
}
