import { useEffect, useState, useSyncExternalStore } from 'react'
import type { HarnessInfo, HostCatalog, Message, TaskDetail, TaskSummary } from '@latch/protocol'
import { Button, IconButton, InlineNotice, StatusWord, CloseGlyph, CopyGlyph } from '@latch/ui'
import { api, errorMessage, isUncertain, newRequestId } from '../core/api.ts'
import { MessageContent } from '../MessageContent.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useBackLayer } from '../hooks/backStack.ts'

/**
 * /btw: a side question asked next to a session without touching its turn or its history. It is a fork of the session
 * that only chats (只对话), with the Host's text record of the settled turns as background, on the same Harness and
 * model; the turn that runs now is not part of it and never waits for it. The answer shows in a panel beside the
 * session, which offers 插入到输入框 and 打开为会话; closing the panel archives the fork (Code › 已归档 lists it).
 */

/** `/btw <question>` as typed into the input: the question, or undefined when the text is something else. */
export function sideQuestionOf(draft: string): string | undefined {
  const match = /^\/btw(?:\s+([\s\S]*))?$/u.exec(draft.trimStart())
  if (!match) return undefined
  return (match[1] ?? '').trim()
}

/** Why /btw is not offered for this session, or undefined when it is. */
export function sideQuestionRefusal(
  catalog: Pick<HostCatalog, 'features'> | undefined,
  harness: Pick<HarnessInfo, 'modes' | 'status'> | undefined,
): string | undefined {
  if (catalog?.features?.fork !== true || !harness || !harness.modes.includes('chat')) return '这个 Harness 尚不支持'
  if (harness.status !== 'ready') return '这个 Harness 当前不可用'
  return undefined
}

/**
 * Why the input must not send `draft` now: it is `/btw …` in a session where /btw is listed but not available. Such text
 * is never sent to the Harness as a prompt, queued or added to the running turn.
 */
export function sideQuestionBlock(draft: string, offered: boolean, refusal: string | undefined): string | undefined {
  return offered && refusal !== undefined && sideQuestionOf(draft) !== undefined ? `/btw：${refusal}` : undefined
}

const SETTLING = new Set(['running', 'queued', 'awaiting-approval'])
const ENDED: ReadonlySet<TaskSummary['status']> = new Set(['idle', 'failed', 'cancelled', 'interrupted'])

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
  const mine = () => questions.get(question.sourceId)?.body.requestId === question.body.requestId
  try {
    const { sessionId } = await sideQuestionTransport.request<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: question.body,
      timeoutMs: 30_000,
    })
    // Closed (or replaced) while it started: the fork stops and goes to 已归档, and the panel stays shut.
    if (!mine()) {
      await dismiss(sessionId, true)
      return
    }
    put({ ...question, phase: 'open', forkId: sessionId }, question.sourceId)
  } catch (cause) {
    if (!mine()) return
    // An unknown outcome keeps the request: 重试 sends the same one, and the Host answers it once.
    put({ ...question, phase: isUncertain(cause) ? 'unknown' : 'failed', error: errorMessage(cause) }, question.sourceId)
  }
}

/** Starts the side question for `detail`'s session; a new one replaces a panel that is open there. */
export async function askSideQuestion(detail: TaskDetail, question: string, workspaceId: string | undefined, running: boolean) {
  const previous = questions.get(detail.summary.id)
  if (previous?.forkId) void dismiss(previous.forkId, true)
  await send({
    sourceId: detail.summary.id,
    question,
    body: sideQuestionBody(detail, question, workspaceId, running),
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

const quote = (text: string) =>
  text
    .trim()
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')

/**
 * The panel beside the session (a page of its own on a phone): the question, the answer as it arrives, and what can be
 * done with it. Closing archives the fork.
 */
export function SideQuestionPanel({
  sourceId,
  tasks,
  phone,
  onInsert,
  onOpen,
}: {
  sourceId: string
  tasks: readonly TaskSummary[]
  phone: boolean
  onInsert(text: string): void
  onOpen(sessionId: string): void
}) {
  const question = useSideQuestion(sourceId)
  const summary = question?.forkId ? tasks.find(task => task.id === question.forkId) : undefined
  const [detail, setDetail] = useState<TaskDetail>()
  const [readError, setReadError] = useState('')
  const forkId = question?.forkId
  const status = summary?.status
  useEffect(() => {
    setDetail(undefined)
  }, [forkId])
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
  // On a phone the panel is a page: the system's back closes it, as its × does.
  const answering = status === undefined || !ENDED.has(status)
  useBackLayer(phone && question !== undefined, () => {
    void closeSideQuestion(sourceId, answering)
  })
  if (!question) return null
  const answer = answerOf(detail)
  const settled = !!detail && !answer.streaming && (status === undefined || ENDED.has(status))
  const failed = status === 'failed' || status === 'interrupted' || detail?.summary.status === 'failed'
  const close = () => {
    void closeSideQuestion(sourceId, answering)
  }
  return (
    <aside className="side-question" data-phone={phone ? '' : undefined} aria-label="旁支提问">
      <header className="side-question-head">
        <span className="side-question-title">
          /btw
          {question.phase === 'starting' || (question.phase === 'open' && !settled && !failed) ? (
            <StatusWord tone="running">正在回答</StatusWord>
          ) : question.phase === 'unknown' ? (
            <StatusWord tone="warn">结果未知</StatusWord>
          ) : question.phase === 'failed' || failed ? (
            <StatusWord tone="failed">没有回答</StatusWord>
          ) : null}
        </span>
        <IconButton size="xs" icon={CloseGlyph} label="关闭并归档" onClick={close} />
      </header>
      <p className="side-question-question">
        <VisibleText text={question.question} />
      </p>
      <div className="side-question-answer" aria-live="polite">
        {question.phase === 'failed' || question.phase === 'unknown' ? (
          <InlineNotice tone={question.phase === 'unknown' ? 'warn' : 'error'}>{question.error ?? '没有开始'}</InlineNotice>
        ) : answer.text ? (
          <MessageContent text={answer.text} streaming={answer.streaming} />
        ) : failed ? (
          <InlineNotice tone="error">没有回答</InlineNotice>
        ) : readError ? (
          <InlineNotice tone="warn">{readError}</InlineNotice>
        ) : (
          <p className="side-question-wait">正在回答…</p>
        )}
      </div>
      <footer className="side-question-actions">
        {question.phase === 'unknown' || question.phase === 'failed' ? (
          <Button size={phone ? 'lg' : 'sm'} variant="primary" onClick={() => void send(question)}>
            重试
          </Button>
        ) : (
          <>
            <Button
              size={phone ? 'lg' : 'sm'}
              icon={CopyGlyph}
              disabled={!settled || !answer.text}
              onClick={() => {
                onInsert(quote(answer.text))
                close()
              }}>
              插入到输入框
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
              打开为会话
            </Button>
          </>
        )}
      </footer>
    </aside>
  )
}
