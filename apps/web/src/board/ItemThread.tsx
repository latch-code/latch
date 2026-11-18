import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  escapeSecurityText,
  WORK_THREAD_LIMITS,
  type AppSnapshot,
  type WorkItemSummary,
  type WorkPost,
  type WorkPostAnswer,
  type WorkPostReply,
  type WorkPostReplyAnswer,
  type WorkPostTarget,
  type WorkThreadAnswer,
} from '@latch/protocol'
import { Button, CloseGlyph, Icon, IconButton, SendGlyph, StatusWord, Suggest, Tooltip } from '@latch/ui'
import { AtSign } from 'lucide-react'
import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { MarkTile } from '../components/BrandTile.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, ApiError, errorMessage, newRequestId } from '../core/api.ts'
import { unconfirmedReason } from '../core/sendingMessage.ts'
import { hostNow } from '../core/hostClock.ts'
import { dateTime, relativeTime } from '../format.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import {
  deliveryWords,
  matchTargets,
  mentionAt,
  postPreview,
  postTarget,
  replySources,
  targetLabel,
  threadTargets,
  withoutMention,
  withoutMissingPostSources,
  withoutPostSource,
  type ThreadTarget,
} from './itemThread.ts'

const postsPath = (id: string) => `work/items/${encodeURIComponent(id)}/posts`

/** A post this device sent and the Host has not answered for certain: shown in its place, 重试 sends it as it was. */
interface Pending {
  requestId: string
  text: string
  target?: WorkPostTarget
  state: 'sending' | 'unknown'
  reason?: string
}

/** The thread as the Host has it, read again when it changes or a session it reads a reply from moves. */
function useThread(item: WorkItemSummary, scope: string, snapshot: AppSnapshot) {
  const [state, setState] = useState<{ scope: string; answer: WorkThreadAnswer } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const read = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const answer = await api<WorkThreadAnswer>(postsPath(item.id), { signal: controller.signal })
      if (controller.signal.aborted) return
      setState(previous => (previous?.scope === scope && previous.answer.revision > answer.revision ? previous : { scope, answer }))
      setFailed(null)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) setState(null)
      if (cause instanceof ApiError && cause.status === 404) return
      setFailed(errorMessage(cause))
    }
  }, [item.id, scope])
  const posts = state?.scope === scope ? state.answer.posts : null
  const visiblePosts = useMemo(
    () => (posts ? withoutMissingPostSources(posts, snapshot) : posts),
    [posts, snapshot.tasksComplete, snapshot.tasks],
  )
  useLayoutEffect(() => {
    if (!visiblePosts || visiblePosts === posts) return
    // Evict the content before a partial listing can make a still-cached reply visible again.
    request.current?.abort()
    setState(previous =>
      previous?.answer.posts === posts ? { ...previous, answer: { ...previous.answer, posts: visiblePosts } } : previous,
    )
  }, [posts, visiblePosts])
  const refuseReply = useCallback(
    (postId: string, messageId: string) => {
      request.current?.abort()
      setState(
        previous =>
          previous && {
            ...previous,
            answer: {
              ...previous.answer,
              posts: previous.answer.posts.map(post =>
                post.id === postId && post.reply?.messageId === messageId ? withoutPostSource(post) : post,
              ),
            },
          },
      )
      void read()
    },
    [read],
  )
  const replies = replySources(posts, snapshot)
  useEffect(() => {
    void read()
    return () => request.current?.abort()
  }, [read, item.threadRevision, replies])
  return { posts: visiblePosts, failed, read, refuseReply }
}

/**
 * A 待办's thread: the person's posts, oldest first, and the one input on the board. `@` names one of its sessions or
 * one of 我的 Agent; the post goes to that one only. Under a delivered post, 已交给 and the reply that turn gave, read from
 * the session (never copied); it opens where it is. Sending, an unknown result and a failure behave as the input's.
 */
export function ItemThread({ shell, item }: { shell: ShellState; item: WorkItemSummary }) {
  const { snapshot } = shell
  const canWrite = shell.access.scopes.has('run')
  const targets = useMemo(() => threadTargets(snapshot, item), [snapshot, item])
  const authority = [snapshot.device.id, snapshot.device.dataScope, snapshot.device.scopes.join(',')].join('|')
  const { posts, failed, read, refuseReply } = useThread(item, authority, snapshot)
  const [draft, setDraft] = useState('')
  const [target, setTarget] = useState<ThreadTarget | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const field = useRef<HTMLTextAreaElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const sending = useRef<string | null>(null)
  const observed = useRef(new Set<string>())
  const id = useId()

  const mention = mentionAt(draft, caret)
  const matches = mention ? matchTargets(targets, mention.query) : []
  const suggesting = mention !== undefined && dismissed !== draft && targets.length > 0
  const chosenIndex = Math.min(active, Math.max(0, matches.length - 1))
  const optionId = (index: number) => `${id}-target-${index}`

  const count = posts?.length ?? 0
  // The page scrolls, not the thread: after a post, the input (and the post just above it) is in view.
  const loaded = posts !== null
  const seen = useRef<number | null>(null)
  useEffect(() => {
    if (!loaded) return
    // Only the page's own scroll moves: scrollIntoView would also shift the shell, which hides its overflow.
    const body = anchor.current?.closest('.item-page-body')
    if (shell.board && seen.current !== null && count > seen.current && body && posts?.at(-1)?.requestId === sending.current)
      body.scrollTop = body.scrollHeight
    seen.current = count
  }, [count, loaded, shell.board, posts])
  useEffect(() => {
    observed.current = new Set((posts ?? []).flatMap(post => (post.requestId ? [post.requestId] : [])))
    if (!pending || !observed.current.has(pending.requestId)) return
    setPending(null)
    setDraft('')
    setTarget(null)
  }, [pending, posts])

  const choose = (choice: ThreadTarget) => {
    if (!mention) return
    const next = withoutMention(draft, mention.start, caret)
    setTarget(choice)
    setDraft(next)
    setActive(0)
    requestAnimationFrame(() => {
      const at = Math.max(0, mention.start - (draft.length - draft.trimStart().length))
      field.current?.focus()
      field.current?.setSelectionRange(at, at)
      setCaret(at)
    })
  }

  const send = async (request: Pending) => {
    sending.current = request.requestId
    setPending({ ...request, state: 'sending' })
    setRefused(null)
    try {
      await api<WorkPostAnswer>(postsPath(item.id), {
        method: 'POST',
        body: { requestId: request.requestId, text: request.text, ...(request.target ? { target: request.target } : {}) },
      })
      setPending(null)
      setDraft('')
      setTarget(null)
      await read()
    } catch (cause) {
      if (observed.current.has(request.requestId)) return
      const reason = unconfirmedReason(cause)
      if (reason !== null) {
        setPending({ ...request, state: 'unknown', reason })
        return
      }
      // Refused before it was kept: the words stay in the input to send again.
      setPending(null)
      setRefused(errorMessage(cause))
    }
  }

  const submit = () => {
    const text = draft.trim()
    if (!canWrite || !text || pending) return
    void send({ requestId: newRequestId(), text, ...(target ? { target: postTarget(target) } : {}), state: 'sending' })
  }

  /** 重发 of a kept post whose delivery failed or is unknown: the same request; the Host sends it at most once. */
  const resend = async (post: WorkPost) => {
    if (!post.requestId || !post.target) return
    try {
      await api<WorkPostAnswer>(postsPath(item.id), {
        method: 'POST',
        body: { requestId: post.requestId, text: post.text, ...(post.target ? { target: post.target } : {}) },
      })
    } catch (cause) {
      shell.setToast({ text: errorMessage(cause), tone: 'error' })
    }
    await read()
  }

  const open = (post: WorkPost, messageId?: string) => {
    const turn = post.turn
    if (!turn) return
    const action = post.attention
    const decision =
      action?.decisionId && turn.runId && (action.reason === 'question' || action.reason === 'approval')
        ? { kind: action.reason, id: action.decisionId, runId: turn.runId }
        : undefined
    shell.openWorkItemSession(item.id, { ...turn, ...(messageId ? { messageId } : {}), ...(decision ? { decision } : {}) })
  }

  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (suggesting && matches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((chosenIndex + step + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const choice = matches[chosenIndex]
        if (choice && (choice.kind === 'session' || choice.ready)) choose(choice)
        return
      }
    }
    if (suggesting && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setDismissed(draft)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      submit()
    }
  }

  const now = new Date(hostNow())
  const label = (post: WorkPost) => (post.target ? targetLabel(post.target, targets) : '')
  const unknown = pending?.state === 'unknown'
  const over = Array.from(draft.trim()).length > WORK_THREAD_LIMITS.postChars

  return (
    <section className="item-thread" aria-label="讨论">
      <header className="item-page-section-head">
        <h2>
          讨论 <span className="item-page-count">{count}</span>
        </h2>
      </header>
      {(count > 0 || pending) && (
        <ol className="item-thread-posts">
          {posts?.map(post => {
            const name = label(post)
            const state = deliveryWords(post, escapeSecurityText(name))
            const reply = post.reply
            const task = post.turn && snapshot.tasks.find(task => task.id === post.turn?.sessionId)
            const attention =
              task?.runId && task.runId === post.turn?.runId && task.board?.reason === post.attention?.reason ? post.attention : undefined
            const decision = attention?.reason === 'approval' ? '查看审批' : attention?.reason === 'question' ? '查看问题' : '查看原回合'
            return (
              <li key={post.id} className="item-thread-post" data-post-id={post.id} data-delivery={post.delivery?.state}>
                <ThreadPostContent
                  text={post.text}
                  target={post.target ? <TargetChip target={post.target} name={name} shell={shell} /> : undefined}
                  at={post.at}
                  now={now}
                />
                {state && (
                  <div className="item-thread-post-state">
                    {post.delivery?.reason ? (
                      <Tooltip content={post.delivery.reason}>
                        <StatusWord tone={state.tone} tabIndex={0}>
                          {state.words}
                        </StatusWord>
                      </Tooltip>
                    ) : (
                      <StatusWord tone={state.tone}>{state.words}</StatusWord>
                    )}
                    {(post.delivery?.state === 'unknown' || post.delivery?.state === 'failed')
                      && post.target
                      && post.requestId
                      && canWrite && (
                        <Button size="xs" variant="ghost" onClick={() => void resend(post)}>
                          重试
                        </Button>
                      )}
                    {task && (!reply || attention) && (
                      <Button className="item-thread-action" size="xs" variant="ghost" onClick={() => open(post)}>
                        {decision}
                      </Button>
                    )}
                  </div>
                )}
                {reply && (
                  <ThreadReply
                    key={reply.messageId}
                    path={`${postsPath(item.id)}/${encodeURIComponent(post.id)}/reply`}
                    postId={post.id}
                    reply={reply}
                    onDenied={refuseReply}
                    onOpen={task ? () => open(post, reply.messageId) : undefined}
                  />
                )}
              </li>
            )
          })}
          {pending && (
            <li className="item-thread-post" data-pending={pending.state}>
              <ThreadPostContent
                text={pending.text}
                target={
                  pending.target ? (
                    <TargetChip target={pending.target} name={targetLabel(pending.target, targets)} shell={shell} />
                  ) : undefined
                }
                now={now}
              />
              <div className="item-thread-post-state">
                {pending.state === 'sending' ? (
                  <StatusWord tone="running">发送中</StatusWord>
                ) : (
                  <Tooltip content={pending.reason ?? '没有收到电脑的答复'}>
                    <StatusWord tone="warn" tabIndex={0}>
                      未确认送达
                    </StatusWord>
                  </Tooltip>
                )}
              </div>
            </li>
          )}
        </ol>
      )}
      {failed && <StatusWord tone="failed">{failed}</StatusWord>}
      {canWrite && (
        <div ref={anchor} className="item-thread-input" data-state={pending?.state}>
          {target && (
            <span className="item-thread-input-target">
              <TargetChip target={postTarget(target)} name={target.label} shell={shell} />
              <IconButton size="xs" label="不发给它" icon={CloseGlyph} disabled={pending !== null} onClick={() => setTarget(null)} />
            </span>
          )}
          <textarea
            ref={field}
            className="item-thread-field"
            aria-label="发言"
            placeholder={target || pending ? '' : '@ 会话或 Agent'}
            rows={2}
            value={pending ? '' : draft}
            readOnly={pending !== null}
            role="combobox"
            aria-expanded={suggesting}
            aria-controls={`${id}-targets`}
            aria-autocomplete="list"
            aria-activedescendant={suggesting && matches.length ? optionId(chosenIndex) : undefined}
            onChange={event => {
              setDraft(event.target.value)
              setCaret(event.target.selectionStart)
              setRefused(null)
            }}
            onSelect={event => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={keydown}
          />
          <div className="item-thread-input-foot">
            {refused && (
              <StatusWord className="item-thread-refused" tone="failed">
                {refused}
              </StatusWord>
            )}
            {unknown ? (
              <>
                <Button size="sm" onClick={() => void send(pending)}>
                  重试
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                  放弃
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={SendGlyph}
                loading={pending?.state === 'sending'}
                disabled={!draft.trim() || pending !== null || over}
                onClick={submit}>
                发送
              </Button>
            )}
          </div>
          <Suggest
            id={`${id}-targets`}
            label="发给"
            open={suggesting}
            anchorRef={anchor}
            activeId={matches.length ? optionId(chosenIndex) : undefined}
            onActiveChange={option => setActive(Number(option.slice(`${id}-target-`.length)))}
            onChoose={option => {
              const choice = matches[Number(option.slice(`${id}-target-`.length))]
              if (choice) choose(choice)
            }}
            onDismiss={() => setDismissed(draft)}
            groups={[
              {
                id: 'targets',
                items: matches.map((choice, index) => ({
                  id: optionId(index),
                  media: <TargetMedia target={postTarget(choice)} shell={shell} />,
                  label: <VisibleText text={choice.label} />,
                  description: choice.kind === 'session' ? '会话' : 'Agent',
                  ...(choice.kind === 'agent' && !choice.ready ? { disabled: true, hint: '还没有聊天' } : {}),
                })),
              },
            ]}
            empty="没有匹配的会话或 Agent"
          />
        </div>
      )}
    </section>
  )
}

function ThreadPostContent({ text, target, at, now }: { text: string; target?: ReactNode; at?: string; now: Date }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const preview = useMemo(() => postPreview(text), [text])
  const separateHead = target || preview
  const time = at && (
    <time dateTime={at} title={dateTime(at)}>
      {relativeTime(at, now)}
    </time>
  )
  return (
    <>
      {separateHead && (
        <div className="item-thread-post-head">
          {target}
          {preview && (
            <Button
              className="item-thread-post-fold"
              size="xs"
              variant="ghost"
              aria-controls={id}
              aria-expanded={expanded}
              onClick={() => setExpanded(open => !open)}>
              {expanded ? '收起发言' : '展开全文'}
            </Button>
          )}
          {time}
        </div>
      )}
      <div className="item-thread-post-line">
        <div id={preview ? id : undefined} className="item-thread-post-text">
          <VisibleText text={expanded ? text : (preview ?? text)} />
        </div>
        {!separateHead && time}
      </div>
    </>
  )
}

function TargetMedia({ target, shell }: { target: WorkPostTarget; shell: ShellState }) {
  if ('customAgentId' in target) {
    const agent = shell.snapshot.customAgents?.find(entry => entry.id === target.customAgentId)
    return <AgentAvatar avatar={agent ? agent.avatar : 'general'} size={16} still />
  }
  const task = shell.snapshot.tasks.find(entry => entry.id === target.sessionId)
  const harness = shell.catalog?.harnesses.find(entry => entry.id === task?.harnessId)
  return task ? <MarkTile mark={harness?.capabilities.display.mark ?? task.harnessId} size={16} /> : <Icon icon={AtSign} size={14} />
}

/** @ and the name a post goes to: a session's Harness mark or the Agent's face. */
function TargetChip({ target, name, shell }: { target: WorkPostTarget; name: string; shell: ShellState }) {
  return (
    <span className="item-thread-target">
      <TargetMedia target={target} shell={shell} />
      <span>{`@${escapeSecurityText(name)}`}</span>
    </span>
  )
}

/** The thread of the 待办 the snapshot lists; nothing while it does not. */
export function ItemThreadFor({ shell, itemId }: { shell: ShellState; itemId: string }) {
  const item = shell.snapshot.items?.find(entry => entry.id === itemId)
  return item ? (
    <ItemThread key={`${item.id}:${shell.snapshot.device.dataScope}:${shell.snapshot.device.scopes}`} shell={shell} item={item} />
  ) : null
}

const longReply = (text: string) => text.length > 360 || text.split('\n').length > 7

/** Each continuation names the same post and assistant message. */
function ThreadReply({
  path,
  postId,
  reply,
  onDenied,
  onOpen,
}: {
  path: string
  postId: string
  reply: WorkPostReply
  onDenied: (postId: string, messageId: string) => void
  onOpen?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<{ text: string; nextOffset?: number }>()
  const [failed, setFailed] = useState<string>()
  const [loading, setLoading] = useState(false)
  const request = useRef<AbortController | null>(null)
  const read = useCallback(
    async (offset?: number) => {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      setLoading(true)
      setFailed(undefined)
      try {
        const query = new URLSearchParams({ messageId: reply.messageId, ...(offset ? { offset: String(offset) } : {}) })
        const answer = await api<WorkPostReplyAnswer>(`${path}?${query}`, { signal: controller.signal })
        if (controller.signal.aborted || answer.messageId !== reply.messageId) return
        setFull(previous => ({
          text: (offset ? (previous?.text ?? '') : '') + answer.text,
          ...(answer.nextOffset !== undefined ? { nextOffset: answer.nextOffset } : {}),
        }))
      } catch (cause) {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          controller.abort()
          onDenied(postId, reply.messageId)
          return
        }
        setFailed(errorMessage(cause))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    },
    [path, postId, reply.messageId, onDenied],
  )
  useLayoutEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!open || !reply.more) return
    void read()
    return () => request.current?.abort()
  }, [open, read, reply.more, reply.live])
  const text = open && full ? full.text : reply.more ? `${reply.text}…` : reply.text
  const long = !!reply.more || longReply(text)
  const content = <VisibleText text={text} />
  return (
    <div className="item-thread-reply-box">
      {onOpen ? (
        <button
          type="button"
          className="item-thread-reply"
          aria-label="查看原回复"
          data-live={reply.live ? '' : undefined}
          data-clipped={long && !open ? '' : undefined}
          onClick={onOpen}>
          {content}
        </button>
      ) : (
        <div className="item-thread-reply" data-clipped={long && !open ? '' : undefined}>
          {content}
        </div>
      )}
      <div className="item-thread-reply-actions">
        {long && (
          <Button size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '收起' : '展开回复'}
          </Button>
        )}
        {open && (full?.nextOffset !== undefined || failed) && (
          <Button size="xs" variant="ghost" loading={loading} onClick={() => void read(full?.nextOffset)}>
            {failed ? '重试读取' : '继续读取'}
          </Button>
        )}
        {open && loading && full?.nextOffset === undefined && <StatusWord tone="neutral">读取中</StatusWord>}
      </div>
      {open && failed && <StatusWord tone="failed">{failed}</StatusWord>}
    </div>
  )
}
