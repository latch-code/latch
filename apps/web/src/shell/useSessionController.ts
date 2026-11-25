import { shortcutMatches } from '../workbenchShortcuts.ts'
import type { PromptInput } from '../composer/PromptEditor.tsx'
import { isPersonalChat, personalChatModel, topicOwner } from '../agents/chat.ts'
import { sessionAgent } from '../agents/model.ts'
import { parseModelChoice, readsProjectFiles, type AppSnapshot } from '@latch/protocol'
import type { useHarness } from '../core/useHarness.ts'
import { hasFileMention } from '../fileMentions.ts'
import type { AttachmentRef, FileMention } from '@latch/protocol'
import { useAttachments } from '../hooks/useAttachments.ts'
import { projectScopeCaption } from '../projects.tsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { writeClipboard } from '@latch/ui'
import type { Approval, SessionConfigOption, TaskDetail, TaskSummary } from '@latch/protocol'
import { api, ApiError, errorMessage, fromInput, inlineError, isUncertain, readPending } from '../core/api.ts'
import { choiceKind, DecisionRequests, retryApprovalOption, settledOutcome, type UncertainChoice } from '../core/approvalDecision.ts'
import { cancelAnswer, CancelRequests } from '../core/cancelRequest.ts'
import { checkReasonText, ConfigRequests, configUncertain, type ConfigRequest } from '../core/configRequest.ts'
import { browserDraftStorage, forgetStoredDrafts, listedSessions, SessionDrafts, PLUGIN_CREATION_DRAFT } from '../core/sessionDrafts.ts'
import { forgetPrivateAgentCreation } from '../core/agentCreation.ts'
import { joinDraft, takeHandedDraft } from '../core/draftHandoff.ts'
import type { SessionConfigFeedback } from '../composer/modelReasoning.ts'
import { findHarness, findProvider, harnessName as harnessLabel, sessionHarness, sessionModel, startBlock } from '../composerChoice.ts'
import { openSession } from '../core/blocking.ts'
import { provideSessionLinks } from '../core/sessionLinks.ts'
import { exportFileName, saveText, transcriptMarkdown } from '../exportMarkdown.ts'
import { isActive } from '../format.ts'
import { approvalActions, composerGate, deviceAccess, hostView } from '../core/permissions.ts'
import { detailOwnsSummary } from '../core/projection.ts'
import { setPreference } from '../preferences.ts'
import { requestLeave } from '../preview/editDrafts.ts'
import {
  NOTICE_COPY,
  describeFailure,
  isSessionStopCode,
  SESSION_STOP_LABEL,
  stopLocksInput,
  type SessionStopCode,
} from '../core/securityCopy.ts'
import { retryOfRefused, type RefusedInput } from '../core/refusedInput.ts'
import { sessionMenuSections, type BoardMarkActions, type SessionPatch } from '../sessionMenu.ts'
import { askJoinItem, leaveItem } from '../board/ItemPageJoin.tsx'
import { codeSession, itemOfSession } from '../board/items.ts'
import {
  emptySeen,
  isUnread,
  markSeen,
  markUnread,
  pruneSeen,
  readSeen,
  inAttention,
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
import { failureAction } from '../conversation/failureAction.ts'
import { defineCopy, useLocale } from '../core/i18n.ts'

/** Refusals of an Agent's home: shown as the chat's own short state, never as a project to pick. */
const AGENT_HOME_CODES = new Set(['workspace-changed', 'helper-home-unavailable', 'helper-home-overlap', 'helper-home-moved'])

const COPY = defineCopy(
  {
    creatorUnavailable: '请选择支持创造模式的 Agent。',
    creatorSending: '正在发送消息，请稍后再创建插件。',
    creatorPending: '请先回到输入框，处理结果待确认的消息。',
    creatorFork: '请先发送或退出当前的分叉草稿。',
    creatorFiles: '请先发送新会话草稿，或移除其中的附件和文件引用。',
    released: '已在 设置 › 设备 里释放，请移除后重新添加',
    attachmentsAfterTurn: '请在本轮结束后发送这些附件。',
    fileRefsAfterTurn: '请在本轮结束后发送项目文件引用。',
    delivered: '已送达',
    duplicate: '队列里同样文字的一条还在，在队列里发送或移除',
    reattach: '附件和文件引用需要重新添加',
    deleted: '会话已被删除',
    hidden: '会话已不可见',
    changed: '输入已更改，请重新选择操作。',
    draftLimit: '草稿超出临时缓存上限，请先复制或缩短内容后再切换。',
    newerTurn: '那一轮已经结束，新的一轮仍在运行',
    alreadyEnded: '这一轮已经结束，无需停止',
    thinking: '思考',
    model: '模型',
    defaultModel: '默认模型',
    configUnknown: '没有收到 Agent 的确认。核对会向它读取当前设置，不会再发送一次。',
    settingUnchanged: '设置未更改，请重新选择。',
    settingNotApplied: (value: string) => `没有切换到「${value}」，可以重新选择。`,
    copied: '已复制 Markdown',
    saveFolderFailed: '没有保存这个会话的文件夹，请在项目设置中重试。',
    savedAsProject: '已存为项目',
    dialogBusy: '另一个系统对话框还没结束。',
    saveFolderSync: '没有保存这个会话的文件夹，请同步后重试。',
    rebuiltReadOnly: '已按文字重建为新会话 · 这个会话只能查看',
    runDenied: '此设备没有「发起和继续会话」权限',
    previousChat: '聊天记录 · 请在这个 Agent 的当前聊天发送',
    removedWorktree: '工作树已移除 · 只能查看',
    chooseProject: '选择一个项目继续，当前草稿会保留。',
    harnessUnavailable: (name: string) => `${name} 暂不可用`,
    modelUnavailable: '当前模型接口不可用，请检查模型插件状态。',
    sessionChanged: '会话状态已变化，请查看最新状态后重试。',
    ask: '写下问题或想法…',
    prompt: '输入消息…',
    pending: '等待确认上一条提交…',
    noInput: '这个会话不再接收输入',
    answer: '输入你自己的回答',
    steerOrQueue: '补充或排队一条消息',
    writeNow: '可以先写，本轮结束后发送…',
    messageTopic: (name: string) => `给${name}发消息…`,
  },
  {
    released: 'Released in Settings › Devices. Remove it and add it again.',
    creatorUnavailable: 'Choose an agent that supports creation mode. Chat-only mode cannot write plugins.',
    creatorSending: 'A message is being sent. Try creating a plugin once it finishes.',
    creatorPending: 'Return to the composer to resolve the pending message.',
    creatorFork: 'Send or exit the current fork draft first.',
    creatorFiles: 'Send your new chat draft or remove its attachments and file references first.',
    attachmentsAfterTurn: 'Send these attachments after the turn ends.',
    fileRefsAfterTurn: 'Send project file references after the turn ends.',
    delivered: 'Delivered',
    duplicate: 'The same message is still queued. Send or remove it there.',
    reattach: 'Add attachments and file references again',
    deleted: 'Session deleted',
    hidden: 'Session no longer visible',
    changed: 'The input changed. Choose the action again.',
    draftLimit: 'The draft is too large to keep temporarily. Copy or shorten it before switching.',
    newerTurn: 'That turn ended. A new turn is running.',
    alreadyEnded: 'This turn has already ended',
    thinking: 'Reasoning',
    model: 'Model',
    defaultModel: 'Default model',
    configUnknown: 'The Agent didn’t confirm the change. Checking reads its current setting without sending the change again.',
    settingUnchanged: 'Setting unchanged. Choose again.',
    settingNotApplied: (value: string) => `Didn’t switch to “${value}”. You can choose again.`,
    copied: 'Markdown copied',
    saveFolderFailed: 'Couldn’t save this session’s folder. Try again in project settings.',
    savedAsProject: 'Saved as a project',
    dialogBusy: 'Another system dialog is still open.',
    saveFolderSync: 'Couldn’t save this session’s folder. Sync and try again.',
    rebuiltReadOnly: 'Reconstructed from text in a new session · Read-only',
    runDenied: 'This device can’t start or continue sessions',
    previousChat: 'Chat history · Send messages in this Agent’s current chat',
    removedWorktree: 'Worktree removed · Read-only',
    chooseProject: 'Choose a project to continue. Your draft will be kept.',
    harnessUnavailable: (name: string) => `${name} is unavailable`,
    modelUnavailable: 'The model interface is unavailable. Check the model plugin’s status.',
    sessionChanged: 'The session changed. Check its latest state and try again.',
    ask: 'Write a question or thought…',
    prompt: 'Write a message…',
    pending: 'Waiting for the previous submission…',
    noInput: 'This session no longer accepts input',
    answer: 'Type your own answer',
    steerOrQueue: 'Add or queue a message',
    writeNow: 'Draft now and send when this turn ends…',
    messageTopic: (name: string) => `Message ${name}…`,
  },
)

/** Session IDs are never empty. */
const NEW_SESSION_DRAFT = ''
/** Text only a device that may read every kind of data sees: an agent's session, or one an assistant ran. */
const privateSession = (task: TaskSummary | undefined): boolean =>
  task !== undefined && (task.personal !== undefined || task.agent !== undefined || task.agentPrivate === true)

type Harness = ReturnType<typeof useHarness>
type ToastMessage = { text: string; tone: 'ok' | 'error' }
/** Results of session actions belong to the session they were made in, not whichever is open when they settle. */
type ActionError = { sessionId: string; text: string }
type TrackedApprovalStatus = ApprovalStatus & { sessionId: string }

/** An explicit input action consumes only the draft it was offered for, after every leave guard passes. */
export interface SessionSelectionIntent {
  consumeDraft?: { inputId: string | null; text: string }
  draft?: string
  appendDraft?: string
}

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
  inputTarget = 'session',
  board,
  atStart,
  onBeforeSelect,
  onForegroundSent,
}: {
  harness: Harness
  snapshot: AppSnapshot
  /** The home edits a new draft while the selected conversation stays mounted and subscribed. */
  inputTarget?: 'session' | 'new'
  board: boolean
  atStart: () => boolean
  /** Runs as the selection changes, for what the shell keeps per open session. */
  onBeforeSelect: (id: string | null) => void
  /** A message went out from this page and its session is now the open one. */
  onForegroundSent: () => void
}) {
  const locale = useLocale()
  const { selectedId, detail, cachedDetail, select, refresh } = harness
  const inputId = inputTarget === 'new' ? null : selectedId
  const catalog = snapshot.catalog
  const shell = currentShell()
  const host = hostView(snapshot)
  const scopesKey = host
    ? `${snapshot.device.listener}:${snapshot.device.scopes.join(',')}:${snapshot.device.dataScope}:${snapshot.device.status}`
    : 'legacy'
  // Ignore last-seen churn, but invalidate every access boundary used by private editors.
  const access = useMemo(() => deviceAccess(snapshot, shell), [scopesKey, shell])
  const privateVisible = snapshot.device.dataScope === 'all' && snapshot.device.scopes.includes('view')
  const creatorAllowed = privateVisible && access.local && access.admin && access.scopes.has('run')
  const creatorAvailable = creatorAllowed && catalog?.features?.pluginCreation === true
  const pendingCreator = () => {
    const pending = readPending(`latch.pending.${location.origin}.${snapshot.device.id}`)
    return pending?.pluginCreation ? pending : null
  }
  const [initialDrafts] = useState(() => {
    // Only this device's drafts stay on this origin: another device's could otherwise open here.
    forgetStoredDrafts(location.origin, snapshot.device.id)
    return new SessionDrafts(browserDraftStorage(location.origin, snapshot.device.id))
  })
  const sessionDrafts = useRef(initialDrafts)
  const [creatorSelected, setCreator] = useState(() => creatorAllowed && pendingCreator() !== null)
  const draftDevice = useRef(snapshot.device.id)
  const creator = creatorAllowed && creatorSelected && draftDevice.current === snapshot.device.id && !board
  const newDraftKey = creator ? PLUGIN_CREATION_DRAFT : NEW_SESSION_DRAFT
  const inputKey = inputId ?? newDraftKey
  const draftSessionId = useRef(inputKey)
  const restoringDraft = useRef<string | undefined>(undefined)
  const privateDraftId = useRef<string | null>(null)
  const current = detail?.summary.id === selectedId && (!privateSession(detail.summary) || privateVisible) ? detail : null
  const listed = snapshot.tasks.find(task => task.id === selectedId && (!privateSession(task) || privateVisible))
  const preferDetail = current !== null && !cachedDetail && (current.sync === undefined || detailOwnsSummary(snapshot, current))
  const summary = preferDetail ? current.summary : (listed ?? current?.summary)
  if (summary && privateSession(summary) && selectedId) privateDraftId.current = selectedId
  else if (privateDraftId.current !== selectedId) privateDraftId.current = null
  const composerRef = useRef<PromptInput>(null)
  const [renaming, setRenaming] = useState<TaskSummary | null>(null)
  const [tagging, setTagging] = useState<TaskSummary | null>(null)
  const [deleting, setDeleting] = useState<TaskSummary | null>(null)
  const [removingWorktree, setRemovingWorktree] = useState<TaskSummary | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [approvalBusy, setApprovalBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const [approvalStatuses, setApprovalStatuses] = useState<ReadonlyMap<string, TrackedApprovalStatus>>(new Map())
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
  /** An Agent's chat whose home the Host refused: the code, until a retry or a message gets through. */
  const [homeRefused, setHomeRefused] = useState<ReadonlyMap<string, string>>(new Map())
  const decisions = useRef(new DecisionRequests())
  const cancels = useRef(new CancelRequests())

  const owner = access.admin
  const canQueue = catalog?.features?.queue === true
  const queueAttachments = canQueue && catalog?.features?.queueAttachments === true
  const gateFor = useCallback((approval: Approval) => approvalActions(approval, access.device), [access])
  const canRetryApproval = useStableCallback(
    (choice: UncertainChoice) =>
      harness.connection === 'connected' && (access.legacy || (access.scopes.has('view') && (!choice.note || access.scopes.has('run')))),
  )
  /** An unknown approval choice is settled only by the Host: reading the session again shows whether it took. */
  const checkApproval = useStableCallback(() => refresh())
  const approvals = useMemo(
    () => (preferDetail ? current.approvals : snapshot.approvals.filter(approval => approval.sessionId === selectedId)),
    [current, preferDetail, snapshot.approvals, selectedId],
  )
  const active = isActive(summary?.status)
  /** The running turn takes what is sent now; read from the open session, since it is agreed per run. */
  const steer = active && current?.steer === true && !cancelling.has(current.summary.id)
  const harnessInfo = sessionHarness(catalog, summary)
  const harnessName = harnessInfo ? harnessLabel(harnessInfo) : (summary?.harnessId ?? snapshot.harness?.name ?? 'Latch')

  /**
   * Whether a refused session is an Agent's chat, from what the refusal and this page know of it, not only the session
   * list: a code about an Agent's home says so itself; a chat may be missing from the list just after it was started
   * (a moved chat's new one), yet be the Host's chat for its Agent or the detail open now.
   */
  const agentSession = (sessionId: string, code: string) =>
    code.startsWith('helper-home-')
    || topicOwner(snapshot.tasks.find(task => task.id === sessionId)) !== undefined
    || Object.values(snapshot.agentChats ?? {}).some(chat => chat.state === 'ready' && chat.sessionId === sessionId)
    || (detail?.summary.id === sessionId && topicOwner(detail.summary) !== undefined)
  const stopSession = (sessionId: string, cause: unknown, what: RefusedInput) => {
    // An Agent's chat has no folder for a person to pick: the Host sets its home up. What it refuses is said as such.
    if (cause instanceof ApiError && AGENT_HOME_CODES.has(cause.code) && agentSession(sessionId, cause.code)) {
      const code = cause.code
      setHomeRefused(previous => new Map(previous).set(sessionId, code))
      setRefused(previous => new Map(previous).set(sessionId, what))
      return true
    }
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
  const clearHomeRefused = (sessionId: string) =>
    setHomeRefused(previous => {
      if (!previous.has(sessionId)) return previous
      const next = new Map(previous)
      next.delete(sessionId)
      return next
    })
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
  const creating = inputId === null && creator
  const submission = useSubmission({
    creating,
    creatorAllowed: creatorAvailable,
    snapshot,
    access,
    selectedId: inputId,
    atStart,
    select,
    refresh,
    onSent: (sessionId, sent, { foreground, consumedDraft, memoryRefused }) => {
      if (sent.sessionId !== undefined) clearHomeRefused(sent.sessionId)
      if (consumedDraft) sessionDrafts.current.remove(sent.sessionId ?? (sent.pluginCreation ? PLUGIN_CREATION_DRAFT : NEW_SESSION_DRAFT))
      if (sent.pluginCreation) setCreator(false)
      // The message went; only its 「记住…」 was not kept, and the Host says why.
      if (memoryRefused) setToast({ text: memoryRefused, tone: 'error' })
      if (!foreground || sent.queue) return
      draftSessionId.current = sessionId
      onForegroundSent()
      reading.show(sessionId)
    },
    onRefused: (sessionId, cause, resent) =>
      stopSession(sessionId, cause, { from: 'send', ...(resent ? { prompt: resent.prompt, teamRequest: resent.teamRequest } : {}) }),
    // Not delivered, for certain: the text goes back where it was written, and the released rows say so.
    onReleased: (sent, restored) => {
      released.current?.(COPY.released)
      if (restored || !sent.prompt) return
      const home = sent.sessionId ?? (sent.pluginCreation ? PLUGIN_CREATION_DRAFT : NEW_SESSION_DRAFT)
      if (!sessionDrafts.current.read(home, privateVisible))
        sessionDrafts.current.save(
          home,
          sent.prompt,
          sent.sessionId !== undefined && privateSession(snapshot.tasks.find(task => task.id === sent.sessionId)),
        )
    },
  })
  const startingFromHome = inputTarget === 'new' && catalog?.features?.messageIdentity && submission.startingMessage !== null
  const reading = useReadingPosition({
    sessionId: selectedId,
    // The pending start temporarily owns the transcript space. Reconnect the reading observer when the session returns.
    ready: current !== null && !startingFromHome,
    contentVersion: `${current?.cursor ?? 0}:${current?.liveText.length ?? 0}:${current?.liveReasoning?.length ?? 0}:${approvals.length}`,
  })
  // Fade the content, not the masked scroller: animating the latter can leave Chromium's hit-test region empty.
  useSwitchFade(reading.contentRef, current?.summary.id ?? null, cachedDetail)
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
    const text = sessionDrafts.current.read(inputKey, privateVisible)
    if (text) submission.setDraft(previous => (previous.trim() ? previous : text))
  }, [])
  // The open composer's text is kept for the next load, as it changes; a private session's only where it may be seen.
  useEffect(() => {
    if (draftSessionId.current !== inputKey) return
    if (restoringDraft.current !== undefined && submission.draft !== restoringDraft.current) return
    restoringDraft.current = undefined
    const hidden = inputId !== null && (summary === undefined || privateSession(summary) || privateDraftId.current === inputId)
    if (hidden && !privateVisible) return
    sessionDrafts.current.keep(inputKey, submission.draft, hidden || inputKey === PLUGIN_CREATION_DRAFT)
  }, [submission.draft, inputKey])
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
  // Changing the input target never changes the reading selection. Each target restores only its own draft.
  useLayoutEffect(() => {
    if (draftSessionId.current === inputKey) return
    const previous = draftSessionId.current
    const task = snapshot.tasks.find(item => item.id === previous)
    if (
      previous === NEW_SESSION_DRAFT
      || (previous === PLUGIN_CREATION_DRAFT && creatorAllowed && draftDevice.current === snapshot.device.id)
      || task
    )
      sessionDrafts.current.save(previous, submission.draft, previous === PLUGIN_CREATION_DRAFT || privateSession(task))
    else sessionDrafts.current.remove(previous)
    draftSessionId.current = inputKey
    const restored =
      (inputKey === PLUGIN_CREATION_DRAFT ? pendingCreator()?.prompt : undefined) ?? sessionDrafts.current.read(inputKey, privateVisible)
    restoringDraft.current = restored
    submission.setDraft(restored)
    submission.setError('')
  }, [inputKey])
  useLayoutEffect(() => {
    if (!privateVisible || !access.scopes.has('run')) forgetPrivateAgentCreation(location.origin, snapshot.device.id)
    if (!creatorAllowed) {
      setCreator(false)
      sessionDrafts.current.remove(PLUGIN_CREATION_DRAFT)
      sessionDrafts.current.flush()
    }
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
      if (privateDraftId.current !== null && privateDraftId.current === inputId) submission.setDraft('')
    }
  }, [snapshot.device.id, privateVisible, creatorAllowed, access.scopes.has('view'), access.scopes.has('run')])
  useLayoutEffect(() => {
    if (creatorAllowed) setCreator(pendingCreator() !== null)
  }, [creatorAllowed, snapshot.device.id])
  const choice = submission.choice
  const [sessionMentions, setSessionMentions] = useState<FileMention[]>([])
  const [newMentions, setNewMentions] = useState<FileMention[]>([])
  const fileMentions = inputId === null ? newMentions : sessionMentions
  const setFileMentions = inputId === null ? setNewMentions : setSessionMentions
  const released = useRef<((text: string) => void) | null>(null)
  const attachHarness = selectedId === null ? findHarness(catalog, choice.harnessId ?? catalog?.defaults.harnessId) : harnessInfo
  const effectiveModel = submission.override ?? personalChatModel(snapshot, summary) ?? sessionModel(summary)
  const attachmentModel = selectedId === null ? choice.model : effectiveModel
  const connectionReported = harness.connection === 'offline' || harness.connection === 'reconnecting'
  const canSteerDraft = (draft: string, hasAttachments: boolean) =>
    steer && !submission.override && !draft.includes('[conversation-ref:') && (!hasAttachments || current?.steerAttachments === true)
  const attachmentFollowUp = queueAttachments || canSteerDraft(submission.draft, true)
  const heldFileRefs = fileMentions.some(ref => hasFileMention(submission.draft, ref))
  const sessionAttachments = useAttachments({
    connectionReported,
    // A Harness that just started, or was just tested, may take files now: read again without a reload.
    revision: JSON.stringify([attachHarness?.status, attachHarness?.attachmentsReported ?? null]),
    enabled: catalog?.features?.attachments === true && access.scopes.has('run'),
    selection: {
      // Attachments are off until the catalog arrives, and then one of these is there.
      harnessId: (selectedId === null ? choice.harnessId : summary?.harnessId) ?? catalog?.defaults.harnessId ?? '',
      ...(selectedId === null ? { workspaceId: choice.workspaceId ?? catalog?.defaults.workspaceId } : {}),
      ...(attachmentModel ? { model: attachmentModel } : {}),
    },
    ...(selectedId ? { sessionId: selectedId } : {}),
    locked: submission.sending || submission.pending !== null,
    ...(active && (!attachmentFollowUp || heldFileRefs)
      ? {
          heldBack: heldFileRefs ? COPY.fileRefsAfterTurn : COPY.attachmentsAfterTurn,
          heldRefs: heldFileRefs,
        }
      : {}),
  })
  const draftHarness = findHarness(catalog, choice.harnessId ?? catalog?.defaults.harnessId)
  const newAttachments = useAttachments({
    connectionReported,
    revision: JSON.stringify([draftHarness?.status, draftHarness?.attachmentsReported ?? null]),
    enabled: !creating && catalog?.features?.attachments === true && access.scopes.has('run'),
    selection: {
      harnessId: choice.harnessId ?? catalog?.defaults.harnessId ?? '',
      workspaceId: choice.workspaceId ?? catalog?.defaults.workspaceId,
      ...(choice.model ? { model: choice.model } : {}),
    },
    locked: submission.sending || submission.pending !== null,
  })
  const attachmentDraft = inputId === null ? newAttachments : sessionAttachments
  const newDraftText =
    inputId === null || !newMentions.length ? submission.draft : sessionDrafts.current.read(NEW_SESSION_DRAFT, privateVisible)
  const creatorInputsHeld = !creator && (newAttachments.items.length > 0 || newMentions.some(ref => hasFileMention(newDraftText, ref)))
  const creatorBlockedReason = submission.sending
    ? COPY.creatorSending
    : submission.pending
      ? COPY.creatorPending
      : submission.fork
        ? COPY.creatorFork
        : creatorInputsHeld
          ? COPY.creatorFiles
          : undefined
  const creatorBlocked = !creatorAvailable || !draftHarness?.modes.includes('agent') || draftHarness.pluginCreation !== true
  const chooseCreator = (next: boolean, seed?: string): boolean => {
    if (submission.sending || submission.pending || (next && (!creatorAvailable || creatorBlockedReason))) return false
    if (inputId === null && !sessionDrafts.current.save(inputKey, submission.draft, creator)) {
      setToast({ text: COPY.draftLimit, tone: 'error' })
      return false
    }
    if (next && !sessionDrafts.current.read(PLUGIN_CREATION_DRAFT, true)) {
      const initial = seed ?? (inputId === null ? submission.draft : '')
      sessionDrafts.current.save(PLUGIN_CREATION_DRAFT, initial, true)
      if (creating && !submission.draft) submission.setDraft(initial)
    }
    setCreator(next)
    return true
  }
  released.current = attachmentDraft.markReleased
  const sessionQuotes = useRef(new Map<string, { etag: string; marker: string }>())
  const newQuotes = useRef(new Map<string, { etag: string; marker: string }>())
  const quoteSnapshots = inputId === null ? newQuotes : sessionQuotes
  const mentionScope = `${choice.workspaceId ?? ''}:${choice.harnessId ?? ''}:${choice.mode}:${snapshot.device.dataScope}`
  /**
   * 从这里编辑: the file references and attachments of the message being edited, for the new session's composer. They are
   * set once the draft's choice has moved to the source's project and Harness, which would otherwise clear them.
   */
  const editSeed = useRef<{ refs: FileMention[]; attachments: AttachmentRef[] } | null>(null)
  const [editTurn, setEditTurn] = useState(0)
  useLayoutEffect(() => {
    if (submission.pending === null) setNewMentions(editSeed.current?.refs ?? [])
  }, [mentionScope])
  useEffect(() => {
    const seed = editSeed.current
    editSeed.current = null
    if (seed?.attachments.length) newAttachments.reuse(seed.attachments)
  }, [editTurn])
  const seedEdit = (seed: { refs: FileMention[]; attachments: AttachmentRef[] }) => {
    newAttachments.clear()
    editSeed.current = seed
    setNewMentions(seed.refs)
    setEditTurn(turn => turn + 1)
  }
  useLayoutEffect(() => {
    if (submission.pending === null) setSessionMentions([])
  }, [selectedId, snapshot.device.dataScope])
  const setSubmissionDraft = (text: string) => {
    restoringDraft.current = undefined
    // A reference whose marker left the text is kept until the draft is sent or let go: undo can bring the marker, and
    // so its chip, back. Only those still in the text count (`mentionChoice.refs`).
    submission.setDraft(text)
  }
  const mentionHarness = inputId === null ? findHarness(catalog, choice.harnessId) : harnessInfo
  const mentionable =
    !creating
    && catalog?.features?.fileMentions === true
    && (inputId === null ? choice.mode === 'agent' : summary?.mode !== 'chat')
    && mentionHarness?.capabilities.tools.fileMentions === true
  // A restricted device gets the reason when it asks for files with @.
  const mentionsHidden = mentionable && !readsProjectFiles(snapshot.device.dataScope)
  const mentionChoice = {
    enabled: mentionable && !mentionsHidden,
    ...(mentionsHidden ? { hidden: true as const } : {}),
    ...(inputId ? { sessionId: inputId } : {}),
    ...(choice.workspaceId && choice.workspaceId !== 'default' ? { workspaceId: choice.workspaceId } : {}),
    harnessId: mentionHarness?.id ?? '',
    refs: fileMentions.filter(ref => hasFileMention(submission.draft, ref)),
    onRefs: setFileMentions,
  }
  /** A folder refused by the Host is explained in the project list. */
  const [projectRequest, setProjectRequest] = useState(0)
  const [projectNotice, setProjectNotice] = useState<string>()
  const askProject = (notice?: string) => {
    setProjectNotice(notice)
    setProjectRequest(request => request + 1)
  }
  // A setting picked a moment before sending goes first, or the session would refuse it and run the turn on the old one.
  const settingsLanded = async () => {
    if (inputId !== null) await configFlights.current.get(inputId)
  }
  const sendDraft = async (queueForLater = false) => {
    if (creating && creatorBlocked) {
      submission.setError(COPY.creatorUnavailable)
      return
    }
    if (inputId !== null && active && ((!attachmentFollowUp && attachmentDraft.items.length > 0) || heldFileRefs)) {
      submission.setError(heldFileRefs ? COPY.fileRefsAfterTurn : COPY.attachmentsAfterTurn)
      return
    }
    await settingsLanded()
    const ids = await attachmentDraft.wait()
    if (ids && inputId !== null) clearUnverified(inputId)
    const followUp =
      inputId === null || !active
        ? undefined
        : !queueForLater && canSteerDraft(submission.draft, !!ids?.length)
          ? 'steer'
          : canQueue
            ? 'queue'
            : undefined
    if (ids && (await submission.submit(undefined, undefined, followUp, ids, creating ? [] : mentionChoice.refs, creating))) {
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
        if ((await submission.submit(held)) && fromInput(held)) {
          if (held.sessionId === undefined) {
            newAttachments.clear()
            setNewMentions([])
          } else if (held.sessionId === selectedId) {
            sessionAttachments.clear()
            setSessionMentions([])
          }
        }
        return
      }
      if (!givingUp) return
    }
    if (!submission.delivered(held)) return
    // A prompt sent again never was the input: what is being written stays, here and as the session's draft.
    if (fromInput(held)) {
      if (held.sessionId === undefined) {
        newAttachments.clear()
        setNewMentions([])
      } else if (held.sessionId === selectedId) {
        sessionAttachments.clear()
        setSessionMentions([])
      } else if (held.sessionId !== undefined && sessionDrafts.current.read(held.sessionId, privateVisible).trim() === held.prompt.trim())
        // The text waiting as that session's draft is what was just delivered, as a sent message takes it away.
        sessionDrafts.current.remove(held.sessionId)
    }
    setToast({
      get text() {
        return COPY.delivered
      },
      tone: 'ok',
    })
  })
  const held = submission.pending
  useEffect(() => {
    if (held && !submission.sending && deliveredSubmission(held, current)) void settleListed(held, false)
  }, [held, submission.sending, current, settleListed])
  // Back online after an unconfirmed send: the same request (same requestId) goes once by itself, so the Host's answer
  // settles it, or the card stays with the reason. Another window already retrying it is left to do so.
  const lastConnection = useRef(harness.connection)
  const retryHeld = useStableCallback(async () => {
    const pending = submission.pending
    if (!pending || submission.sending || submission.sendingElsewhere || abandoning) return
    // Evidence first: the session read afresh lists it, so it was delivered. Only otherwise the same request goes again,
    // which the Host answers from its receipt if it took the first.
    if (pending.sessionId !== undefined) {
      const fresh = await api<TaskDetail>(`tasks/${encodeURIComponent(pending.sessionId)}`, { timeoutMs: 5_000 }).catch(() => null)
      if (submission.pending?.requestId !== pending.requestId) return
      if (deliveredSubmission(pending, fresh)) {
        await settleListed(pending, false)
        return
      }
    }
    await retryDraft()
  })
  useEffect(() => {
    const before = lastConnection.current
    lastConnection.current = harness.connection
    // Only a return from a lost connection: a page's first connection, or a stream opened for another session, is not one.
    if (harness.connection === 'connected' && (before === 'offline' || before === 'reconnecting')) void retryHeld()
  }, [harness.connection, retryHeld])
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
      if (twin)
        setToast({
          get text() {
            return COPY.duplicate
          },
          tone: 'ok',
        })
      else if (attached || pending.fileRefs?.length)
        setToast({
          get text() {
            return COPY.reattach
          },
          tone: 'ok',
        })
      if (dropped.restored || !dropped.text) return
      const home = dropped.sessionId ?? (pending.pluginCreation ? PLUGIN_CREATION_DRAFT : NEW_SESSION_DRAFT)
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
    if (harness.removed) setToast({ text: harness.removed.deleted ? COPY.deleted : COPY.hidden, tone: 'ok' })
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
    // Absence only settles what the current projection is allowed to observe.
    setApprovalStatuses(previous => {
      const open = new Set(snapshot.approvals.map(approval => approval.id))
      const visible = new Set(snapshot.tasks.map(task => task.id))
      const canRead = snapshot.device.scopes.includes('view')
      const complete = snapshot.device.dataScope === 'all' && snapshot.tasksComplete === true
      const next = new Map(
        [...previous].filter(
          ([id, status]) => open.has(id) || (status.uncertain && !(canRead && (visible.has(status.sessionId) || complete))),
        ),
      )
      return next.size === previous.size ? previous : next
    })
  }, [snapshot])

  const [queuedRetry, setQueuedRetry] = useState<{
    id: string
    runId?: string
    updatedAt: string
    prompt: string
    teamRequest?: true
  } | null>(null)
  const consumedRetry = useRef<typeof queuedRetry>(null)
  const choose = useStableCallback((id: string | null, afterSelect?: () => void, intent?: SessionSelectionIntent): void => {
    if (intent && (submission.pending !== null || submission.sending)) return
    if (intent?.consumeDraft && (intent.consumeDraft.inputId !== inputId || intent.consumeDraft.text !== submission.draft)) {
      setToast({
        get text() {
          return COPY.changed
        },
        tone: 'error',
      })
      return
    }
    // An editor's unsaved text in this session: the guard asks first, and comes back here once it may go.
    if (id !== selectedId && selectedId !== null && requestLeave(selectedId, () => choose(id, afterSelect, intent))) return
    const targetDraftKey = id ?? (intent ? NEW_SESSION_DRAFT : newDraftKey)
    const outgoing = intent?.consumeDraft ? '' : submission.draft
    const handed = id === null ? undefined : takeHandedDraft(id)
    if (handed && id === inputId) submission.setDraft(previous => joinDraft(previous, handed))
    if (id !== inputId || id === null) {
      if (inputId !== null) {
        const hidden = summary === undefined || privateSession(summary) || privateDraftId.current === inputId
        if (!privateVisible && hidden) sessionDrafts.current.remove(inputId)
        else if (!sessionDrafts.current.save(inputId, outgoing, hidden)) {
          setToast({
            get text() {
              return COPY.draftLimit
            },
            tone: 'error',
          })
          return
        }
      } else if (id !== null && !sessionDrafts.current.save(newDraftKey, outgoing, creator)) {
        setToast({
          get text() {
            return COPY.draftLimit
          },
          tone: 'error',
        })
        return
      }
      // 新会话 pressed on 新会话 starts over; coming back from a session finds what was being written.
      if (inputId === null && id === null && inputKey === targetDraftKey) sessionDrafts.current.remove(targetDraftKey)
      else if (inputId === null && id === null) sessionDrafts.current.save(inputKey, outgoing, creator)
      const restored =
        intent?.draft
        ?? (targetDraftKey === PLUGIN_CREATION_DRAFT ? pendingCreator()?.prompt : undefined)
        ?? joinDraft(joinDraft(sessionDrafts.current.read(targetDraftKey, privateVisible), handed), intent?.appendDraft)
      restoringDraft.current = restored
      submission.setDraft(restored)
      draftSessionId.current = targetDraftKey
    } else if (intent?.consumeDraft || intent?.draft !== undefined) {
      const restored = intent.draft ?? ''
      restoringDraft.current = restored
      submission.setDraft(restored)
    } else if (intent?.appendDraft) {
      submission.setDraft(previous => joinDraft(previous, intent.appendDraft))
    }
    if (intent && id === null) setCreator(false)
    if (intent?.consumeDraft) setFileMentions([])
    setQueuedRetry(null)
    onBeforeSelect(id)
    select(id)
    afterSelect?.()
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
    // Else the newest session the Host keeps in 等你处理: a failure not yet opened, results not yet checked.
    const settled = snapshot.tasks.filter(inAttention).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    const next = quiet ?? settled
    if (next) choose(next.id)
  }

  const previousApprovals = useRef(new Set(snapshot.approvals.map(item => item.id)))
  const [approvalToast, setApprovalToast] = useState<{ sessionId: string; id: string } | null>(null)
  useEffect(() => {
    const other = snapshot.approvals.find(item => !previousApprovals.current.has(item.id) && item.sessionId !== selectedId)
    previousApprovals.current = new Set(snapshot.approvals.map(item => item.id))
    if (other) setApprovalToast({ sessionId: other.sessionId, id: other.id })
  }, [snapshot.approvals, selectedId])
  // Opened by any way, or decided anywhere: it is no longer another session waiting, and the toast must not hide what
  // this one says.
  const toastAnswered = approvalToast !== null && !snapshot.approvals.some(item => item.id === approvalToast.id)
  useEffect(() => {
    if (approvalToast && (approvalToast.sessionId === selectedId || toastAnswered)) setApprovalToast(null)
  }, [approvalToast, selectedId, toastAnswered])
  // Its six seconds run from when it appeared; moving between sessions does not start them again.
  useEffect(() => {
    if (!approvalToast) return
    const timer = setTimeout(() => setApprovalToast(null), 6000)
    return () => clearTimeout(timer)
  }, [approvalToast])
  const approvalCursor = useRef<string | null>(null)
  const [approvalFocus, setApprovalFocus] = useState<string | null>(null)
  const [approvalTarget, setApprovalTarget] = useState<{ sessionId: string; approvalId: string }>()
  const openApproval = useStableCallback((sessionId: string, approvalId: string) => {
    const target = snapshot.approvals.find(approval => approval.id === approvalId && approval.sessionId === sessionId)
    choose(sessionId, () => {
      if (!target) return
      approvalCursor.current = target.id
      setApprovalTarget({ sessionId, approvalId })
      setApprovalFocus(target.id)
      reading.show(sessionId, toolRowId(target))
    })
  })
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
      if (shortcutMatches(event, 'next-approval', currentShell() !== null) && !document.querySelector('dialog[open]')) {
        event.preventDefault()
        nextApproval()
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [nextApproval])
  // `note`: with a rejection, for a harness that hands it on, what to do instead (see `rejectionNoteFor`).
  const decide = useCallback(
    async (
      approval: Approval,
      decision: 'allow' | 'reject',
      optionId: string | undefined,
      note?: string,
      retry = false,
    ): Promise<boolean> => {
      if (approvalFlights.current.has(approval.id) || (!retry && approvalStatuses.get(approval.id)?.uncertain)) return false
      const requestId = retry
        ? decisions.current.retryId(approval.id, decision, optionId, note)
        : decisions.current.idFor(approval.id, decision, optionId, note)
      if (!requestId) return false
      // False once the choice definitely did not take effect; an unknown outcome keeps its note on the card's retry.
      let taken = true
      approvalFlights.current.add(approval.id)
      setApprovalBusy(previous => new Map(previous).set(approval.id, optionId ?? (decision === 'allow' ? 'allow_once' : 'reject_once')))
      clearAction(approval.sessionId)
      const body = { decision, requestId, ...(optionId ? { optionId } : {}), ...(note && decision === 'reject' ? { note } : {}) }
      const mark = (status: ApprovalStatus) => {
        setApprovalStatuses(previous => {
          if (Object.keys(status).length === 0 && !previous.has(approval.id)) return previous
          const next = new Map(previous)
          if (Object.keys(status).length > 0) next.set(approval.id, { ...status, sessionId: approval.sessionId })
          else next.delete(approval.id)
          return next
        })
      }
      if (!retry) mark({})
      try {
        await api<unknown>(`approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body })
        decisions.current.settle(approval.id)
        mark({})
        await refresh()
      } catch (cause) {
        // Refusing the retry after a scope change does not tell us whether the first attempt took effect.
        const retryDenied = retry && cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
        if (!retryDenied) decisions.current.settle(approval.id, cause)
        const optionKind = choiceKind(approval, decision, optionId)
        const settled = settledOutcome(cause, { decision, ...(optionKind ? { optionKind } : {}) })
        const unknown = settled === undefined && (retryDenied || isUncertain(cause))
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
    [refresh, approvalStatuses],
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
        setToast({ text: answer === 'newer' ? COPY.newerTurn : COPY.alreadyEnded, tone: 'ok' })
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

  /** The Harness's own name for a value of one of the open session's options. */
  const valueName = (configId: string, value: string) => {
    const option = current?.config?.find(item => item.id === configId)
    const word =
      option?.category === 'thought_level' ? COPY.thinking : option?.category === 'model' ? COPY.model : (option?.name ?? configId)
    // A move to another route names the model the way the menu does: a service's ID, else the Harness's own name for it.
    const choice = option?.category === 'model' ? parseModelChoice(value) : undefined
    const name =
      choice?.kind === 'service'
        ? choice.model
        : choice?.kind === 'own'
          ? (harnessInfo?.catalogue?.options.find(item => item.category === 'model')?.options.find(item => item.value === choice.value)
              ?.name
            ?? (choice.value || COPY.defaultModel))
          : (option?.options.find(item => item.value === value)?.name ?? value)
    return `${word} ${name}`
  }
  const unknownFeedback = (request: ConfigRequest, at: number): SessionConfigFeedback => ({
    kind: 'unknown',
    message: COPY.configUnknown,
    configId: request.configId,
    valueName: valueName(request.configId, request.value),
    at,
  })
  // An answer to a change that may take a Harness's process start and its own reply; the Host gives up first.
  const CONFIG_WRITE_TIMEOUT_MS = 150_000

  const setConfig = async (configId: string, value: string) => {
    if (selectedId === null) return
    const id = selectedId
    const request = configRequests.current.begin(id, configId, value)
    if (!request) return
    await sendConfig(id, request, Date.now())
  }

  const sendConfig = async (id: string, request: ConfigRequest, at: number) => {
    setConfigBusy(previous => new Map(previous).set(id, request.configId))
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
        body: {
          configId: request.configId,
          value: request.value,
          ...(catalog?.features?.configReceipts === true ? { requestId: request.requestId } : {}),
        },
        timeoutMs: CONFIG_WRITE_TIMEOUT_MS,
      })
      configRequests.current.settle(id, request)
      await refresh()
    } catch (cause) {
      configRequests.current.settle(id, request, cause)
      stopSession(id, cause, { from: 'config' })
      // Unknown is not an error: it is said once, in place, with 核对 and 重试同一请求.
      if (configUncertain(cause)) setConfigFeedback(previous => new Map(previous).set(id, unknownFeedback(request, at)))
      else {
        const text = cause instanceof ApiError && cause.code === 'permission-unverified' ? NOTICE_COPY.configUnverified : inlineError(cause)
        setConfigFeedback(previous =>
          new Map(previous).set(id, { kind: 'failed', message: text || COPY.settingUnchanged, configId: request.configId }),
        )
        if (text && !(cause instanceof ApiError && isSessionStopCode(cause.code))) failAction(id, text)
      }
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

  /** 重试同一请求: the same identity and content; the Host answers from its receipt and never sends an unknown change again. */
  const retryConfig = async () => {
    if (selectedId === null) return
    const id = selectedId,
      request = configRequests.current.get(id)
    if (!request?.unknown || configFlights.current.has(id)) return
    await sendConfig(id, request, configFeedback.get(id)?.at ?? Date.now())
  }

  const settleShown = (id: string, request: ConfigRequest, state: string | undefined, config: readonly SessionConfigOption[]) => {
    if (!configRequests.current.reconcile(id, request, config, state)) return false
    setConfigFeedback(previous => {
      const updated = new Map(previous)
      if (state === 'failed')
        updated.set(id, {
          kind: 'failed',
          message: COPY.settingNotApplied(valueName(request.configId, request.value)),
          configId: request.configId,
        })
      else updated.delete(id)
      return updated
    })
    return true
  }

  /**
   * 核对: the Host settles the change from the Agent's own reading (`…/check`); an older Host only answers its receipt,
   * and without receipts only a read-back of the asked value settles it.
   */
  const refreshConfig = async () => {
    if (selectedId === null) return
    const id = selectedId,
      request = configRequests.current.get(id)
    const mark = (checking: boolean, abandonable?: boolean) =>
      setConfigFeedback(previous => {
        const row = previous.get(id)
        return row?.kind === 'unknown'
          ? new Map(previous).set(id, { ...row, checking, ...(abandonable ? { abandonable: true } : {}) })
          : previous
      })
    let stuck = false
    mark(true)
    try {
      const path = request ? `tasks/${encodeURIComponent(id)}/config-requests/${request.requestId}` : undefined
      const receipt =
        request && path && catalog?.features?.configCheck === true
          ? await api<{ state: string; reason?: string }>(`${path}/check`, {
              method: 'POST',
              body: { configId: request.configId, value: request.value },
              timeoutMs: CONFIG_WRITE_TIMEOUT_MS,
            })
          : request && path && catalog?.features?.configReceipts === true
            ? await api<{ state: string; reason?: string }>(path)
            : undefined
      const next = await api<TaskDetail>(`tasks/${encodeURIComponent(id)}`)
      if (!request) setConfigFeedback(previous => (previous.has(id) ? new Map([...previous].filter(([key]) => key !== id)) : previous))
      else if (!settleShown(id, request, receipt?.state, next.config ?? [])) {
        // A turn that is running ends on its own; anything else may never settle, so the person may set it down.
        stuck = receipt?.reason !== 'running'
        // Still unknown is not a failure: no red.
        setToast({ text: checkReasonText(receipt?.reason, harnessInfo?.capabilities.display.label ?? 'Harness'), tone: 'ok' })
      }
      await refresh()
    } catch (cause) {
      stuck = true
      setToast({ text: errorMessage(cause), tone: 'error' })
    } finally {
      mark(false, stuck)
    }
  }

  /**
   * 放弃这次结果: only on this page. The Host keeps its receipt unknown and never sends it again; the page lets the person
   * choose anew from what the Agent reports now, with a new requestId.
   */
  const abandonConfig = () => {
    if (selectedId === null) return
    const id = selectedId,
      request = configRequests.current.get(id)
    if (!request || configFlights.current.has(id)) return
    configRequests.current.abandon(id, request)
    setConfigFeedback(previous => {
      const next = new Map(previous)
      next.delete(id)
      return next
    })
    void refresh()
  }

  // A local action says nothing when it works: the row moving or folding away is the feedback. Failures are toasts.
  const patchTask = useStableCallback(async (task: TaskSummary, patch: SessionPatch) => {
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
  /** 标签… and 优先级, where the Host groups sessions and this device may change them: the session menu and the board's cards. */
  const boardMarks = useCallback(
    (task: TaskSummary): BoardMarkActions | undefined =>
      task.board && manageable && access.scopes.has('run')
        ? {
            setPriority: priority => {
              void patchTask(task, { priority: priority ?? 'mid' })
            },
            editTags: () => {
              setTagging(task)
            },
          }
        : undefined,
    [manageable, access, patchTask],
  )
  const copyTask = useStableCallback(async (task: TaskSummary) => {
    try {
      const data = task.id === current?.summary.id ? current : await api<TaskDetail>(`tasks/${encodeURIComponent(task.id)}`)
      await writeClipboard(transcriptMarkdown(data))
      setToast({
        get text() {
          return COPY.copied
        },
        tone: 'ok',
      })
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  const saveSessionProject = useStableCallback(async (task: TaskSummary) => {
    try {
      const result = await shellFolders()!.saveSessionFolder!(task.id)
      if (result.status === 'added') {
        await refresh()
        setToast(result.refused.length ? { text: COPY.saveFolderFailed, tone: 'error' } : { text: COPY.savedAsProject, tone: 'ok' })
      } else if (result.status === 'busy')
        setToast({
          get text() {
            return COPY.dialogBusy
          },
          tone: 'error',
        })
      else if (result.status === 'failed')
        setToast({
          get text() {
            return COPY.saveFolderSync
          },
          tone: 'error',
        })
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  /** 加入待办… or 移出待办, for a Code session where the Host keeps 待办 and this device may change them. */
  const itemActions = useStableCallback((task: TaskSummary) => {
    if (!catalog?.features?.workItems || !access.scopes.has('run') || !codeSession(task)) return undefined
    const item = itemOfSession(snapshot, task.id)
    return item
      ? {
          leave: () => {
            void leaveItem({ refresh, setToast }, item.id, task.id)
          },
        }
      : {
          join: () => {
            askJoinItem(task.id)
          },
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
          marks: boardMarks(task),
          item: itemActions(task),
          pin: () => {
            void patchTask(task, { pinned: !task.pinned })
          },
          ...(!isPersonalChat(snapshot, task)
            ? {
                archive: () => {
                  void patchTask(task, { archived: !task.archived }).then(done => {
                    if (done) setArchivedLast(task.archived ? null : task)
                  })
                },
              }
            : {}),
          export: () => {
            void exportTask(task)
          },
          ...(!isPersonalChat(snapshot, task)
            ? {
                remove: () => {
                  setDeleting(task)
                },
              }
            : {}),
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
      locale,
      manageable,
      boardMarks,
      setRenaming,
      setDeleting,
      access,
      catalog,
      snapshot.agentChats,
      snapshot.items,
      itemActions,
      saveSessionProject,
      clearable,
      selectedId,
      clearing,
      armClear,
    ],
  )

  // Creator sessions use a dedicated Host folder and do not depend on the ordinary default folder.
  const launchChoice = creating ? { ...choice, workspaceId: undefined } : choice
  const block = selectedId === null ? startBlock(snapshot, launchChoice) : null
  const chosenHarness = selectedId === null ? catalog?.harnesses.find(item => item.id === choice.harnessId) : undefined
  const chosenScopeCaption =
    creating || choice.mode === 'chat'
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
      ? NOTICE_COPY.configUnverified
      : stopCode && SESSION_STOP_LABEL[stopCode]
  const stopRetry =
    stopCode === undefined || stopLocksInput(stopCode)
      ? undefined
      : retryOfRefused(refusedInput, { draft: submission.draft, attachments: attachmentDraft.items.length })
  const resend = async (prompt: string, teamRequest?: true) => {
    if (selectedId === null) return
    clearUnverified(selectedId)
    await settingsLanded()
    await submission.send({ prompt, ...(teamRequest ? { teamRequest } : {}) })
  }
  /** A team request gets a turn of its own, including while another turn runs. */
  const sendTeamPrompt = async (prompt: string) => {
    if (inputId === null) return false
    clearUnverified(inputId)
    await settingsLanded()
    return submission.send({ prompt, teamRequest: true }, active && canQueue ? 'queue' : undefined)
  }
  const retryStopped = () => {
    if (stopRetry?.kind === 'draft') void sendDraft()
    else if (stopRetry?.kind === 'prompt') void resend(stopRetry.prompt, stopRetry.teamRequest)
  }
  const homeCode = selectedId === null ? undefined : homeRefused.get(selectedId)
  /** A short state above an Agent chat's input: the reason behind its hover, and 重试 for what was refused. */
  const homeStop = homeCode ? { reason: describeFailure(409, homeCode) } : undefined
  const retryHome = () => {
    if (selectedId === null) return
    const again = retryOfRefused(refusedInput, { draft: submission.draft, attachments: attachmentDraft.items.length })
    clearHomeRefused(selectedId)
    if (again?.kind === 'draft') void sendDraft()
    else if (again?.kind === 'prompt') void submission.send({ prompt: again.prompt, ...(again.teamRequest ? { teamRequest: true } : {}) })
  }
  // Rebuilt as text into another session: this one stays to read, and links there.
  const rebuiltInto = summary ? rebuiltFrom(snapshot.tasks, summary.id) : undefined
  const personalOwner = topicOwner(summary)
  const gate =
    rebuiltInto !== undefined
      ? { kind: 'read-only' as const, text: COPY.rebuiltReadOnly }
      : selectedId === null
        ? access.legacy || access.scopes.has('run')
          ? { kind: 'open' as const }
          : { kind: 'read-only' as const, text: COPY.runDenied }
        : personalOwner && summary && !isPersonalChat(snapshot, summary)
          ? { kind: 'read-only' as const, text: COPY.previousChat }
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
        ? COPY.removedWorktree
        : workspaceChanged.has(selectedId)
          ? COPY.chooseProject
          : harnessInfo?.status === 'unavailable'
            ? harnessInfo.statusMessage || COPY.harnessUnavailable(harnessLabel(harnessInfo))
            : !catalog && snapshot.execution?.ready === false
              ? COPY.modelUnavailable
              : undefined
  useEffect(() => {
    setApprovalTarget(target => (target?.sessionId === selectedId ? target : undefined))
  }, [selectedId])
  const approvalIndex =
    approvalTarget?.sessionId === selectedId
      ? Math.max(
          0,
          approvals.findIndex(item => item.id === approvalTarget?.approvalId),
        )
      : 0
  const selectApproval = (approvalId: string) => {
    if (selectedId && approvals.some(approval => approval.id === approvalId)) setApprovalTarget({ sessionId: selectedId, approvalId })
  }
  const setApprovalIndex = (index: number) => {
    const approval = approvals[index]
    if (approval) selectApproval(approval.id)
  }
  const shownApproval = approvals[approvalIndex]
  const earlierDraft = useEarlierDraft(
    useMemo(
      () => (inputTarget === 'new' ? [] : [...approvals.map(item => item.id), ...(current?.questions ?? []).map(item => item.id)]),
      [approvals, current?.questions, inputTarget],
    ),
    submission.draft,
  )
  // While an approval waits, what is typed goes back with the rejection, where the Host takes a note.
  const rejection = useRejectionNote({
    selectedId,
    approval: shownApproval,
    mayType:
      inputId !== null
      && gate.kind === 'open'
      && sessionBlock === undefined
      && submission.pending === null
      && !earlierDraft.held
      && !(shownApproval && approvalStatuses.get(shownApproval.id)?.uncertain),
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
      const uncertain = approvalStatuses.get(approval.id)?.uncertain
      if (again !== undefined) {
        if (
          !uncertain
          || uncertain.decision !== decision
          || uncertain.optionId !== optionId
          || uncertain.note !== again.note
          || !canRetryApproval(uncertain)
          || !retryApprovalOption(gateFor(approval), uncertain)
        )
          return
      } else if (uncertain) return
      if (decision === 'reject' && again === undefined) rejection.reject(approval, optionId)
      else void decide(approval, decision, optionId, again?.note, again !== undefined)
    },
  )
  const statuses = approvalStatuses
  const noteComposer = rejection.composer
  // Developing the running copy affects the current workspace, regardless of the selected Harness.
  const codeRootChoice =
    selectedId === null && choice.mode !== 'chat'
      ? codeRootWorkspace(catalog?.workspaces, { id: choice.workspaceId ?? 'default' })
      : undefined
  const currentModel = sessionModel(summary)
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
          onResend: (prompt: string, teamRequest?: true) => {
            void resend(prompt, teamRequest)
          },
        }
      : undefined
  const retryFromWorkbench = (detail: TaskDetail) => {
    const user = detail.messages.findLast(message => message.role === 'user' && !message.steered)
    const failure = detail.messages.findLast(message => message.role === 'system' && message.state === 'failed')
    if (!user?.text || failureAction(failure?.errorCode) !== 'retry' || (detail.summary.runEnd?.unknownResultCount ?? 0) > 0) return
    const { id, runId, updatedAt } = detail.summary
    // Selecting still passes the unsaved-editor and draft guards; the one sender acts only after its target arrives.
    choose(id, () =>
      setQueuedRetry({ id, ...(runId ? { runId } : {}), updatedAt, prompt: user.text, ...(user.teamRequest ? { teamRequest: true } : {}) }),
    )
  }
  useEffect(() => {
    if (!queuedRetry || consumedRetry.current === queuedRetry || inputId !== queuedRetry.id || current?.summary.id !== queuedRetry.id)
      return
    consumedRetry.current = queuedRetry
    setQueuedRetry(null)
    const task = current.summary
    if (
      !retry
      || harness.connection !== 'connected'
      || task.runId !== queuedRetry.runId
      || task.updatedAt !== queuedRetry.updatedAt
      || (task.status !== 'failed' && task.runOutcome !== 'failed')
      || (task.runEnd?.unknownResultCount ?? 0) > 0
    ) {
      setToast({
        get text() {
          return COPY.sessionChanged
        },
        tone: 'error',
      })
      return
    }
    void resend(queuedRetry.prompt, queuedRetry.teamRequest)
  }, [queuedRetry, inputId, current, retry, harness.connection])
  const askedQuestion = current?.questions?.[0]?.state === 'answering' ? undefined : current?.questions?.[0]
  const startWords = mode === 'chat' ? COPY.ask : COPY.prompt
  // A topic of a conversation in 我的 Agent says whom the message goes to.
  const topicName = selectedId !== null && summary ? sessionAgent(snapshot, summary)?.name : undefined
  const placeholder =
    submission.pending !== null
      ? COPY.pending
      : gate.kind === 'stopped'
        ? COPY.noInput
        : askedQuestion && gate.kind === 'open'
          ? COPY.answer
          : selectedId === null
            ? startWords
            : active
              ? catalog?.features?.queue
                ? COPY.steerOrQueue
                : COPY.writeNow
              : topicName
                ? COPY.messageTopic(topicName)
                : startWords

  return {
    parkInputDraft: () => {
      const hidden = inputId !== null && (summary === undefined || privateSession(summary) || privateDraftId.current === inputId)
      if (hidden && !privateVisible) {
        sessionDrafts.current.remove(inputId!)
        return true
      }
      if (sessionDrafts.current.save(inputKey, submission.draft, hidden || inputKey === PLUGIN_CREATION_DRAFT)) return true
      setToast({
        get text() {
          return COPY.draftLimit
        },
        tone: 'error',
      })
      return false
    },
    inputId,
    inputTarget,
    creator,
    creatorAvailable,
    creatorBlocked,
    creatorBlockedReason,
    chooseCreator,
    sessionInput: {
      draft: inputTarget === 'new' ? sessionDrafts.current.read(selectedId ?? NEW_SESSION_DRAFT, privateVisible) : submission.draft,
      attachments: sessionAttachments,
    },
    homeComposerState: {
      selectedId: null,
      sendingView: sendingMessageFor(snapshot, submission.sendingMessage, null, null),
      current: null,
      summary: undefined,
      active: false,
      steer: false,
      clearable: false,
      run: undefined,
      noteComposer: undefined,
      harnessInfo: undefined,
      currentModel: undefined,
      effectiveModel: undefined,
      approvals: [],
      block: startBlock(snapshot, launchChoice),
      chosenHarness: draftHarness,
      chosenScopeCaption:
        creating || choice.mode === 'chat'
          ? undefined
          : projectScopeCaption(
              catalog?.workspaces.find(item => item.id === choice.workspaceId),
              draftHarness,
            ),
      codeRootChoice:
        creating || choice.mode === 'chat' ? undefined : codeRootWorkspace(catalog?.workspaces, { id: choice.workspaceId ?? 'default' }),
      gate:
        access.legacy || access.scopes.has('run')
          ? { kind: 'open' as const }
          : { kind: 'read-only' as const, text: COPY.runDenied, reason: undefined },
      sessionBlock: undefined,
      pendingQueued: null,
      placeholder: COPY.prompt,
      newChoicesLocked:
        submission.pending !== null || submission.sending || newAttachments.preparing || !(access.legacy || access.scopes.has('run')),
    },
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
    tagging,
    setTagging,
    boardMarks,
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
    selectApproval,
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
    canSteerDraft,
    gateFor,
    canRetryApproval,
    checkApproval,
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
    seedEdit,
    quoteSnapshots,
    mentionScope,
    setSubmissionDraft,
    mentionChoice,
    sendDraft,
    sendTeamPrompt,
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
    openApproval,
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
    retryConfig,
    abandonConfig,
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
    homeStop,
    retryHome,
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
    retryFromWorkbench,
    placeholder,
  }
}
