import { sessionAgent } from '../agents/model.ts'
import type { AppSnapshot } from '@latch/protocol'
import type { useHarness } from '../core/useHarness.ts'
import { hasFileMention } from '../fileMentions.ts'
import type { FileMention } from '@latch/protocol'
import { useAttachments } from '../hooks/useAttachments.ts'
import { projectScopeCaption } from '../projects.tsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Approval, TaskDetail, TaskSummary } from '@latch/protocol'
import { api, ApiError, errorMessage, fromInput, inlineError, isUncertain } from '../core/api.ts'
import { choiceKind, DecisionRequests, settledOutcome } from '../core/approvalDecision.ts'
import { cancelAnswer, CancelRequests } from '../core/cancelRequest.ts'
import { ConfigRequests } from '../core/configRequest.ts'
import { browserDraftStorage, forgetStoredDrafts, listedSessions, SessionDrafts } from '../core/sessionDrafts.ts'
import { joinDraft, takeHandedDraft } from '../core/draftHandoff.ts'
import type { SessionConfigFeedback } from '../composer/modelReasoning.ts'
import {
  findHarness,
  findProvider,
  harnessName as harnessLabel,
  needsProject,
  sessionHarness,
  sessionModel,
  startBlock,
} from '../composerChoice.ts'
import { openSession } from '../core/blocking.ts'
import { provideSessionLinks } from '../core/sessionLinks.ts'
import { exportFileName, saveText, transcriptMarkdown } from '../exportMarkdown.ts'
import { isActive } from '../format.ts'
import { approvalActions, composerGate, deviceAccess, hostView } from '../core/permissions.ts'
import { setPreference } from '../preferences.ts'
import { requestLeave } from '../preview/editDrafts.ts'
import {
  CONFIG_UNVERIFIED_TEXT,
  isSessionStopCode,
  SESSION_STOP_LABEL,
  stopLocksInput,
  type SessionStopCode,
} from '../core/securityCopy.ts'
import { retryOfRefused, type RefusedInput } from '../core/refusedInput.ts'
import { sessionMenuSections } from '../sessionMenu.ts'
import {
  emptySeen,
  isUnread,
  markSeen,
  markUnread,
  pruneSeen,
  readSeen,
  waitingCount,
  waitsOnYou,
  writeSeen,
  type SeenState,
  projectOf,
} from '../sessions.ts'
import { useReadingPosition } from '../core/useReadingPosition.ts'
import { currentShell, shellFolders } from '../core/shell.ts'
import { useEarlierDraft } from '../composer/useEarlierDraft.ts'
import { useRejectionNote } from '../composer/useRejectionNote.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { useRunClock } from '../hooks/useRunClock.ts'
import { useSubmission } from '../hooks/useSubmission.ts'
import { useSwitchFade } from '../hooks/useSwitchFade.ts'
import { type RunState } from '../composer/Composer.tsx'
import { type MenuSection } from '../components/overlays.tsx'
import { type ApprovalStatus } from '../composer/ApprovalDrawer.tsx'
import { codeRootWorkspace } from '../components/CodeRootNotice.tsx'
import { deliveredSubmission, queuedTwin, sendingMessageFor } from '../core/sendingMessage.ts'
import { toolRowId } from '../conversation.ts'
import { rebuiltFrom } from '../history/model.ts'

/** Session IDs are never empty. */
const NEW_SESSION_DRAFT = ''
const NO_PROJECT_FILES = '这台设备看不到项目文件'
/** Text only a device that may read every kind of data sees: an agent's session, or one an assistant ran. */
const privateSession = (task: TaskSummary | undefined): boolean =>
  task !== undefined && (task.personal !== undefined || task.agent !== undefined || task.agentPrivate === true)

type Harness = ReturnType<typeof useHarness>
type ToastMessage = { text: string; tone: 'ok' | 'error' }
/** Results of session actions belong to the session they were made in, not whichever is open when they settle. */
type ActionError = { sessionId: string; text: string }

const without = <T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
  const next = new Set(set)
  next.delete(value)
  return next
}

/**
 * The open session and what acts on it: selection, drafts, submission, decisions, cancel and config requests. It knows
 * nothing of the layout; the shell passes what must follow a selection or a foreground send.
 */
export function useSessionController({
  harness,
  snapshot,
  onBeforeSelect,
  onForegroundSent,
}: {
  harness: Harness
  snapshot: AppSnapshot
  /** Runs as the selection changes, for what the shell keeps per open session. */
  onBeforeSelect: (id: string | null) => void
  /** A message went out from this page and its session is now the open one. */
  onForegroundSent: () => void
}) {
  const { selectedId, detail, select, refresh } = harness
  const privateVisible = snapshot.device.dataScope === 'all' && snapshot.device.scopes.includes('view')
  const [initialDrafts] = useState(() => {
    // Only this device's drafts stay on this origin: another device's could otherwise open here.
    forgetStoredDrafts(location.origin, snapshot.device.id)
    return new SessionDrafts(browserDraftStorage(location.origin, snapshot.device.id))
  })
  const sessionDrafts = useRef(initialDrafts)
  const draftSessionId = useRef(selectedId)
  const draftDevice = useRef(snapshot.device.id)
  const privateDraftId = useRef<string | null>(null)
  const current = detail?.summary.id === selectedId && (!privateSession(detail.summary) || privateVisible) ? detail : null
  const summary = current?.summary ?? snapshot.tasks.find(task => task.id === selectedId && (!privateSession(task) || privateVisible))
  if (summary && privateSession(summary) && selectedId) privateDraftId.current = selectedId
  else if (privateDraftId.current !== selectedId) privateDraftId.current = null
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [renaming, setRenaming] = useState<TaskSummary | null>(null)
  const [deleting, setDeleting] = useState<TaskSummary | null>(null)
  const [removingWorktree, setRemovingWorktree] = useState<TaskSummary | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [approvalBusy, setApprovalBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const [approvalStatuses, setApprovalStatuses] = useState<ReadonlyMap<string, ApprovalStatus>>(new Map())
  const approvalFlights = useRef(new Set<string>())
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const stoppedRuns = useRef(new Map<string, string>())
  const [cancelUncertain, setCancelUncertain] = useState<ReadonlySet<string>>(new Set())
  // A stop whose answer never came is not known to be under way: only the bar above the input speaks of it.
  const stopping = useMemo(() => new Set([...cancelling].filter(id => !cancelUncertain.has(id))), [cancelling, cancelUncertain])
  const [configBusy, setConfigBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const configRequests = useRef(new ConfigRequests())
  /** A setting change still on its way, per session. */
  const configFlights = useRef(new Map<string, Promise<void>>())
  const [configFeedback, setConfigFeedback] = useState<ReadonlyMap<string, SessionConfigFeedback>>(new Map())
  const [recoveryProjects, setRecoveryProjects] = useState<ReadonlyMap<string, string>>(new Map())
  const [workspaceChanged, setWorkspaceChanged] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  /** Sessions that stopped accepting input, learned from the Host's refusal. */
  const [stopped, setStopped] = useState<ReadonlyMap<string, SessionStopCode>>(new Map())
  const [refused, setRefused] = useState<ReadonlyMap<string, RefusedInput>>(new Map())
  const decisions = useRef(new DecisionRequests())
  const cancels = useRef(new CancelRequests())

  const catalog = snapshot.catalog
  const shell = currentShell()
  const host = hostView(snapshot)
  const scopesKey = host
    ? `${snapshot.device.listener}:${snapshot.device.scopes.join(',')}:${snapshot.device.dataScope}:${snapshot.device.status}`
    : 'legacy'
  // Ignore last-seen churn, but invalidate every access boundary used by private editors.
  const access = useMemo(() => deviceAccess(snapshot, shell), [scopesKey, shell])
  const owner = access.admin
  const canQueue = catalog?.features?.queue === true
  const gateFor = useCallback((approval: Approval) => approvalActions(approval, access.device), [access])
  const approvals = useMemo(
    () => current?.approvals ?? snapshot.approvals.filter(approval => approval.sessionId === selectedId),
    [current, snapshot.approvals, selectedId],
  )
  const active = isActive(summary?.status)
  /** The running turn takes what is sent now; read from the open session, since it is agreed per run. */
  const steer = active && current?.steer === true
  const harnessInfo = sessionHarness(catalog, summary)
  const harnessName = harnessInfo ? harnessLabel(harnessInfo) : (summary?.harnessId ?? snapshot.harness?.name ?? 'Latch')

  const reading = useReadingPosition({
    sessionId: selectedId,
    ready: current !== null,
    contentVersion: `${current?.cursor ?? 0}:${current?.liveText.length ?? 0}:${current?.liveReasoning?.length ?? 0}:${approvals.length}`,
  })
  // Fade the content, not the masked scroller: animating the latter can leave Chromium's hit-test region empty.
  useSwitchFade(reading.contentRef, current?.summary.id ?? null)
  const stopSession = (sessionId: string, cause: unknown, what: RefusedInput) => {
    if (cause instanceof ApiError && cause.code === 'workspace-changed') {
      setWorkspaceChanged(previous => new Set(previous).add(sessionId))
      return true
    }
    if (cause instanceof ApiError && isSessionStopCode(cause.code)) {
      const code = cause.code
      setStopped(previous => new Map(previous).set(sessionId, code))
      setRefused(previous => new Map(previous).set(sessionId, what))
    }
  }
  /** A mode that could not be read this once clears when something is tried again; the Host says if it still cannot. */
  const clearUnverified = (sessionId: string) => {
    if (stopped.get(sessionId) !== 'permission-unverified') return
    setStopped(previous => {
      const next = new Map(previous)
      next.delete(sessionId)
      return next
    })
    setRefused(previous => {
      const next = new Map(previous)
      next.delete(sessionId)
      return next
    })
  }
  const submission = useSubmission({
    snapshot,
    access,
    selectedId,
    select,
    refresh,
    onSent: (sessionId, sent, { foreground, consumedDraft, memoryRefused }) => {
      if (consumedDraft) sessionDrafts.current.remove(sent.sessionId ?? NEW_SESSION_DRAFT)
      // The message went; only its 「记住…」 was not kept, and the Host says why.
      if (memoryRefused) setToast({ text: memoryRefused, tone: 'error' })
      if (!foreground || sent.queue) return
      draftSessionId.current = sessionId
      onForegroundSent()
      reading.show(sessionId)
    },
    onRefused: (sessionId, cause, resent) => stopSession(sessionId, cause, { from: 'send', ...(resent ? { prompt: resent } : {}) }),
    // Not delivered, for certain: the text goes back where it was written, and the released rows say so.
    onReleased: (sent, restored) => {
      released.current?.('已在 设置 › 设备 里释放，请移除后重新添加')
      if (restored || !sent.prompt) return
      const home = sent.sessionId ?? NEW_SESSION_DRAFT
      if (!sessionDrafts.current.read(home, privateVisible))
        sessionDrafts.current.save(
          home,
          sent.prompt,
          sent.sessionId !== undefined && privateSession(snapshot.tasks.find(task => task.id === sent.sessionId)),
        )
    },
  })
  /**
   * The open session can start its next prompt on a new context: the harness takes it and this device may send. Not
   * when the Host has cleared it already, since nothing is left to keep, nor in a session that only opens to be read.
   */
  const clearable =
    current?.clearContext === true
    && current.contextCleared !== true
    && !current.summary.personal
    && (access.legacy || access.scopes.has('run'))
    && current.messages.some(message => message.role === 'user')
  const { clearing, setClearing } = submission
  // A turn that starts meanwhile, here or on another device, ends the choice: what is written now waits behind it. While
  // the session's detail is still loading nothing is known, so the choice stays.
  const loaded = current !== null
  useEffect(() => {
    if (selectedId !== null && clearing && (active || (loaded && !clearable))) setClearing(selectedId, false)
  }, [selectedId, clearing, active, loaded, clearable, setClearing])
  const armClear = useStableCallback((on: boolean) => {
    if (selectedId === null) return
    setClearing(selectedId, on)
    if (on) composerRef.current?.focus()
  })
  // Before anything else writes: below the data scope `all`, private text and excerpts never reach storage.
  sessionDrafts.current.allowPrivate(privateVisible)
  // What was being written before the page loaded: the composer's own text (an unconfirmed submission's) comes first.
  useLayoutEffect(() => {
    const text = sessionDrafts.current.read(selectedId ?? NEW_SESSION_DRAFT, privateVisible)
    if (text) submission.setDraft(previous => (previous.trim() ? previous : text))
  }, [])
  // The open composer's text is kept for the next load, as it changes; a private session's only where it may be seen.
  useEffect(() => {
    if (draftSessionId.current !== selectedId) return
    const hidden = selectedId !== null && (summary === undefined || privateSession(summary) || privateDraftId.current === selectedId)
    if (hidden && !privateVisible) return
    sessionDrafts.current.keep(selectedId ?? NEW_SESSION_DRAFT, submission.draft, hidden)
  }, [submission.draft, selectedId])
  useEffect(() => {
    const drafts = sessionDrafts.current
    const leave = () => drafts.flush()
    addEventListener('pagehide', leave)
    return () => {
      removeEventListener('pagehide', leave)
      // Unmounted without leaving the page: signed out or replaced, so nothing more is written.
      drafts.detach()
    }
  }, [])
  // A session a whole listing no longer has was deleted, here or elsewhere: its text goes with it. A partial listing,
  // or one this device sees only part of, drops nothing.
  useEffect(() => {
    const listed = listedSessions(snapshot, privateVisible)
    if (listed) sessionDrafts.current.retain(listed)
  }, [snapshot.tasks, snapshot.tasksComplete, privateVisible])
  // A remote deletion clears selection without going through choose; never transfer that session's text to a new task.
  useLayoutEffect(() => {
    if (draftSessionId.current === selectedId) return
    if (draftSessionId.current !== null) sessionDrafts.current.remove(draftSessionId.current)
    draftSessionId.current = selectedId
    // The new session's own text comes back, never the removed session's.
    submission.setDraft(sessionDrafts.current.read(selectedId ?? NEW_SESSION_DRAFT, privateVisible))
  }, [selectedId])
  useLayoutEffect(() => {
    if (draftDevice.current !== snapshot.device.id) {
      sessionDrafts.current.clear()
      draftDevice.current = snapshot.device.id
      forgetStoredDrafts(location.origin, snapshot.device.id)
      sessionDrafts.current.bind(browserDraftStorage(location.origin, snapshot.device.id))
      submission.setDraft('')
    } else if (!access.scopes.has('view')) {
      sessionDrafts.current.clear()
      submission.setDraft('')
    } else if (!privateVisible) {
      sessionDrafts.current.clearPrivate()
      if (privateDraftId.current !== null && privateDraftId.current === selectedId) submission.setDraft('')
    }
  }, [snapshot.device.id, privateVisible, access.scopes.has('view')])
  const choice = submission.choice
  const [fileMentions, setFileMentions] = useState<FileMention[]>([])
  const released = useRef<((text: string) => void) | null>(null)
  const attachHarness = selectedId === null ? findHarness(catalog, choice.harnessId ?? catalog?.defaults.harnessId) : harnessInfo
  const attachmentDraft = useAttachments({
    // A Harness that just started, or was just tested, may take files now: read again without a reload.
    revision: JSON.stringify([attachHarness?.status, attachHarness?.attachmentsReported ?? null]),
    enabled: catalog?.features?.attachments === true && access.scopes.has('run'),
    selection: {
      // Attachments are off until the catalog arrives, and then one of these is there.
      harnessId: (selectedId === null ? choice.harnessId : summary?.harnessId) ?? catalog?.defaults.harnessId ?? '',
      ...(selectedId === null ? { workspaceId: choice.workspaceId ?? catalog?.defaults.workspaceId } : {}),
      ...((selectedId === null ? choice.model : (submission.override ?? sessionModel(summary)))
        ? { model: selectedId === null ? choice.model : (submission.override ?? sessionModel(summary)) }
        : {}),
    },
    ...(selectedId ? { sessionId: selectedId } : {}),
    locked: submission.sending || submission.pending !== null,
    // The Host takes a queued or steered message as text only (`queue-attachments-unsupported`): said before sending.
    ...(active
      ? {
          heldBack: `${steer ? '追加' : '排队'}的消息不能带附件或文件引用，本轮结束后再发送。`,
          heldRefs: fileMentions.some(ref => hasFileMention(submission.draft, ref)),
        }
      : {}),
  })
  released.current = attachmentDraft.markReleased
  const quoteSnapshots = useRef(new Map<string, { etag: string; marker: string }>())
  const mentionScope = selectedId ?? `${choice.workspaceId ?? ''}:${choice.harnessId ?? ''}:${choice.mode}:${snapshot.device.dataScope}`
  useLayoutEffect(() => {
    if (submission.pending === null) setFileMentions([])
  }, [mentionScope])
  const setSubmissionDraft = (text: string) => {
    submission.setDraft(text)
    setFileMentions(previous => previous.filter(ref => hasFileMention(text, ref)))
  }
  const mentionHarness = selectedId === null ? findHarness(catalog, choice.harnessId) : harnessInfo
  const mentionable =
    catalog?.features?.fileMentions === true
    && (selectedId === null ? choice.mode === 'agent' : summary?.mode !== 'chat')
    && mentionHarness?.capabilities.tools.fileMentions === true
  // @ would find files, but this device may not list them: the input and the @ menu say so instead of staying silent.
  const mentionsHidden = mentionable && snapshot.device.dataScope !== 'all'
  const mentionChoice = {
    enabled: mentionable && !mentionsHidden,
    ...(mentionsHidden ? { hidden: true as const } : {}),
    ...(selectedId ? { sessionId: selectedId } : {}),
    ...(choice.workspaceId && choice.workspaceId !== 'default' ? { workspaceId: choice.workspaceId } : {}),
    harnessId: mentionHarness?.id ?? '',
    refs: fileMentions.filter(ref => hasFileMention(submission.draft, ref)),
    onRefs: setFileMentions,
  }
  /** Sending found no folder to work in: the list opens, the draft stays. `notice`: a folder the Host just refused. */
  const [projectRequest, setProjectRequest] = useState(0)
  const [projectNotice, setProjectNotice] = useState<string>()
  const askProject = (notice?: string) => {
    setProjectNotice(notice)
    setProjectRequest(request => request + 1)
  }
  // A setting picked a moment before sending goes first, or the session would refuse it and run the turn on the old one.
  const settingsLanded = async () => {
    if (selectedId !== null) await configFlights.current.get(selectedId)
  }
  const sendDraft = async () => {
    if (selectedId === null && !submission.fork && needsProject(catalog, choice)) {
      askProject()
      return
    }
    if (active && (attachmentDraft.items.length > 0 || mentionChoice.refs.length > 0)) {
      submission.setError(`${steer ? '追加' : '排队'}的消息不能带附件或文件引用，本轮结束后再发送。`)
      return
    }
    await settingsLanded()
    const ids = await attachmentDraft.wait()
    if (ids && selectedId !== null) clearUnverified(selectedId)
    const followUp = !active ? undefined : steer ? 'steer' : canQueue ? 'queue' : undefined
    if (ids && (await submission.submit(undefined, undefined, followUp, ids, mentionChoice.refs))) {
      attachmentDraft.clear()
      setFileMentions([])
    }
  }
  const [abandoning, setAbandoning] = useState(false)
  const retryDraft = async () => {
    const held = submission.pending
    if (!held || abandoning) return
    await settingsLanded()
    // A prompt sent again never took the input's attachments or file references, so its delivery leaves them.
    if ((await submission.submit(held)) && fromInput(held)) {
      attachmentDraft.clear()
      setFileMentions([])
    }
  }
  /** Requests with attachments this page has already sent once more because their session listed them. */
  const listedRetries = useRef(new Set<string>())
  /**
   * The Host lists the pending submission in its session, so it was delivered and stops holding the input. With
   * attachments the Host may list it before it has recorded them and ask for the same request again
   * (`attachment-publish-unknown`): that request goes once more, silently, and is settled only by its answer, or by
   * the person giving up (`givingUp`).
   */
  const settleListed = useStableCallback(async (held: NonNullable<typeof submission.pending>, givingUp: boolean) => {
    if (held.attachmentIds?.length) {
      if (!listedRetries.current.has(held.requestId)) {
        listedRetries.current.add(held.requestId)
        await settingsLanded()
        if ((await submission.submit(held)) && held.sessionId === selectedId && fromInput(held)) {
          attachmentDraft.clear()
          setFileMentions([])
        }
        return
      }
      if (!givingUp) return
    }
    if (!submission.delivered(held)) return
    // A prompt sent again never was the input: what is being written stays, here and as the session's draft.
    if (fromInput(held)) {
      if (held.sessionId === selectedId) {
        attachmentDraft.clear()
        setFileMentions([])
      } else if (held.sessionId !== undefined && sessionDrafts.current.read(held.sessionId, privateVisible).trim() === held.prompt.trim())
        // The text waiting as that session's draft is what was just delivered, as a sent message takes it away.
        sessionDrafts.current.remove(held.sessionId)
    }
    setToast({ text: '已送达', tone: 'ok' })
  })
  const held = submission.pending
  useEffect(() => {
    if (held && !submission.sending && deliveredSubmission(held, current)) void settleListed(held, false)
  }, [held, submission.sending, current, settleListed])
  /** The open session's queue holds the same text as the pending queued submission, perhaps another device's. */
  const pendingQueued = queuedTwin(held, current)
  /**
   * 放弃这次提交. The session is read afresh first (the copy on screen only when that read fails): a submission it lists
   * was delivered. Otherwise this device lets go of it and keeps its text as a draft of where it was written;
   * attachments and file references are added again. A queue item with the same text stays, and the person is told.
   */
  const abandonPending = async () => {
    const pending = submission.pending
    if (!pending || submission.sending || submission.sendingElsewhere || abandoning) return
    setAbandoning(true)
    let twin: ReturnType<typeof queuedTwin> = null
    try {
      if (pending.sessionId !== undefined) {
        const id = pending.sessionId
        const fresh = await api<TaskDetail>(`tasks/${encodeURIComponent(id)}`, { timeoutMs: 5_000 }).catch(() => null)
        const detail = fresh ?? (current?.summary.id === id ? current : null)
        if (deliveredSubmission(pending, detail)) {
          await settleListed(pending, true)
          return
        }
        twin = queuedTwin(pending, detail)
      }
      const dropped = submission.abandon()
      if (!dropped) return
      const attached = (pending.attachmentIds?.length ?? 0) > 0
      if (dropped.restored && (attached || pending.fileRefs?.length)) {
        // They were reserved for the request just given up; the Host refuses them for a new one (`attachment-claimed`).
        attachmentDraft.clear()
        setFileMentions([])
      }
      if (twin) setToast({ text: '队列里同样文字的一条还在，在队列里发送或移除', tone: 'ok' })
      else if (attached || pending.fileRefs?.length) setToast({ text: '附件和文件引用需要重新添加', tone: 'ok' })
      if (dropped.restored || !dropped.text) return
      const home = dropped.sessionId ?? NEW_SESSION_DRAFT
      if (!sessionDrafts.current.read(home, privateVisible))
        sessionDrafts.current.save(
          home,
          dropped.text,
          dropped.sessionId !== null && privateSession(snapshot.tasks.find(task => task.id === dropped.sessionId)),
        )
    } finally {
      setAbandoning(false)
    }
  }
  // A Host that records no run times: the time since this page saw the run start, or nothing.
  const pageRunElapsed = useRunClock(snapshot.tasks, selectedId)
  const sendingView = sendingMessageFor(snapshot, submission.sendingMessage, selectedId, current)
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  const waiting = waitingCount(snapshot)
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Latch` : 'Latch'
  }, [waiting])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => {
      setToast(null)
    }, 3500)
    return () => {
      clearTimeout(timer)
    }
  }, [toast])
  useEffect(() => {
    if (harness.removed) setToast({ text: '会话已被删除', tone: 'ok' })
  }, [harness.removed])

  // Per-device read markers; the selected session is read while it is open.
  const seenKey = `latch.seen.${location.origin}.${snapshot.device.id}`
  const [seen, setSeen] = useState<SeenState>(() => readSeen(seenKey) ?? emptySeen())
  useEffect(() => {
    if (current) setSeen(previous => markSeen(previous, current.summary.id, current.summary.updatedAt))
  }, [current?.summary.id, current?.summary.updatedAt])
  useEffect(() => {
    setSeen(previous => (Object.keys(previous.seen).length > snapshot.tasks.length + 50 ? pruneSeen(previous, snapshot.tasks) : previous))
  }, [snapshot.tasks])
  useEffect(() => {
    writeSeen(seenKey, seen)
  }, [seenKey, seen])
  const unread = useCallback((task: TaskSummary) => isUnread(task, seen), [seen])

  useEffect(() => {
    // The list can pass over a settlement: a newer run is not the one being stopped.
    const running = (id: string) =>
      snapshot.tasks.some(task => {
        const stopped = stoppedRuns.current.get(id)
        return task.id === id && isActive(task.status) && (stopped === undefined || task.runId === undefined || task.runId === stopped)
      })
    setCancelling(previous => {
      const next = new Set([...previous].filter(running))
      return next.size === previous.size ? previous : next
    })
    setCancelUncertain(previous => {
      const next = new Set([...previous].filter(running))
      return next.size === previous.size ? previous : next
    })
    // An approval the Host no longer lists was settled, by this device or another: nothing is left to retry or explain.
    setApprovalStatuses(previous => {
      const open = new Set(snapshot.approvals.map(approval => approval.id))
      const next = new Map([...previous].filter(([id]) => open.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [snapshot])

  const choose = useStableCallback((id: string | null): void => {
    // An editor's unsaved text in this session: the guard asks first, and comes back here once it may go.
    if (id !== selectedId && selectedId !== null && requestLeave(selectedId, () => choose(id))) return
    const handed = id === null ? undefined : takeHandedDraft(id)
    if (handed && id === selectedId) submission.setDraft(previous => joinDraft(previous, handed))
    if (id !== selectedId || id === null) {
      if (selectedId !== null) {
        const hidden = summary === undefined || privateSession(summary) || privateDraftId.current === selectedId
        if (!privateVisible && hidden) sessionDrafts.current.remove(selectedId)
        else if (!sessionDrafts.current.save(selectedId, submission.draft, hidden)) {
          setToast({ text: '草稿超出临时缓存上限，请先复制或缩短内容后再切换。', tone: 'error' })
          return
        }
      } else if (id !== null) sessionDrafts.current.save(NEW_SESSION_DRAFT, submission.draft, false)
      // 新会话 pressed on 新会话 starts over; coming back from a session finds what was being written.
      if (selectedId === null && id === null) sessionDrafts.current.remove(NEW_SESSION_DRAFT)
      submission.setDraft(joinDraft(sessionDrafts.current.read(id ?? NEW_SESSION_DRAFT, privateVisible), handed))
      draftSessionId.current = id
    }
    onBeforeSelect(id)
    select(id)
    submission.setError('')
    setActionError(previous => (previous?.sessionId === id ? previous : null))
  })
  const failAction = (sessionId: string, text: string) => {
    setActionError({ sessionId, text })
  }
  const clearAction = (sessionId: string) => {
    setActionError(previous => (previous?.sessionId === sessionId ? null : previous))
  }
  // A confirmation refused for a running full-access session names it: 查看会话 opens it, 停止会话 stops it.
  const openBlocking = useStableCallback((id: string) => {
    openSession(id)
  })
  const stopBlocking = useStableCallback(async (id: string) => {
    await cancelSession(id)
  })
  useLayoutEffect(() => {
    provideSessionLinks({ open: openBlocking, stop: stopBlocking, snapshot })
    return () => {
      provideSessionLinks(null)
    }
  }, [openBlocking, stopBlocking, snapshot])
  const { reveal, jumpToLatest } = reading
  /** The session that waits longest: its oldest request, or else a run that has gone quiet. */
  const openApprovals = () => {
    const oldest = [...snapshot.approvals].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0]
    if (oldest) {
      choose(oldest.sessionId)
      reading.show(oldest.sessionId, toolRowId(oldest))
      return
    }
    const quiet = snapshot.tasks
      .filter(waitsOnYou)
      .toSorted((a, b) => (a.live?.lastEventAt ?? '').localeCompare(b.live?.lastEventAt ?? ''))[0]
    if (quiet) choose(quiet.id)
  }

  const previousApprovals = useRef(new Set(snapshot.approvals.map(item => item.id)))
  const [approvalToast, setApprovalToast] = useState<{ sessionId: string; id: string } | null>(null)
  useEffect(() => {
    const other = snapshot.approvals.find(item => !previousApprovals.current.has(item.id) && item.sessionId !== selectedId)
    previousApprovals.current = new Set(snapshot.approvals.map(item => item.id))
    if (other) setApprovalToast({ sessionId: other.sessionId, id: other.id })
  }, [snapshot.approvals, selectedId])
  useEffect(() => {
    if (!approvalToast) return
    // Opened by any way: it is no longer another session, and the toast must not hide what this one says.
    if (approvalToast.sessionId === selectedId) {
      setApprovalToast(null)
      return
    }
    const timer = setTimeout(() => setApprovalToast(null), 6000)
    return () => clearTimeout(timer)
  }, [approvalToast, selectedId])
  const approvalCursor = useRef<string | null>(null)
  const [approvalFocus, setApprovalFocus] = useState<string | null>(null)
  const nextApproval = useStableCallback(() => {
    const ordered = snapshot.approvals.toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    if (!ordered.length) return
    const currentIndex = ordered.findIndex(item => item.id === approvalCursor.current)
    const target = ordered[(currentIndex + 1) % ordered.length]!
    approvalCursor.current = target.id
    setApprovalFocus(target.id)
    choose(target.sessionId)
    reading.show(target.sessionId, toolRowId(target))
  })
  /**
   * A notification names a session: `arriving` goes there at once. Then it reaches the oldest request there, marked as
   * 下一个 marks it, and says true when nothing is left to do: reached, or the person has gone elsewhere since.
   */
  const openNotified = useStableCallback((id: string, arriving: boolean) => {
    if (arriving) choose(id)
    else if (selectedId !== id) return true
    const target = snapshot.approvals
      .filter(item => item.sessionId === id)
      .toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0]
    if (!target) return false
    approvalCursor.current = target.id
    setApprovalFocus(target.id)
    reading.show(id, toolRowId(target))
    return true
  })
  const focusedApproval = snapshot.approvals.find(item => item.id === approvalFocus)
  const approvalFocusRow = focusedApproval && toolRowId(focusedApproval)
  const approvalFocusSession = focusedApproval?.sessionId
  useEffect(() => {
    if (!approvalFocusRow || current?.summary.id !== approvalFocusSession) return
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`.transcript [data-message-id="${CSS.escape(approvalFocusRow)}"]`)
      if (row) {
        row.tabIndex = -1
        row.focus({ preventScroll: true })
        row.setAttribute('data-approval-target', '')
      }
    })
    const timer = setTimeout(() => {
      document.querySelectorAll('[data-approval-target]').forEach(row => row.removeAttribute('data-approval-target'))
      setApprovalFocus(null)
    }, 2500)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [approvalFocusRow, approvalFocusSession, current?.summary.id])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        event.code === 'KeyA'
        && event.altKey
        && (currentShell() ? event.metaKey : event.shiftKey)
        && !document.querySelector('dialog[open]')
      ) {
        event.preventDefault()
        nextApproval()
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [nextApproval])
  // `note`: with a rejection, for a harness that hands it on, what to do instead (see `rejectionNoteFor`).
  const decide = useCallback(
    async (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined, note?: string): Promise<boolean> => {
      if (approvalFlights.current.has(approval.id)) return false
      // False once the choice definitely did not take effect; an unknown outcome keeps its note on the card's retry.
      let taken = true
      approvalFlights.current.add(approval.id)
      setApprovalBusy(previous => new Map(previous).set(approval.id, optionId ?? (decision === 'allow' ? 'allow_once' : 'reject_once')))
      clearAction(approval.sessionId)
      // One requestId per decision, reused when the same choice is retried after an unknown outcome.
      const requestId = decisions.current.idFor(approval.id, decision, optionId, note)
      const body = { decision, requestId, ...(optionId ? { optionId } : {}), ...(note && decision === 'reject' ? { note } : {}) }
      const mark = (status: ApprovalStatus) => {
        setApprovalStatuses(previous => {
          if (Object.keys(status).length === 0 && !previous.has(approval.id)) return previous
          const next = new Map(previous)
          if (Object.keys(status).length > 0) next.set(approval.id, status)
          else next.delete(approval.id)
          return next
        })
      }
      mark({})
      try {
        await api<unknown>(`approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body })
        decisions.current.settle(approval.id)
        await refresh()
      } catch (cause) {
        decisions.current.settle(approval.id, cause)
        const optionKind = choiceKind(approval, decision, optionId)
        const settled = settledOutcome(cause, { decision, ...(optionKind ? { optionKind } : {}) })
        const unknown = settled === undefined && isUncertain(cause)
        taken = unknown || settled?.applied === true
        // An unknown outcome stays on the card, which offers to send the same choice again with the same requestId; a
        // reason the card already shows (a confirmation that did not pass) stays too; anything else clears it.
        if (unknown) mark({ uncertain: { decision, optionId, ...(note && decision === 'reject' ? { note } : {}) } })
        else mark({})
        if (settled === undefined) {
          const text = unknown ? '' : inlineError(cause)
          if (text) failAction(approval.sessionId, text)
        } else if (!settled.applied && settled.conflict) failAction(approval.sessionId, settled.message)
        else if (!settled.applied) setToast({ text: settled.message, tone: 'ok' })
        await refresh()
      } finally {
        approvalFlights.current.delete(approval.id)
        setApprovalBusy(previous => {
          const next = new Map(previous)
          next.delete(approval.id)
          return next
        })
      }
      return taken
    },
    [refresh],
  )

  const cancelSession = useStableCallback(async (id: string) => {
    if (cancelling.has(id) && !cancelUncertain.has(id)) return
    // The run on screen: a stop that arrives after it ended must not stop the next one.
    const runId = (current?.summary.id === id ? current.summary : snapshot.tasks.find(task => task.id === id))?.runId
    if (runId === undefined) stoppedRuns.current.delete(id)
    else stoppedRuns.current.set(id, runId)
    setCancelling(previous => new Set(previous).add(id))
    setCancelUncertain(previous => without(previous, id))
    clearAction(id)
    try {
      const answer = cancelAnswer(
        await api<unknown>(`tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: cancels.current.bodyFor(id, runId) }),
      )
      cancels.current.settle(id)
      if (answer === 'ended' || answer === 'newer') {
        setCancelling(previous => without(previous, id))
        setToast({ text: answer === 'newer' ? '那一轮已经结束，新的一轮仍在运行' : '这一轮已经结束，无需停止', tone: 'ok' })
      }
      await refresh()
    } catch (cause) {
      cancels.current.settle(id, cause)
      // An unknown outcome is said once, in the bar above the input with its 重试; it is not a failure.
      if (isUncertain(cause)) setCancelUncertain(previous => new Set(previous).add(id))
      else {
        failAction(id, errorMessage(cause))
        setCancelling(previous => without(previous, id))
      }
      throw cause
    }
  })

  const setConfig = async (configId: string, value: string) => {
    if (selectedId === null) return
    const id = selectedId
    const request = configRequests.current.begin(id, configId, value)
    if (!request) return
    setConfigBusy(previous => new Map(previous).set(id, configId))
    setConfigFeedback(previous => {
      const next = new Map(previous)
      next.delete(id)
      return next
    })
    clearAction(id)
    let settled!: () => void
    const flight = new Promise<void>(resolve => {
      settled = resolve
    })
    configFlights.current.set(id, flight)
    try {
      await api<unknown>(`tasks/${encodeURIComponent(id)}/config`, {
        method: 'POST',
        body: { configId, value, ...(catalog?.features?.configReceipts === true ? { requestId: request.requestId } : {}) },
      })
      configRequests.current.settle(id, request)
      await refresh()
    } catch (cause) {
      configRequests.current.settle(id, request, cause)
      stopSession(id, cause, { from: 'config' })
      const text = cause instanceof ApiError && cause.code === 'permission-unverified' ? CONFIG_UNVERIFIED_TEXT : inlineError(cause)
      setConfigFeedback(previous =>
        new Map(previous).set(id, {
          kind: isUncertain(cause) ? 'unknown' : 'failed',
          message: isUncertain(cause) ? '切换结果还未确认，请刷新设置查看结果。' : text || '设置未更改，请重新选择。',
        }),
      )
      if (text && !(cause instanceof ApiError && isSessionStopCode(cause.code))) failAction(id, text)
    } finally {
      setConfigBusy(previous => {
        const next = new Map(previous)
        next.delete(id)
        return next
      })
      if (configFlights.current.get(id) === flight) configFlights.current.delete(id)
      settled()
    }
  }

  const refreshConfig = async () => {
    if (selectedId === null) return
    const id = selectedId,
      request = configRequests.current.get(id)
    try {
      const next = await api<TaskDetail>(`tasks/${encodeURIComponent(id)}`)
      const receipt =
        request && catalog?.features?.configReceipts === true
          ? await api<{ state: string }>(`tasks/${encodeURIComponent(id)}/config-requests/${request.requestId}`)
          : undefined
      if (!request || configRequests.current.reconcile(id, request, next.config ?? [], receipt?.state))
        setConfigFeedback(previous => {
          const updated = new Map(previous)
          if (receipt?.state === 'failed') updated.set(id, { kind: 'failed', message: '设置未能切换，当前仍是原来的值。' })
          else updated.delete(id)
          return updated
        })
      await refresh()
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  }

  // A local action says nothing when it works: the row moving or folding away is the feedback. Failures are toasts.
  const patchTask = useStableCallback(async (task: TaskSummary, patch: { pinned?: boolean; archived?: boolean }) => {
    try {
      await api<unknown>(`tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: patch })
      await refresh()
      return true
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
      return false
    }
  })
  const [archivedLast, setArchivedLast] = useState<TaskSummary | null>(null)
  const undoArchive = useStableCallback(() => {
    if (archivedLast) void patchTask(archivedLast, { archived: false })
    setArchivedLast(null)
  })
  const forgetArchive = useStableCallback(() => {
    setArchivedLast(null)
  })
  const exportTask = useStableCallback(async (task: TaskSummary) => {
    try {
      const data = task.id === current?.summary.id ? current : await api<TaskDetail>(`tasks/${encodeURIComponent(task.id)}`)
      await saveText(
        exportFileName(data.summary.title),
        transcriptMarkdown(data, { harness: sessionHarness(catalog, data.summary)?.capabilities.display.label }),
      )
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  const manageable = catalog !== undefined
  const copyTask = useStableCallback(async (task: TaskSummary) => {
    try {
      const data = task.id === current?.summary.id ? current : await api<TaskDetail>(`tasks/${encodeURIComponent(task.id)}`)
      await navigator.clipboard.writeText(transcriptMarkdown(data))
      setToast({ text: '已复制 Markdown', tone: 'ok' })
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  const saveSessionProject = useStableCallback(async (task: TaskSummary) => {
    try {
      const result = await shellFolders()!.saveSessionFolder!(task.id)
      if (result.status === 'added') {
        await refresh()
        setToast(
          result.refused.length
            ? { text: '没有保存这个会话的文件夹，请在项目设置中重试。', tone: 'error' }
            : { text: '已存为项目', tone: 'ok' },
        )
      } else if (result.status === 'busy') setToast({ text: '另一个系统对话框还没结束。', tone: 'error' })
      else if (result.status === 'failed') setToast({ text: '没有保存这个会话的文件夹，请同步后重试。', tone: 'error' })
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  const sessionMenu = useCallback(
    (task: TaskSummary): MenuSection[] =>
      sessionMenuSections(
        task,
        {
          unread: () => {
            setSeen(previous => markUnread(previous, task.id))
          },
          copy: () => {
            void copyTask(task)
          },
          rename: () => {
            setRenaming(task)
          },
          pin: () => {
            void patchTask(task, { pinned: !task.pinned })
          },
          archive: () => {
            void patchTask(task, { archived: !task.archived }).then(done => {
              if (done) setArchivedLast(task.archived ? null : task)
            })
          },
          export: () => {
            void exportTask(task)
          },
          remove: () => {
            setDeleting(task)
          },
          ...(task.worktree
          && !task.worktree.removed
          && catalog?.features?.worktreeLifecycle
          && access.scopes.has('run')
          && access.device?.dataScope !== 'work'
            ? {
                removeWorktree: () => {
                  setRemovingWorktree(task)
                },
              }
            : {}),
          ...(clearable && task.id === selectedId
            ? {
                clear: () => {
                  armClear(!clearing)
                },
                clearing,
              }
            : {}),
          ...(access.local
          && access.admin
          && shellFolders()?.saveSessionFolder
          && task.sessionFolder
          && catalog
          && !projectOf(task, catalog.workspaces)
            ? {
                saveProject: () => {
                  void saveSessionProject(task)
                },
              }
            : {}),
        },
        manageable,
      ),
    [
      patchTask,
      exportTask,
      copyTask,
      manageable,
      setRenaming,
      setDeleting,
      access,
      catalog,
      saveSessionProject,
      clearable,
      selectedId,
      clearing,
      armClear,
    ],
  )

  const block = selectedId === null ? startBlock(snapshot, choice) : null
  const chosenHarness = selectedId === null ? catalog?.harnesses.find(item => item.id === choice.harnessId) : undefined
  const chosenScopeCaption =
    choice.mode === 'chat'
      ? undefined
      : projectScopeCaption(
          catalog?.workspaces.find(project => project.id === choice.workspaceId),
          chosenHarness,
        )
  const startsL3 = !access.legacy && chosenHarness !== undefined && chosenHarness.level === 'L3'
  const stopCode: SessionStopCode | undefined =
    selectedId === null ? undefined : summary?.permissionDrift || current?.permission?.drift ? 'permission-drift' : stopped.get(selectedId)
  const refusedInput = selectedId === null ? undefined : refused.get(selectedId)
  const stopText =
    stopCode === 'permission-unverified' && refusedInput?.from === 'config'
      ? CONFIG_UNVERIFIED_TEXT
      : stopCode && SESSION_STOP_LABEL[stopCode]
  const stopRetry =
    stopCode === undefined || stopLocksInput(stopCode)
      ? undefined
      : retryOfRefused(refusedInput, { draft: submission.draft, attachments: attachmentDraft.items.length })
  const resend = async (prompt: string) => {
    if (selectedId === null) return
    clearUnverified(selectedId)
    await settingsLanded()
    await submission.resend(prompt)
  }
  const retryStopped = () => {
    if (stopRetry?.kind === 'draft') void sendDraft()
    else if (stopRetry?.kind === 'prompt') void resend(stopRetry.prompt)
  }
  // Rebuilt as text into another session: this one stays to read, and links there.
  const rebuiltInto = summary ? rebuiltFrom(snapshot.tasks, summary.id) : undefined
  const gate =
    rebuiltInto !== undefined
      ? { kind: 'read-only' as const, text: '已按文字重建为新会话 · 这个会话只能查看' }
      : selectedId === null
        ? access.legacy || access.scopes.has('run')
          ? { kind: 'open' as const }
          : { kind: 'read-only' as const, text: '此设备没有「发起和继续会话」权限' }
        : composerGate({
            summary,
            permission: current?.permission,
            access,
            stopped: stopCode !== undefined && stopLocksInput(stopCode),
          })
  const sessionBlock =
    selectedId === null
      ? undefined
      : summary?.worktree?.removed
        ? '工作树已移除 · 只能查看'
        : workspaceChanged.has(selectedId)
          ? '选择一个项目继续，当前草稿会保留。'
          : harnessInfo?.status === 'unavailable'
            ? harnessInfo.statusMessage || `${harnessLabel(harnessInfo)} 暂不可用`
            : !catalog && snapshot.execution?.ready === false
              ? '当前模型接口不可用，请检查模型插件状态。'
              : undefined
  const [approvalIndex, setApprovalIndex] = useState(0)
  useEffect(() => {
    setApprovalIndex(0)
  }, [selectedId])
  const shownApproval = approvals[Math.min(approvalIndex, approvals.length - 1)]
  const earlierDraft = useEarlierDraft(
    useMemo(() => [...approvals.map(item => item.id), ...(current?.questions ?? []).map(item => item.id)], [approvals, current?.questions]),
    submission.draft,
  )
  // While an approval waits, what is typed goes back with the rejection, where the Host takes a note.
  const rejection = useRejectionNote({
    selectedId,
    approval: shownApproval,
    mayType: selectedId !== null && gate.kind === 'open' && sessionBlock === undefined && submission.pending === null && !earlierDraft.held,
    harnessTakesNote: harnessInfo?.capabilities.permission.rejectionNote === true,
    draft: submission.draft,
    clearDraft: () => {
      submission.setDraft('')
    },
    restoreDraft: (sessionId, text) => {
      if (draftSessionId.current === sessionId) submission.setDraft(previous => (previous.trim() ? previous : text))
      else if (!sessionDrafts.current.read(sessionId, privateVisible))
        sessionDrafts.current.save(sessionId, text, privateSession(snapshot.tasks.find(task => task.id === sessionId)))
    },
    decide: (approval, optionId, note) => decide(approval, 'reject', optionId, note),
    rejectOption: approval => {
      const gated = gateFor(approval)
      const reject =
        gated.options.find(option => option.kind === 'reject_once') ?? gated.options.find(option => !option.kind.startsWith('allow'))
      return gated.explicit ? reject?.id : undefined
    },
  })
  const onDecide = useStableCallback(
    (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined, again?: { note?: string }) => {
      if (decision === 'reject' && again === undefined) rejection.reject(approval, optionId)
      else void decide(approval, decision, optionId, again?.note)
    },
  )
  const statuses = approvalStatuses
  const noteComposer = rejection.composer
  // A new Agent session in a folder inside Latch's program directory: every write will ask on the Host's computer.
  const codeRootChoice =
    selectedId === null && !startsL3 && choice.mode !== 'chat'
      ? codeRootWorkspace(catalog?.workspaces, { id: choice.workspaceId })
      : undefined
  const currentModel = sessionModel(summary)
  const effectiveModel = submission.override ?? currentModel
  const mode = selectedId === null ? choice.mode : (summary?.mode ?? 'agent')
  const phase = current?.activity?.phase
  const cancelState =
    selectedId !== null && cancelUncertain.has(selectedId)
      ? 'uncertain'
      : selectedId !== null && (cancelling.has(selectedId) || phase === 'cancelling')
        ? 'cancelling'
        : 'idle'
  const run: RunState | undefined =
    selectedId !== null && active
      ? {
          id: selectedId + ':' + (summary?.runId ?? ''),
          cancel: cancelState,
          onCancel: () => {
            if (selectedId !== null) void cancelSession(selectedId).catch(() => {})
          },
        }
      : undefined
  const fallbackElapsed = current?.runStartedAt === undefined ? pageRunElapsed : undefined
  const providerName = useCallback((id: string) => findProvider(catalog, id)?.name, [catalog])
  // Resending the latest turn is the same as typing its prompt again: only where this device may send now.
  const retry =
    selectedId !== null
    && !active
    && gate.kind === 'open'
    && sessionBlock === undefined
    && submission.pending === null
    && !submission.sending
      ? {
          onResend: (prompt: string) => {
            void resend(prompt)
          },
        }
      : undefined
  const askedQuestion = current?.questions?.[0]?.state === 'answering' ? undefined : current?.questions?.[0]
  const startWords = mode === 'chat' ? '写下问题或想法…' : mentionsHidden ? `${NO_PROJECT_FILES}，/ 命令` : '@ 文件，/ 命令'
  // A topic of a conversation in 我的 Agent says whom the message goes to.
  const topicName = selectedId !== null && summary ? sessionAgent(snapshot, summary)?.name : undefined
  const placeholder =
    submission.pending !== null
      ? '等待确认上一条提交…'
      : gate.kind === 'stopped'
        ? '这个会话不再接收输入'
        : askedQuestion && gate.kind === 'open'
          ? '输入你自己的回答'
          : selectedId === null
            ? startWords
            : active
              ? catalog?.features?.queue
                ? '补充或排队一条消息'
                : '可以先写，本轮结束后发送…'
              : topicName
                ? `给${topicName}发消息…`
                : mode === 'chat'
                  ? '不读写文件、不运行命令'
                  : startWords

  return {
    privateVisible,
    sessionDrafts,
    draftSessionId,
    draftDevice,
    privateDraftId,
    current,
    summary,
    composerRef,
    renaming,
    setRenaming,
    deleting,
    setDeleting,
    removingWorktree,
    setRemovingWorktree,
    toast,
    setToast,
    actionError,
    setActionError,
    approvalBusy,
    setApprovalBusy,
    approvalStatuses,
    setApprovalStatuses,
    approvalIndex,
    setApprovalIndex,
    approvalFlights,
    cancelling,
    setCancelling,
    cancelUncertain,
    setCancelUncertain,
    stopping,
    configBusy,
    setConfigBusy,
    configRequests,
    configFeedback,
    setConfigFeedback,
    recoveryProjects,
    setRecoveryProjects,
    workspaceChanged,
    setWorkspaceChanged,
    now,
    setNow,
    stopped,
    setStopped,
    decisions,
    cancels,
    catalog,
    shell,
    host,
    scopesKey,
    access,
    owner,
    canQueue,
    steer,
    gateFor,
    approvals,
    active,
    harnessInfo,
    harnessName,
    reading,
    stopSession,
    submission,
    choice,
    attachmentDraft,
    fileMentions,
    setFileMentions,
    quoteSnapshots,
    mentionScope,
    setSubmissionDraft,
    mentionChoice,
    sendDraft,
    retryDraft,
    abandonPending,
    abandoning,
    pendingQueued,
    askProject,
    projectAsk: {
      request: projectRequest,
      notice: projectNotice,
      clearNotice: () => {
        setProjectNotice(undefined)
      },
    },
    pageRunElapsed,
    sendingView,
    seenKey,
    seen,
    setSeen,
    unread,
    choose,
    failAction,
    clearAction,
    openBlocking,
    stopBlocking,
    reveal,
    jumpToLatest,
    openApprovals,
    previousApprovals,
    approvalToast,
    setApprovalToast,
    approvalCursor,
    approvalFocus,
    setApprovalFocus,
    nextApproval,
    openNotified,
    archivedLast,
    undoArchive,
    forgetArchive,
    focusedApproval,
    approvalFocusRow,
    approvalFocusSession,
    decide,
    cancelSession,
    setConfig,
    refreshConfig,
    patchTask,
    exportTask,
    manageable,
    copyTask,
    sessionMenu,
    clearable,
    armClear,
    block,
    chosenHarness,
    chosenScopeCaption,
    startsL3,
    stopCode,
    stopText,
    stopRetry,
    rebuiltInto,
    retryStopped,
    refusedInput,
    gate,
    sessionBlock,
    earlierDraft,
    rejection,
    onDecide,
    statuses,
    noteComposer,
    codeRootChoice,
    currentModel,
    effectiveModel,
    mode,
    phase,
    cancelState,
    run,
    fallbackElapsed,
    providerName,
    retry,
    placeholder,
  }
}
