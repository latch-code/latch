import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  escapeSecurityText,
  WORK_THREAD_LIMITS,
  type WorkItemSummary,
  type WorkPost,
  type WorkPostAnswer,
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
import { switchWorkView } from '../preferences.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import {
  deliveryWords,
  matchTargets,
  mentionAt,
  postTarget,
  replySources,
  targetLabel,
  threadTargets,
  withoutMention,
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
function useThread(item: WorkItemSummary, sources: (posts: WorkPost[] | null) => string) {
  const [posts, setPosts] = useState<WorkPost[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const read = useCallback(async () => {
    try {
      const answer = await api<WorkThreadAnswer>(postsPath(item.id))
      setPosts(answer.posts)
      setFailed(null)
    } catch (cause) {
      // A 待办 no longer readable here closes its page; nothing to say.
      if (cause instanceof ApiError && cause.status === 404) return
      setFailed(errorMessage(cause))
    }
  }, [item.id])
  const replies = sources(posts)
  useEffect(() => {
    void read()
  }, [read, item.threadRevision, replies])
  return { posts, failed, read }
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
  const { posts, failed, read } = useThread(item, list => replySources(list, snapshot))
  const [draft, setDraft] = useState('')
  const [target, setTarget] = useState<ThreadTarget | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const field = useRef<HTMLTextAreaElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
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
    if (seen.current !== null && count > seen.current && body) body.scrollTop = body.scrollHeight
    seen.current = count
  }, [count, loaded])

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
    if (!post.requestId) return
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

  const open = (post: WorkPost) => {
    const sessionId = post.delivery?.sessionId
    if (!sessionId) return
    if (post.target && 'customAgentId' in post.target) {
      switchWorkView('chat')
      shell.openMyAgent({ id: post.target.customAgentId })
      return
    }
    shell.choose(sessionId)
    switchWorkView('chat')
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
            return (
              <li key={post.id} className="item-thread-post" data-post-id={post.id} data-delivery={post.delivery?.state}>
                {post.target ? (
                  <div className="item-thread-post-head">
                    <TargetChip target={post.target} name={name} shell={shell} />
                    <time dateTime={post.at} title={dateTime(post.at)}>
                      {relativeTime(post.at, now)}
                    </time>
                  </div>
                ) : null}
                <div className="item-thread-post-line">
                  <div className="item-thread-post-text">
                    <VisibleText text={post.text} />
                  </div>
                  {!post.target && (
                    <time dateTime={post.at} title={dateTime(post.at)}>
                      {relativeTime(post.at, now)}
                    </time>
                  )}
                </div>
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
                    {(post.delivery?.state === 'unknown' || post.delivery?.state === 'failed') && post.requestId && canWrite && (
                      <Button size="xs" variant="ghost" onClick={() => void resend(post)}>
                        重试
                      </Button>
                    )}
                  </div>
                )}
                {reply && (
                  <ThreadReply
                    text={reply.more ? `${reply.text}…` : reply.text}
                    live={reply.live === true}
                    onOpen={() => {
                      open(post)
                    }}
                  />
                )}
              </li>
            )
          })}
          {pending && (
            <li className="item-thread-post" data-pending={pending.state}>
              {pending.target && (
                <div className="item-thread-post-head">
                  <TargetChip target={pending.target} name={targetLabel(pending.target, targets)} shell={shell} />
                </div>
              )}
              <div className="item-thread-post-text">
                <VisibleText text={pending.text} />
              </div>
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
  return item ? <ItemThread key={item.id} shell={shell} item={item} /> : null
}

/** A long reply shows its first lines; 展开 shows the rest of what the Host gave (up to 2,000 characters). */
const longReply = (text: string) => text.length > 360 || text.split('\n').length > 7

function ThreadReply({ text, live, onOpen }: { text: string; live: boolean; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  const long = longReply(text)
  return (
    <div className="item-thread-reply-box">
      <button
        type="button"
        className="item-thread-reply"
        data-live={live ? '' : undefined}
        data-clipped={long && !open ? '' : undefined}
        onClick={onOpen}>
        <VisibleText text={text} />
      </button>
      {long && (
        <Button className="item-thread-reply-more" size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </Button>
      )}
    </div>
  )
}
