import { quotedExcerpt } from '../composer/quotedExcerpt.ts'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { HarnessInfo, HostCatalog, Message, TaskDetail, TaskSummary } from '@latch/protocol'
import {
  Button,
  ChevronLeftGlyph,
  CloseGlyph,
  CopyGlyph,
  Dialog,
  IconButton,
  InlineNotice,
  MessageGlyph,
  StatusWord,
  useStreamingLayer,
} from '@latch/ui'
import { api, errorMessage, isUncertain, newRequestId } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { MessageContent } from '../MessageContent.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useBackLayer } from '../hooks/backStack.ts'
import { latchActionOf } from '../composer/latchActions.ts'

const COPY = defineCopy(
  {
    unsupported: '这个 Harness 尚不支持',
    unavailable: '这个 Harness 当前不可用',
    blocked: (why: string) => `/btw：${why}`,
    panel: '旁支提问',
    answering: '正在回答',
    unknown: '结果未知',
    unanswered: '没有回答',
    close: '关闭并归档',
    didNotStart: '没有开始',
    waiting: '正在回答…',
    retry: '重试',
    insert: '插入到输入框',
    open: '打开为会话',
    back: '返回对话',
    resume: '查看旁支提问',
    replaceTitle: '替换第一条旁支提问？',
    replaceMessage: '第一问会被归档。如果它还在回答，Latch 会先停止它。',
    replaceStarting: '第一问还在启动。收到它的回执后，Latch 会停止并归档它。',
    replaceUnknown: '第一问是否已经开始尚未确认。如果已开始但未收到回执，可以在会话列表中找到它。',
    replaceFailed: '第一问没有开始。你可以保留它重试，或直接发送第二问。',
    keep: '保留第一问',
    replace: '替换并发送',
  },
  {
    unsupported: 'This Harness does not support side questions yet',
    unavailable: 'This Harness is unavailable',
    blocked: (why: string) => `/btw: ${why}`,
    panel: 'Side question',
    answering: 'Answering',
    unknown: 'Outcome unknown',
    unanswered: 'No answer',
    close: 'Close and archive',
    didNotStart: 'Did not start',
    waiting: 'Answering…',
    retry: 'Retry',
    insert: 'Insert into input',
    open: 'Open as a session',
    back: 'Back to conversation',
    resume: 'View side question',
    replaceTitle: 'Replace the first side question?',
    replaceMessage: 'The first question will be archived. If it is still answering, Latch will stop it first.',
    replaceStarting: 'The first question is still starting. If Latch receives its start receipt, it will stop and archive it.',
    replaceUnknown: 'The first question’s start is unconfirmed. If it started and the receipt was lost, look for it in the session list.',
    replaceFailed: 'The first question did not start. You can keep it to retry or send the second question now.',
    keep: 'Keep first question',
    replace: 'Replace and send',
  },
)

/**
 * /btw: a side question asked next to a session without touching its turn or its history. It is a fork of the session
 * that only chats (只对话), with the Host's text record of the settled turns as background, on the same Harness and
 * model; the turn that runs now is not part of it and never waits for it. The answer shows in a panel beside the
 * session, which offers 插入到输入框 and 打开为会话; closing the panel archives the fork (Code › 已归档 lists it).
 */

/** `/btw <question>` as typed into the input: the question, or undefined when the text is something else. */
export function sideQuestionOf(draft: string): string | undefined {
  const action = latchActionOf(draft)
  return action?.name === 'btw' ? action.argument : undefined
}

/** Why /btw is not offered for this session, or undefined when it is. */
export function sideQuestionRefusal(
  catalog: Pick<HostCatalog, 'features'> | undefined,
  harness: Pick<HarnessInfo, 'modes' | 'status'> | undefined,
): string | undefined {
  if (catalog?.features?.fork !== true || !harness || !harness.modes.includes('chat')) return COPY.unsupported
  if (harness.status !== 'ready') return COPY.unavailable
  return undefined
}

/**
 * Why the input must not send `draft` now: it is `/btw …` in a session where /btw is listed but not available. Such text
 * is never sent to the Harness as a prompt, queued or added to the running turn.
 */
export function sideQuestionBlock(draft: string, offered: boolean, refusal: string | undefined): string | undefined {
  return offered && refusal !== undefined && sideQuestionOf(draft) !== undefined ? COPY.blocked(refusal) : undefined
}

const SETTLING = new Set(['running', 'queued', 'awaiting-approval'])
const ENDED: ReadonlySet<TaskSummary['status']> = new Set(['idle', 'failed', 'cancelled', 'interrupted'])
const mayAnswer = (status: TaskSummary['status'] | undefined) => status === undefined || !ENDED.has(status)

/**
 * The last message of the last settled turn: while a turn runs, the message before its prompt. Undefined when no turn
 * has settled yet (the side question then starts without background).
 */
export function sideQuestionPoint(messages: readonly Message[], running: boolean): string | undefined {
  const lastUser = messages.findLastIndex(message => message.role === 'user' && !message.steered)
  let end = running ? lastUser - 1 : messages.length - 1
  if (messages.slice(0, end + 1).some(message => SETTLING.has(message.state ?? ''))) {
    end = messages.findIndex(message => SETTLING.has(message.state ?? '')) - 1
    // Back to the end of a turn: the message before the next prompt.
    while (end >= 0 && messages[end + 1]?.role !== 'user') end--
  }
  return end >= 0 ? messages[end]!.id : undefined
}

/** What `POST /tasks` gets for a side question: the same request on a retry. */
export function sideQuestionBody(detail: TaskDetail, question: string, workspaceId: string | undefined, running: boolean) {
  const { summary } = detail
  const upTo = sideQuestionPoint(detail.messages, running)
  const builtin = summary.providerId !== undefined && summary.model !== undefined
  const route = summary.modelRoute
  const model = builtin
    ? { providerId: summary.providerId!, model: summary.model!, ...(summary.effort ? { effort: summary.effort } : {}) }
    : route
      ? { providerId: route.providerId, model: route.model }
      : undefined
  return {
    requestId: newRequestId(),
    prompt: question,
    mode: 'chat' as const,
    harnessId: summary.harnessId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(upTo ? { forkOf: { taskId: summary.id, upToMessageId: upTo } } : {}),
    ...(model ? { model } : {}),
  }
}

type Body = ReturnType<typeof sideQuestionBody>
export interface SideQuestion {
  sourceId: string
  question: string
  body: Body
  phase: 'starting' | 'unknown' | 'failed' | 'open'
  forkId?: string
  error?: string
  minimized?: boolean
}

/** One side question per session, in memory: it is a panel of this window, not a record. */
const questions = new Map<string, SideQuestion>()
const listeners = new Set<() => void>()
const NO_FORKS: ReadonlySet<string> = new Set()
/** The forks of the open panels: kept as one value, so a list re-renders only when they change. */
let forks: ReadonlySet<string> = NO_FORKS
const put = (question: SideQuestion | undefined, sourceId: string) => {
  if (question) questions.set(sourceId, question)
  else questions.delete(sourceId)
  const ids = [...questions.values()].flatMap(item => (item.forkId ? [item.forkId] : []))
  if (ids.length !== forks.size || ids.some(id => !forks.has(id))) forks = ids.length ? new Set(ids) : NO_FORKS
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSideQuestion(sourceId: string | null): SideQuestion | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (sourceId ? questions.get(sourceId) : undefined),
    () => undefined,
  )
}

/**
 * The sessions behind the open /btw panels. They are the panel's, not the session list's, until 打开为会话 makes one an
 * ordinary session (or closing archives it).
 */
export function useSideQuestionForks(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => forks,
    () => NO_FORKS,
  )
}

/** The session list without the forks of open /btw panels; the open session always stays. */
export function withoutSideForks<T extends { tasks: readonly TaskSummary[] }>(
  snapshot: T,
  hidden: ReadonlySet<string>,
  selectedId: string | null,
): T {
  if (!hidden.size || !snapshot.tasks.some(task => hidden.has(task.id) && task.id !== selectedId)) return snapshot
  return { ...snapshot, tasks: snapshot.tasks.filter(task => !hidden.has(task.id) || task.id === selectedId) }
}

/** How the panel reaches the Host; tests replace it. */
export const sideQuestionTransport = {
  request: <T,>(path: string, init: Parameters<typeof api>[1]): Promise<T> => api<T>(path, init),
}

/** The side question shown for a session, if any. */
export const currentSideQuestion = (sourceId: string): SideQuestion | undefined => questions.get(sourceId)

async function send(question: SideQuestion): Promise<void> {
  put({ ...question, phase: 'starting' }, question.sourceId)
  const mine = () => {
    const latest = questions.get(question.sourceId)
    return latest?.body.requestId === question.body.requestId ? latest : undefined
  }
  try {
    const { sessionId } = await sideQuestionTransport.request<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: question.body,
      timeoutMs: 30_000,
    })
    // Closed (or replaced) while it started: the fork stops and goes to 已归档, and the panel stays shut.
    const latest = mine()
    if (!latest) {
      await dismiss(sessionId, true)
      return
    }
    put({ ...latest, phase: 'open', forkId: sessionId }, question.sourceId)
  } catch (cause) {
    const latest = mine()
    if (!latest) return
    // An unknown outcome keeps the request: 重试 sends the same one, and the Host answers it once.
    put({ ...latest, phase: isUncertain(cause) ? 'unknown' : 'failed', error: errorMessage(cause) }, question.sourceId)
  }
}

/** Starts a side question. Replacement requires consent for the exact request still holding the card. */
export function askSideQuestion(
  detail: TaskDetail,
  question: string,
  workspaceId: string | undefined,
  running: boolean,
  replace?: { requestId: string; status?: TaskSummary['status'] | undefined },
): Promise<void> | undefined {
  const sourceId = detail.summary.id
  const previous = questions.get(sourceId)
  if (previous?.body.requestId !== replace?.requestId) return undefined
  const body = sideQuestionBody(detail, question, workspaceId, running)
  if (previous?.forkId) void dismiss(previous.forkId, mayAnswer(replace?.status))
  return send({
    sourceId,
    question,
    body,
    phase: 'starting',
  })
}

/** Stops the fork's answer when it may still run, then archives it; neither failure keeps the panel open. */
async function dismiss(forkId: string, mayRun: boolean): Promise<void> {
  const path = `tasks/${encodeURIComponent(forkId)}`
  if (mayRun)
    await sideQuestionTransport.request<unknown>(`${path}/cancel`, { method: 'POST', body: { requestId: newRequestId() } }).catch(() => {})
  await sideQuestionTransport.request<unknown>(path, { method: 'PATCH', body: { archived: true } }).catch(() => {})
}

/**
 * Closes the panel at once: an answer still running is cancelled before the fork is archived, and a start or a read
 * that answers afterwards changes nothing here.
 */
export function closeSideQuestion(sourceId: string, running: boolean): Promise<void> {
  const question = questions.get(sourceId)
  put(undefined, sourceId)
  return question?.forkId ? dismiss(question.forkId, running) : Promise.resolve()
}

export function ReplaceSideQuestionDialog({
  phase,
  onKeep,
  onReplace,
}: {
  phase: SideQuestion['phase']
  onKeep: () => void
  onReplace: () => void
}) {
  const message = {
    starting: COPY.replaceStarting,
    unknown: COPY.replaceUnknown,
    failed: COPY.replaceFailed,
    open: COPY.replaceMessage,
  }[phase]
  return (
    <Dialog
      open
      title={COPY.replaceTitle}
      onClose={onKeep}
      footer={
        <>
          <Button size="md" onClick={onKeep}>
            {COPY.keep}
          </Button>
          <Button size="md" variant="primary" onClick={onReplace}>
            {COPY.replace}
          </Button>
        </>
      }>
      <p>{message}</p>
    </Dialog>
  )
}

/** The answer so far: the fork's replies after its question, as one text. */
function answerOf(detail: TaskDetail | undefined): { text: string; streaming: boolean } {
  if (!detail) return { text: '', streaming: false }
  const first = detail.messages.findIndex(message => message.role === 'user')
  const replies = detail.messages.slice(first + 1).filter(message => message.role === 'assistant')
  return {
    text: replies.map(message => message.text).join('\n\n'),
    streaming: replies.some(message => message.state === 'running') || detail.summary.status === 'running',
  }
}

/**
 * The panel beside the session (a page of its own on a phone): the question, the answer as it arrives, and what can be
 * done with it. Closing archives the fork.
 */
export function SideQuestionPanel({
  sourceId,
  question,
  visible,
  observeStream,
  tasks,
  phone,
  onInsert,
  onOpen,
}: {
  sourceId: string
  question: SideQuestion | undefined
  visible: boolean
  observeStream: boolean
  tasks: readonly TaskSummary[]
  phone: boolean
  onInsert(text: string): void
  onOpen(sessionId: string): void
}) {
  const summary = question?.forkId ? tasks.find(task => task.id === question.forkId) : undefined
  const [detail, setDetail] = useState<TaskDetail>()
  const [readError, setReadError] = useState('')
  const forkId = question?.forkId
  const status = summary?.status
  const minimized = phone && question?.minimized === true
  const requestId = question?.body.requestId
  const back = useRef<HTMLButtonElement>(null)
  const resume = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!phone || !visible || !requestId) return
    const target = minimized ? resume : back
    target.current?.focus({ preventScroll: true })
  }, [phone, visible, requestId, minimized])
  // The fork's detail follows its summary, and is read again every second while it runs.
  useEffect(() => {
    if (!forkId) return undefined
    let stopped = false
    const read = () =>
      api<TaskDetail>(`tasks/${encodeURIComponent(forkId)}`)
        .then(next => {
          if (!stopped) {
            setDetail(next)
            setReadError('')
          }
        })
        .catch(cause => {
          if (!stopped) setReadError(errorMessage(cause))
        })
    void read()
    const timer = status !== undefined && ENDED.has(status) ? undefined : setInterval(read, 1000)
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
    }
  }, [forkId, status, summary?.updatedAt])
  const minimize = (value: boolean) => {
    const latest = currentSideQuestion(sourceId)
    if (latest && latest.body.requestId === requestId) put({ ...latest, minimized: value }, sourceId)
  }
  // Back returns to the conversation; the separate close action archives the fork.
  const answering = mayAnswer(status)
  useBackLayer(visible && phone && question !== undefined && !minimized, () => minimize(true))
  const answer = answerOf(detail)
  const stream = useRef<HTMLDivElement>(null)
  useStreamingLayer(stream, !minimized && observeStream && question?.phase === 'open' && answer.streaming && !!answer.text)
  if (!question) return null
  if (minimized)
    return (
      <div className="side-question-resume">
        <Button ref={resume} size="lg" variant="ghost" icon={MessageGlyph} onClick={() => minimize(false)}>
          {COPY.resume}
        </Button>
      </div>
    )
  const settled = !!detail && !answer.streaming && (status === undefined || ENDED.has(status))
  const failed = status === 'failed' || status === 'interrupted' || detail?.summary.status === 'failed'
  const close = () => {
    void closeSideQuestion(sourceId, answering)
  }
  return (
    <aside
      className="side-question"
      data-phone={phone ? '' : undefined}
      aria-label={COPY.panel}
      data-backdrop-clear=""
      onKeyDown={event => {
        if (!phone || event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        minimize(true)
      }}>
      <header className="side-question-head">
        {phone && (
          <Button ref={back} size="lg" variant="ghost" icon={ChevronLeftGlyph} onClick={() => minimize(true)}>
            {COPY.back}
          </Button>
        )}
        <span className="side-question-title">
          /btw
          {question.phase === 'starting' || (question.phase === 'open' && !settled && !failed) ? (
            <StatusWord tone="running">{COPY.answering}</StatusWord>
          ) : question.phase === 'unknown' ? (
            <StatusWord tone="warn">{COPY.unknown}</StatusWord>
          ) : question.phase === 'failed' || failed ? (
            <StatusWord tone="failed">{COPY.unanswered}</StatusWord>
          ) : null}
        </span>
        <IconButton size={phone ? 'lg' : 'xs'} icon={CloseGlyph} label={COPY.close} onClick={close} />
      </header>
      <p className="side-question-question">
        <VisibleText text={question.question} />
      </p>
      <div ref={stream} className="side-question-answer" aria-live="polite">
        {question.phase === 'failed' || question.phase === 'unknown' ? (
          <InlineNotice tone={question.phase === 'unknown' ? 'warn' : 'error'}>{question.error ?? COPY.didNotStart}</InlineNotice>
        ) : answer.text ? (
          <MessageContent text={answer.text} streaming={answer.streaming} />
        ) : failed ? (
          <InlineNotice tone="error">{COPY.unanswered}</InlineNotice>
        ) : readError ? (
          <InlineNotice tone="warn">{readError}</InlineNotice>
        ) : (
          <p className="side-question-wait">{COPY.waiting}</p>
        )}
      </div>
      <footer className="side-question-actions">
        {question.phase === 'unknown' || question.phase === 'failed' ? (
          <Button size={phone ? 'lg' : 'sm'} variant="primary" onClick={() => void send(question)}>
            {COPY.retry}
          </Button>
        ) : (
          <>
            <Button
              size={phone ? 'lg' : 'sm'}
              icon={CopyGlyph}
              disabled={!settled || !answer.text}
              onClick={() => {
                onInsert(quotedExcerpt('side', answer.text))
                close()
              }}>
              {COPY.insert}
            </Button>
            <Button
              size={phone ? 'lg' : 'sm'}
              variant="primary"
              disabled={!question.forkId}
              onClick={() => {
                const id = question.forkId!
                // Opened as a session it is kept, not archived.
                put(undefined, sourceId)
                onOpen(id)
              }}>
              {COPY.open}
            </Button>
          </>
        )}
      </footer>
    </aside>
  )
}
