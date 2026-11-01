import type { AppSnapshot } from '@latch/protocol'
import type { useHarness } from '../core/useHarness.ts'
import { hasFileMention } from '../fileMentions.ts'
import type { FileMention } from '@latch/protocol'
import { useAttachments } from '../hooks/useAttachments.ts'
import { projectScopeCaption } from '../projects.tsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Approval, TaskDetail, TaskSummary, PersonalAssistantSummary } from '@latch/protocol'
import { api, ApiError, errorMessage, inlineError, isUncertain } from '../core/api.ts'
import { choiceKind, DecisionRequests, settledOutcome } from '../core/approvalDecision.ts'
import { cancelAnswer, CancelRequests } from '../core/cancelRequest.ts'
import { ConfigRequests } from '../core/configRequest.ts'
import { SessionDrafts } from '../core/sessionDrafts.ts'
import type { SessionConfigFeedback } from '../components/modelReasoning.ts'
import { findHarness, findProvider, harnessName as harnessLabel, sessionHarness, sessionModel, startBlock } from '../composerChoice.ts'
import { openSession } from '../core/blocking.ts'
import { ConfirmationError, withConfirmation, type ConfirmationPresenter } from '../core/confirmations.ts'
import { provideSessionLinks } from '../core/sessionLinks.ts'
import { exportFileName, saveText, transcriptMarkdown } from '../exportMarkdown.ts'
import { isActive } from '../format.ts'
import { approvalActions, composerGate, deviceAccess, harnessLevel, hostView } from '../core/permissions.ts'
import { setPreference } from '../preferences.ts'
import { isSessionStopCode, type SessionStopCode } from '../core/securityCopy.ts'
import { sessionMenuSections } from '../sessionMenu.ts'
import { emptySeen, isUnread, markSeen, markUnread, pruneSeen, readSeen, writeSeen, type SeenState } from '../sessions.ts'
import { useReadingPosition } from '../core/useReadingPosition.ts'
import { useApprovalVisibility, useApprovalsInView } from '../hooks/useApprovalsInView.ts'
import { currentShell } from '../core/shell.ts'
import { useRejectionNote } from '../hooks/useRejectionNote.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { useRunClock } from '../hooks/useRunClock.ts'
import { useSubmission } from '../hooks/useSubmission.ts'
import { usePersonalName } from '../hooks/usePersonalName.ts'
import { useSwitchFade } from '../hooks/useSwitchFade.ts'
import { type RunState } from '../components/Composer.tsx'
import { type MenuSection } from '../components/overlays.tsx'
import { type ApprovalStatus } from '../components/ApprovalCard.tsx'
import { codeRootWorkspace } from '../components/CodeRootNotice.tsx'
import { sendingMessageFor } from '../core/sendingMessage.ts'
import { toolRowId } from '../conversation.ts'

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
  const sessionDrafts = useRef(new SessionDrafts())
  const draftSessionId = useRef(selectedId)
  const draftDevice = useRef(snapshot.device.id)
  const privateDraftId = useRef<string | null>(null)
  const [personalDraft, setPersonalDraft] = useState<PersonalAssistantSummary | null>(null)
  const [personalGroupId, setPersonalGroupId] = useState<string | undefined>()
  useLayoutEffect(() => {
    if (!privateVisible) {
      setPersonalDraft(null)
      setPersonalGroupId(undefined)
    }
  }, [privateVisible])
  const current = detail?.summary.id === selectedId && (!detail.summary.personal || privateVisible) ? detail : null
  const summary = current?.summary ?? snapshot.tasks.find(task => task.id === selectedId && (!task.personal || privateVisible))
  if (summary?.personal && selectedId) privateDraftId.current = selectedId
  else if (privateDraftId.current !== selectedId) privateDraftId.current = null
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [renaming, setRenaming] = useState<TaskSummary | null>(null)
  const [deleting, setDeleting] = useState<TaskSummary | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [approvalBusy, setApprovalBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const [approvalStatuses, setApprovalStatuses] = useState<ReadonlyMap<string, ApprovalStatus>>(new Map())
  const approvalFlights = useRef(new Set<string>())
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const [cancelUncertain, setCancelUncertain] = useState<ReadonlySet<string>>(new Set())
  // A stop whose answer never came is not known to be under way: only the bar above the input speaks of it.
  const stopping = useMemo(() => new Set([...cancelling].filter(id => !cancelUncertain.has(id))), [cancelling, cancelUncertain])
  const [configBusy, setConfigBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const configRequests = useRef(new ConfigRequests())
  const [configFeedback, setConfigFeedback] = useState<ReadonlyMap<string, SessionConfigFeedback>>(new Map())
  const [recoveryProjects, setRecoveryProjects] = useState<ReadonlyMap<string, string>>(new Map())
  const [workspaceChanged, setWorkspaceChanged] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  /** Sessions that stopped accepting input, learned from the Host's refusal. */
  const [stopped, setStopped] = useState<ReadonlyMap<string, SessionStopCode>>(new Map())
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
  const canQueue = summary?.personal
    ? !summary.personal.groupId && catalog?.features?.personalQueue === true
    : catalog?.features?.queue === true
  const gateFor = useCallback((approval: Approval) => approvalActions(approval, access.device, shell), [access, shell])
  const approvals = useMemo(
    () => current?.approvals ?? snapshot.approvals.filter(approval => approval.sessionId === selectedId),
    [current, snapshot.approvals, selectedId],
  )
  const active = isActive(summary?.status)
  const harnessInfo = sessionHarness(catalog, summary)
  const personalName = usePersonalName(summary?.personal?.assistantId, privateVisible, harness.refreshHints + harness.resyncs)
  // The built-in harness is 「Latch 内置」 wherever the page names it.
  const harnessName = summary?.personal
    ? (personalName ?? '个人助手')
    : harnessInfo
      ? harnessLabel(harnessInfo)
      : (snapshot.harness?.name ?? 'Latch')

  const reading = useReadingPosition({
    sessionId: selectedId,
    ready: current !== null,
    contentVersion: `${current?.cursor ?? 0}:${current?.liveText.length ?? 0}:${current?.liveReasoning?.length ?? 0}:${approvals.length}`,
  })
  // Fade the content, not the masked scroller: animating the latter can leave Chromium's hit-test region empty.
  useSwitchFade(reading.contentRef, current?.summary.id ?? null)
  // The way back to a waiting approval shows only while none of the cards is in view.
  const approvalVisibility = useApprovalVisibility()
  const approvalsInView = useApprovalsInView(approvalVisibility)
  const stopSession = (sessionId: string, cause: unknown) => {
    if (cause instanceof ApiError && cause.code === 'workspace-changed') {
      setWorkspaceChanged(previous => new Set(previous).add(sessionId))
      return true
    }
    if (cause instanceof ApiError && isSessionStopCode(cause.code)) {
      const code = cause.code
      setStopped(previous => new Map(previous).set(sessionId, code))
    }
  }
  const submission = useSubmission({
    snapshot,
    access,
    selectedId,
    assistantId: personalDraft?.id,
    select,
    refresh,
    onSent: (sessionId, sent, { foreground, consumedDraft }) => {
      if (consumedDraft && sent.sessionId !== undefined) sessionDrafts.current.remove(sent.sessionId)
      if (!foreground || sent.queue) return
      draftSessionId.current = sessionId
      if (sent.sessionId === undefined) setPreference('onboarding', 'hidden')
      setPersonalDraft(null)
      onForegroundSent()
      reading.show(sessionId)
    },
    onRefused: stopSession,
  })
  // A remote deletion clears selection without going through choose; never transfer that session's text to a new task.
  useLayoutEffect(() => {
    if (draftSessionId.current === selectedId) return
    if (draftSessionId.current !== null) sessionDrafts.current.remove(draftSessionId.current)
    draftSessionId.current = selectedId
    submission.setDraft(selectedId === null ? '' : sessionDrafts.current.read(selectedId, privateVisible))
  }, [selectedId])
  useLayoutEffect(() => {
    if (draftDevice.current !== snapshot.device.id) {
      sessionDrafts.current.clear()
      draftDevice.current = snapshot.device.id
      submission.setDraft('')
    } else if (!access.scopes.has('view')) {
      sessionDrafts.current.clear()
      submission.setDraft('')
    } else if (!privateVisible) {
      sessionDrafts.current.clearPrivate()
      if ((privateDraftId.current !== null && privateDraftId.current === selectedId) || personalDraft !== null) submission.setDraft('')
    }
  }, [snapshot.device.id, privateVisible, access.scopes.has('view')])
  const choice: typeof submission.choice = personalDraft
    ? { mode: personalDraft.mode, harnessId: personalDraft.harnessId, model: personalDraft.model }
    : submission.choice
  const attachmentDraft = useAttachments({
    enabled: catalog?.features?.attachments === true && access.scopes.has('run'),
    selection: {
      harnessId: selectedId === null ? (choice.harnessId ?? catalog?.defaults.harnessId ?? 'standard') : (summary?.harnessId ?? 'standard'),
      ...(selectedId === null && !personalDraft ? { workspaceId: choice.workspaceId ?? catalog?.defaults.workspaceId } : {}),
      ...((selectedId === null ? choice.model : summary?.personal ? sessionModel(summary) : (submission.override ?? sessionModel(summary)))
        ? {
            model:
              selectedId === null
                ? choice.model
                : summary?.personal
                  ? sessionModel(summary)
                  : (submission.override ?? sessionModel(summary)),
          }
        : {}),
    },
    ...(selectedId ? { sessionId: selectedId } : {}),
    draftScope: personalDraft?.id,
    locked: submission.sending || submission.pending !== null,
  })
  const [fileMentions, setFileMentions] = useState<FileMention[]>([])
  const quoteSnapshots = useRef(new Map<string, { etag: string; marker: string }>())
  const mentionScope =
    selectedId ?? `${personalDraft?.id ?? choice.workspaceId ?? ''}:${choice.harnessId ?? ''}:${choice.mode}:${snapshot.device.dataScope}`
  useLayoutEffect(() => {
    if (submission.pending === null) setFileMentions([])
  }, [mentionScope])
  const setSubmissionDraft = (text: string) => {
    submission.setDraft(text)
    setFileMentions(previous => previous.filter(ref => hasFileMention(text, ref)))
  }
  const mentionChoice = {
    enabled:
      catalog?.features?.fileMentions === true
      && snapshot.device.dataScope === 'all'
      && (selectedId !== null || !personalDraft)
      && (selectedId === null ? choice.mode === 'agent' : summary?.mode !== 'chat')
      && (selectedId === null ? findHarness(catalog, choice.harnessId)?.source : harnessInfo?.source) !== 'plugin',
    ...(selectedId ? { sessionId: selectedId } : {}),
    ...(choice.workspaceId && choice.workspaceId !== 'default' ? { workspaceId: choice.workspaceId } : {}),
    harnessId: (selectedId === null ? choice.harnessId : summary?.harnessId) ?? 'standard',
    refs: fileMentions.filter(ref => hasFileMention(submission.draft, ref)),
    onRefs: setFileMentions,
  }
  const sendDraft = async () => {
    if (active && (attachmentDraft.items.length > 0 || mentionChoice.refs.length > 0)) {
      submission.setError('排队暂不支持附件或文件引用，请等本轮结束再发送。')
      return
    }
    const ids = await attachmentDraft.wait()
    if (ids && (await submission.submit(undefined, undefined, active && canQueue, ids, mentionChoice.refs))) {
      attachmentDraft.clear()
      setFileMentions([])
    }
  }
  const retryDraft = async () => {
    if (submission.pending && (await submission.submit(submission.pending))) {
      attachmentDraft.clear()
      setFileMentions([])
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
  useEffect(() => {
    document.title = snapshot.approvals.length ? `(${snapshot.approvals.length}) Latch` : 'Latch'
  }, [snapshot.approvals.length])
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
    const running = (id: string) => snapshot.tasks.some(task => task.id === id && isActive(task.status))
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

  const choose = useStableCallback((id: string | null) => {
    if (id !== selectedId || id === null) {
      if (selectedId !== null) {
        const personal = summary === undefined || Boolean(summary.personal) || privateDraftId.current === selectedId
        if (!privateVisible && personal) sessionDrafts.current.remove(selectedId)
        else if (!sessionDrafts.current.save(selectedId, submission.draft, personal)) {
          setToast({ text: '草稿超出临时缓存上限，请先复制或缩短内容后再切换。', tone: 'error' })
          return
        }
      }
      submission.setDraft(id === null ? '' : sessionDrafts.current.read(id, privateVisible))
      draftSessionId.current = id
    }
    setPersonalDraft(null)
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
  const revealApprovals = () => {
    const target = approvals[0]
    if (selectedId !== null) reading.show(selectedId, target && toolRowId(target))
  }

  const openApprovals = () => {
    const oldest = [...snapshot.approvals].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0]
    if (!oldest) return
    choose(oldest.sessionId)
    reading.show(oldest.sessionId, toolRowId(oldest))
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
    const timer = setTimeout(() => setApprovalToast(null), 6000)
    return () => clearTimeout(timer)
  }, [approvalToast])
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
  // `note`: with a rejection of the built-in harness's approval, what to do instead (see `rejectionNoteFor`).
  const decide = useCallback(
    async (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined, note?: string) => {
      if (approvalFlights.current.has(approval.id)) return
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
      // The card's button waits while the system sheet is open, and a confirmation that did not pass or could not start
      // leaves its reason in the card. Any other ending is settled below.
      const inCard: ConfirmationPresenter = {
        show: view => {
          if (view.phase === 'waiting' || view.phase === 'sending') mark({ confirming: view.phase })
          else mark({ failure: { text: view.message, tone: view.phase === 'failed' ? 'error' : 'warn' } })
        },
        close: () => {},
      }
      mark({})
      try {
        await withConfirmation(
          confirmation =>
            api<unknown>(`approvals/${encodeURIComponent(approval.id)}`, {
              method: 'POST',
              body,
              ...(confirmation ? { confirmation } : {}),
            }),
          { presenter: inCard },
        )
        decisions.current.settle(approval.id)
        await refresh()
      } catch (cause) {
        decisions.current.settle(approval.id, cause)
        const optionKind = choiceKind(approval, decision, optionId)
        const settled = settledOutcome(cause, { decision, ...(optionKind ? { optionKind } : {}) })
        const unknown = settled === undefined && isUncertain(cause)
        // An unknown outcome stays on the card, which offers to send the same choice again with the same requestId; a
        // reason the card already shows (a confirmation that did not pass) stays too; anything else clears it.
        if (unknown) mark({ uncertain: { decision, optionId, ...(note && decision === 'reject' ? { note } : {}) } })
        else if (!(cause instanceof ConfirmationError && cause.handled)) mark({})
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
    },
    [refresh],
  )

  const cancelSession = useStableCallback(async (id: string) => {
    if (cancelling.has(id) && !cancelUncertain.has(id)) return
    // The run on screen: a stop that arrives after it ended must not stop the next one.
    const runId = (current?.summary.id === id ? current.summary : snapshot.tasks.find(task => task.id === id))?.runId
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
        setToast({ text: answer === 'newer' ? '要停止的那一轮已经结束，新的一轮仍在运行' : '这一轮已经结束，无需停止', tone: 'ok' })
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
    try {
      // Widening a full-access session's permission mode needs a local confirmation.
      await withConfirmation(confirmation =>
        api<unknown>(`tasks/${encodeURIComponent(id)}/config`, {
          method: 'POST',
          body: { configId, value, ...(catalog?.features?.configReceipts === true ? { requestId: request.requestId } : {}) },
          ...(confirmation ? { confirmation } : {}),
        }),
      )
      configRequests.current.settle(id, request)
      await refresh()
    } catch (cause) {
      configRequests.current.settle(id, request, cause)
      stopSession(id, cause)
      const text = inlineError(cause)
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
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  const exportTask = useStableCallback(async (task: TaskSummary) => {
    try {
      const data = task.id === current?.summary.id ? current : await api<TaskDetail>(`tasks/${encodeURIComponent(task.id)}`)
      await saveText(exportFileName(data.summary.title), transcriptMarkdown(data, { harness: sessionHarness(catalog, data.summary)?.name }))
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
            void patchTask(task, { archived: !task.archived })
          },
          export: () => {
            void exportTask(task)
          },
          remove: () => {
            setDeleting(task)
          },
        },
        manageable,
      ),
    [patchTask, exportTask, copyTask, manageable, setRenaming, setDeleting],
  )

  const block = selectedId === null ? startBlock(snapshot, choice, access) : null
  const chosenHarness = selectedId === null ? findHarness(catalog, choice.harnessId) : undefined
  const chosenScopeCaption =
    choice.mode === 'chat'
      ? undefined
      : projectScopeCaption(
          catalog?.workspaces.find(project => project.id === choice.workspaceId),
          chosenHarness,
        )
  const startsL3 = !access.legacy && chosenHarness !== undefined && harnessLevel(chosenHarness) === 'L3'
  const stopCode: SessionStopCode | undefined =
    selectedId === null ? undefined : summary?.permissionDrift || current?.permission?.drift ? 'permission-drift' : stopped.get(selectedId)
  const gate =
    selectedId === null
      ? access.legacy || access.scopes.has('run')
        ? { kind: 'open' as const }
        : { kind: 'read-only' as const, text: '此设备没有「发起和继续会话」权限' }
      : summary?.personal?.groupId
        ? { kind: 'read-only' as const, text: '这是群聊中的执行记录，请回到个人助手群聊继续。' }
        : composerGate({
            summary,
            permission: current?.permission,
            access,
            stopped: stopCode !== undefined,
          })
  const sessionBlock =
    selectedId === null
      ? undefined
      : workspaceChanged.has(selectedId)
        ? '选择一个项目继续，当前草稿会保留。'
        : harnessInfo?.status === 'unavailable'
          ? harnessInfo.statusMessage || `${harnessInfo.name} 暂不可用`
          : !catalog && snapshot.execution?.ready === false
            ? '当前模型接口不可用，请检查模型插件状态。'
            : undefined
  // 「告诉 Agent 改做什么」 after 拒绝: a Latch 内置 rejection waits for the note in the composer; an agent's goes at once.
  const rejection = useRejectionNote({
    selectedId,
    open: snapshot.approvals,
    active,
    mayType: selectedId !== null && gate.kind === 'open' && sessionBlock === undefined && submission.pending === null,
    hostTakesNote: host?.rejectionNote === true,
    decide: (approval, optionId, note) => {
      void decide(approval, 'reject', optionId, note)
    },
    focusComposer: () => {
      composerRef.current?.focus({ preventScroll: true })
    },
    keepText: text => {
      if (!submission.draft.trim()) submission.setDraft(text)
    },
  })
  const onDecide = useStableCallback(
    (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined, again?: { note?: string }) => {
      if (decision === 'reject' && again === undefined) rejection.reject(approval, optionId)
      else void decide(approval, decision, optionId, again?.note)
    },
  )
  const statuses = useMemo(
    () =>
      rejection.noting === undefined
        ? approvalStatuses
        : new Map(approvalStatuses).set(rejection.noting, { ...approvalStatuses.get(rejection.noting), noting: true as const }),
    [approvalStatuses, rejection.noting],
  )
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
          fullAccess: (current?.permission?.level ?? summary?.level) === 'L3',
          onResend: (prompt: string) => {
            void submission.resend(prompt)
          },
        }
      : undefined
  const placeholder =
    submission.pending !== null
      ? '等待确认上一条提交…'
      : selectedId === null
        ? mode === 'chat'
          ? '写下问题或想法…'
          : '描述任务，以及你希望得到的结果…'
        : active
          ? catalog?.features?.queue
            ? '可以先写，本轮完成后自动发送…'
            : '可以先写，本轮结束后发送…'
          : mode === 'chat'
            ? '继续对话 · 不读写文件、不运行命令'
            : `回复 ${harnessInfo ? harnessLabel(harnessInfo) : harnessName}…`
  // Starting a full-access session takes the local confirmation: the send slot says so, and is blocked while this
  // computer cannot confirm.
  const presenceDown = startsL3 && host?.presence.status === 'unavailable'
  const startReason = presenceDown ? `在 Mac 上确认不可用${host?.presence.message ? `：${host.presence.message}` : ''}` : undefined

  return {
    privateVisible,
    sessionDrafts,
    draftSessionId,
    draftDevice,
    privateDraftId,
    personalDraft,
    setPersonalDraft,
    personalGroupId,
    setPersonalGroupId,
    current,
    summary,
    composerRef,
    renaming,
    setRenaming,
    deleting,
    setDeleting,
    toast,
    setToast,
    actionError,
    setActionError,
    approvalBusy,
    setApprovalBusy,
    approvalStatuses,
    setApprovalStatuses,
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
    gateFor,
    approvals,
    active,
    harnessInfo,
    personalName,
    harnessName,
    reading,
    approvalVisibility,
    approvalsInView,
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
    revealApprovals,
    openApprovals,
    previousApprovals,
    approvalToast,
    setApprovalToast,
    approvalCursor,
    approvalFocus,
    setApprovalFocus,
    nextApproval,
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
    block,
    chosenHarness,
    chosenScopeCaption,
    startsL3,
    stopCode,
    gate,
    sessionBlock,
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
    presenceDown,
    startReason,
  }
}
