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
  type WorkThreadAnswer,
} from '@latch/protocol'
import { Button, CloseGlyph, Icon, IconButton, LaptopGlyph, SendGlyph, StatusWord, Suggest, Tooltip } from '@latch/ui'
import { AtSign } from 'lucide-react'
import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { MarkTile } from '../components/BrandTile.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { MessageContent } from '../MessageContent.tsx'
import { api, ApiError, errorMessage, newRequestId } from '../core/api.ts'
import { unconfirmedReason } from '../core/sendingMessage.ts'
import { computerState, useComputers } from '../core/computers.ts'
import { describeFailure } from '../core/securityCopy.ts'
import { shellComputers } from '../core/shell.ts'
import { RemoteWorkPostStatus, useRemoteWorkRefresh } from './RemoteWorkPost.tsx'
import { hostNow } from '../core/hostClock.ts'
import { defineCopy, formatNumber, useLocale } from '../core/i18n.ts'
import { dateTime, relativeTime } from '../format.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import {
  currentTarget,
  deliveryWords,
  matchTargets,
  mentionAt,
  postDecision,
  postPreview,
  postSourceVersion,
  postTarget,
  replySources,
  sameWorkComputer,
  targetLabel,
  THREAD_COPY,
  threadTargets,
  withoutMention,
  withoutMissingPostSources,
  withoutPostSource,
  type PostDecision,
  type ThreadRecipient,
  type ThreadTarget,
} from './itemThread.ts'

const postsPath = (id: string) => `work/items/${encodeURIComponent(id)}/posts`
const COPY = defineCopy(
  {
    discussion: '讨论',
    retry: '重试',
    noAnswer: '没有收到电脑的答复',
    removeTarget: '不发给它',
    post: '发言',
    placeholder: '@ 会话或 Agent',
    abandon: '放弃',
    send: '发送',
    recipient: '发给',
    remoteScope: '只向工作电脑发送这条发言。',
    makePrivate: '发送后，此待办将永久设为私有。',
    bindingChanged: '工作电脑或 Agent 绑定已变更，请重新选择收件人。',
    session: '会话',
    noChat: '还没有聊天',
    noMatch: '没有匹配的会话或 Agent',
    collapse: '收起',
    expandReply: '展开回复',
    viewTurn: '查看原回合',
    collapsePost: '收起发言',
    fullPost: '展开全文',
    viewReply: '查看原回复',
    retryRead: '重试读取',
    readMore: '继续读取',
    loading: '读取中',
  },
  {
    discussion: 'Discussion',
    retry: 'Retry',
    noAnswer: 'The computer didn’t respond',
    removeTarget: 'Remove recipient',
    post: 'Post',
    placeholder: '@ a session or Agent',
    abandon: 'Abandon',
    send: 'Send',
    recipient: 'Send to',
    remoteScope: 'Only this post will be sent to the work computer.',
    makePrivate: 'Sending makes this work item permanently private.',
    bindingChanged: 'The work computer or assistant binding has changed. Select the recipient again.',
    session: 'Session',
    noChat: 'No chat yet',
    noMatch: 'No matching sessions or Agents',
    collapse: 'Show less',
    expandReply: 'Expand reply',
    viewTurn: 'View original turn',
    collapsePost: 'Collapse post',
    fullPost: 'Read full post',
    viewReply: 'View original reply',
    retryRead: 'Retry loading',
    readMore: 'Load more',
    loading: 'Loading',
  },
)

/** A post this device sent and the Host has not answered for certain: shown in its place, 重试 sends it as it was. */
interface Pending {
  requestId: string
  text: string
  target?: ThreadRecipient
  state: 'sending' | 'unknown'
  reason?: string
}

/** The same authorized read feeds the thread and its current decision at the top of the page. */
export function useItemThread(item: WorkItemSummary | undefined, snapshot: AppSnapshot, connected: boolean) {
  const itemId = item?.id
  const scope = JSON.stringify([snapshot.instanceId, snapshot.device.id, snapshot.device.dataScope, snapshot.device.scopes, itemId])
  const [state, setState] = useState<{ scope: string; answer: WorkThreadAnswer; versions: Map<string, string> } | null>(null)
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
  const request = useRef<AbortController | null>(null)
  const authorizedScope = useRef<string | null>(null)
  useLayoutEffect(() => {
    authorizedScope.current = scope
    return () => {
      authorizedScope.current = null
      request.current?.abort()
    }
  }, [scope])
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const read = useCallback(async () => {
    if (!itemId || authorizedScope.current !== scope) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const tasks = snapshotRef.current.tasks
    try {
      const answer = await api<WorkThreadAnswer>(postsPath(itemId), { signal: controller.signal })
      if (controller.signal.aborted) return
      const versions = new Map<string, string>()
      for (const post of answer.posts) {
        const sessionId = post.turn?.sessionId
        if (!post.attention?.decisionId || !sessionId) continue
        const source = tasks.find(task => task.id === sessionId)
        if (source) versions.set(post.id, postSourceVersion(source))
      }
      setState(previous =>
        previous?.scope === scope && previous.answer.revision > answer.revision ? previous : { scope, answer, versions },
      )
      setFailure(null)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) setState(null)
      if (cause instanceof ApiError && cause.status === 404) return
      setFailure({ scope, message: errorMessage(cause) })
    }
  }, [itemId, scope])
  const current = state?.scope === scope ? state : null
  const posts = current?.answer.posts ?? null
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
      setState(previous =>
        previous?.scope !== scope
          ? previous
          : {
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
    [read, scope],
  )
  const replies = replySources(posts, snapshot)
  useEffect(() => {
    if (!connected) {
      setState(previous => (previous?.scope === scope && previous.versions.size ? { ...previous, versions: new Map() } : previous))
      return
    }
    void read()
    return () => request.current?.abort()
  }, [read, item?.threadRevision, replies, connected, scope])
  const decisions = useMemo(() => {
    const result = new Map<string, PostDecision>()
    if (connected && current && visiblePosts)
      for (const post of visiblePosts) {
        const decision = postDecision(post, snapshot, current.versions.get(post.id))
        if (decision) result.set(post.id, decision)
      }
    return result
  }, [connected, current, visiblePosts, snapshot])
  return { scope, posts: visiblePosts, failed: failure?.scope === scope ? failure.message : null, read, refuseReply, decisions }
}

/**
 * A 待办's thread: the person's posts, oldest first, and the one input on the board. `@` names one of its sessions or
 * one of 我的 Agent; the post goes to that one only. Under a delivered post, 已交给 and the reply that turn gave, read from
 * the session (never copied); it opens where it is. Sending, an unknown result and a failure behave as the input's.
 */
export function ItemThread({
  shell,
  item,
  thread: { posts, failed, read, refuseReply, decisions },
}: {
  shell: ShellState
  item: WorkItemSummary
  thread: ReturnType<typeof useItemThread>
}) {
  const { snapshot } = shell
  const canWrite = shell.access.scopes.has('run')
  const locale = useLocale()
  const desktop = shellComputers()
  const bridge =
    shell.access.local
    && canWrite
    && shell.access.scopes.has('view')
    && snapshot.device.dataScope === 'all'
    && shell.catalog?.features?.remoteWorkPosts
    && desktop?.delegateWorkPost
      ? desktop
      : null
  const computers = useComputers(!!bridge)?.computers
  const targets = useMemo(() => threadTargets(snapshot, item, computers), [snapshot, item, computers, locale])
  useRemoteWorkRefresh(posts, item.id, computers, shell.connection === 'connected' ? bridge : null, read)
  const [draft, setDraft] = useState('')
  const [target, setTarget] = useState<ThreadRecipient | null>(null)
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

  const remoteTarget = target && 'workComputer' in target ? target : null
  const selected = target ? currentTarget(target, targets) : undefined
  const missingBinding = !!target && 'customAgentId' in target && !selected
  const computerStatus =
    selected?.kind === 'remote' && selected.computer.state !== 'online' ? computerState(selected.computer).text : undefined
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
    setTarget(postTarget(choice))
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
    if (request.target && 'workComputer' in request.target) {
      const target = request.target
      if (!bridge?.delegateWorkPost || !currentTarget(target, targets)) {
        setPending(request.state === 'unknown' ? request : null)
        setRefused(COPY.bindingChanged)
        return
      }
      let next: Pending | null = { ...request, state: 'unknown' }
      try {
        const result = await bridge.delegateWorkPost(item.id, {
          requestId: request.requestId,
          text: request.text,
          customAgentId: target.customAgentId,
          hostId: target.workComputer.hostId,
          agentId: target.workComputer.agentId,
        })
        if (!result.ok) {
          if (result.error === 'cancelled') next = request.state === 'unknown' ? request : null
          else if (['agent-mention-secret', 'agent-mention-reference', 'post-invalid'].includes(result.error)) {
            // The source rejected this text before reserving a post.
            next = null
            setRefused(describeFailure(0, result.error))
          } else {
            next.reason = describeFailure(0, result.error)
          }
        }
      } catch {
        next = { ...request, state: 'unknown', reason: COPY.noAnswer }
      }
      await read()
      // A source receipt may already have unlocked a newer draft while native confirmation or delivery was in flight.
      setPending(previous => (previous?.requestId === request.requestId ? next : previous))
      return
    }
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
    if (!canWrite || !text || pending || over || missingBinding) return
    void send({ requestId: newRequestId(), text, ...(target ? { target } : {}), state: 'sending' })
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

  const open = (post: WorkPost, messageId?: string, decision?: PostDecision) => {
    const turn = post.turn
    if (!turn) return
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
        if (choice && (choice.kind !== 'agent' || choice.ready)) choose(choice)
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
  const pendingReason = unknown && pending.target && 'workComputer' in pending.target ? pending.reason : undefined
  const over = draft.trim().length > WORK_THREAD_LIMITS.postChars

  return (
    <section className="item-thread" aria-label={COPY.discussion}>
      <header className="item-page-section-head">
        <h2>
          {COPY.discussion} <span className="item-page-count">{formatNumber(count)}</span>
        </h2>
      </header>
      {(count > 0 || pending) && (
        <ol className="item-thread-posts">
          {posts?.map(post => {
            if (post.remote) {
              const receipt = post.remote
              const recipient = { customAgentId: receipt.customAgentId, workComputer: { hostId: receipt.hostId, agentId: receipt.agentId } }
              const computer = computers?.find(row => !row.local && row.hostId === receipt.hostId)
              const computerName = computer?.name ?? receipt.hostId
              const agent = snapshot.customAgents?.find(
                row => row.id === receipt.customAgentId && sameWorkComputer(row.workComputer, receipt),
              )
              const name = `${agent?.name ?? receipt.agentId} · ${computerName}`
              return (
                <li key={post.id} className="item-thread-post" data-post-id={post.id} data-remote-status={receipt.status}>
                  <ThreadPostContent
                    text={post.text}
                    target={<TargetChip target={recipient} name={name} shell={shell} />}
                    at={post.at}
                    now={now}
                  />
                  <RemoteWorkPostStatus
                    remote={receipt}
                    itemId={item.id}
                    postId={post.id}
                    bridge={post.requestId && computer ? bridge : null}
                    bound={!!agent}
                    computer={computer}
                    read={read}
                  />
                </li>
              )
            }
            const name = label(post)
            const reply = post.reply
            const task = post.turn && snapshot.tasks.find(task => task.id === post.turn?.sessionId)
            const decision = decisions.get(post.id)
            const waiting = decision && THREAD_COPY.waiting[decision.kind]
            const state = waiting ? { tone: 'waiting' as const, words: waiting.status } : deliveryWords(post, escapeSecurityText(name))
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
                          {COPY.retry}
                        </Button>
                      )}
                    {task && (!reply || waiting) && (
                      <Button className="item-thread-action" size="xs" variant="ghost" onClick={() => open(post, undefined, decision)}>
                        {waiting?.action ?? COPY.viewTurn}
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
                  <StatusWord tone="running">{THREAD_COPY.sending}</StatusWord>
                ) : (
                  <Tooltip content={pending.reason ?? COPY.noAnswer}>
                    <StatusWord tone="warn" tabIndex={0}>
                      {THREAD_COPY.unknown}
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
              <TargetChip target={target} name={targetLabel(target, targets)} shell={shell} />
              <IconButton
                size="xs"
                label={COPY.removeTarget}
                icon={CloseGlyph}
                disabled={pending !== null}
                onClick={() => setTarget(null)}
              />
            </span>
          )}
          <textarea
            ref={field}
            className="item-thread-field"
            aria-label={COPY.post}
            placeholder={target || pending ? '' : COPY.placeholder}
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
          {(remoteTarget || missingBinding) && (
            <div className="item-thread-remote-scope">
              {missingBinding
                ? COPY.bindingChanged
                : [computerStatus, COPY.remoteScope, !item.private && COPY.makePrivate].filter(Boolean).join(' ')}
            </div>
          )}
          <div className="item-thread-input-foot">
            {(refused || pendingReason) && (
              <StatusWord className="item-thread-refused" tone={refused ? 'failed' : 'warn'}>
                {refused || pendingReason}
              </StatusWord>
            )}
            {unknown ? (
              <>
                <Button size="sm" disabled={missingBinding} onClick={() => void send(pending)}>
                  {COPY.retry}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                  {COPY.abandon}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={SendGlyph}
                loading={pending?.state === 'sending'}
                disabled={!draft.trim() || pending !== null || over || missingBinding}
                onClick={submit}>
                {COPY.send}
              </Button>
            )}
          </div>
          <Suggest
            id={`${id}-targets`}
            label={COPY.recipient}
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
                  description:
                    choice.kind === 'remote' ? (
                      <VisibleText text={`${choice.computer.name} · ${computerState(choice.computer).text}`} />
                    ) : choice.kind === 'session' ? (
                      COPY.session
                    ) : (
                      'Agent'
                    ),
                  ...(choice.kind === 'agent' && !choice.ready ? { disabled: true, hint: COPY.noChat } : {}),
                })),
              },
            ]}
            empty={COPY.noMatch}
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
              {expanded ? COPY.collapsePost : COPY.fullPost}
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

function TargetMedia({ target, shell }: { target: ThreadRecipient; shell: ShellState }) {
  if ('workComputer' in target) return <Icon icon={LaptopGlyph} size={16} />
  if ('customAgentId' in target) {
    const agent = shell.snapshot.customAgents?.find(entry => entry.id === target.customAgentId)
    return <AgentAvatar avatar={agent ? agent.avatar : 'general'} size={16} still />
  }
  const task = shell.snapshot.tasks.find(entry => entry.id === target.sessionId)
  const harness = shell.catalog?.harnesses.find(entry => entry.id === task?.harnessId)
  return task ? <MarkTile mark={harness?.capabilities.display.mark ?? task.harnessId} size={16} /> : <Icon icon={AtSign} size={14} />
}

/** @ and the name a post goes to: a session's Harness mark or the Agent's face. */
function TargetChip({ target, name, shell }: { target: ThreadRecipient; name: string; shell: ShellState }) {
  return (
    <span className="item-thread-target">
      <TargetMedia target={target} shell={shell} />
      <span>{`@${escapeSecurityText(name)}`}</span>
    </span>
  )
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
  return (
    <div className="item-thread-reply-box">
      {/* Read as Markdown, like the reply in its conversation. Its links and file chips are its own controls, so the
          box opens the reply only on a press elsewhere; 查看原回复 below is the way in for keyboard and readers. */}
      <div
        className="item-thread-reply"
        data-live={reply.live ? '' : undefined}
        data-clipped={long && !open ? '' : undefined}
        data-opens={onOpen ? '' : undefined}
        onClick={event => {
          if (onOpen && !(event.target as Element).closest('a, button, summary, [role="button"]')) onOpen()
        }}>
        <MessageContent text={text} streaming={reply.live === true} />
      </div>
      <div className="item-thread-reply-actions">
        {onOpen && (
          <Button size="xs" variant="ghost" onClick={onOpen}>
            {COPY.viewReply}
          </Button>
        )}
        {long && (
          <Button size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? COPY.collapse : COPY.expandReply}
          </Button>
        )}
        {open && (full?.nextOffset !== undefined || failed) && (
          <Button size="xs" variant="ghost" loading={loading} onClick={() => void read(full?.nextOffset)}>
            {failed ? COPY.retryRead : COPY.readMore}
          </Button>
        )}
        {open && loading && full?.nextOffset === undefined && <StatusWord tone="neutral">{COPY.loading}</StatusWord>}
      </div>
      {open && failed && <StatusWord tone="failed">{failed}</StatusWord>}
    </div>
  )
}
