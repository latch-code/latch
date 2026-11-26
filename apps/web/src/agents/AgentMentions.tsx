import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  containsSecret,
  GENERAL_AGENT_ID,
  type AgentAvatar as PersonalAvatar,
  type AgentMention,
  type AgentMentionCreate,
  type AppSnapshot,
} from '@latch/protocol'
import { Button, Icon, ChevronRightGlyph, MessageGlyph, InlineNotice, StatusWord } from '@latch/ui'
import { api, ApiError, errorMessage, isUncertain, newRequestId } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { MessageContent } from '../MessageContent.tsx'
import { storageDeviceCurrent } from '../core/deviceStorageScope.ts'
import { readStorage } from '../core/storageKeys.ts'
import { replyPreview } from './activity.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import { ownerName, personalChat, topicOwner } from './chat.ts'
import { readsAgents } from './model.ts'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'

export const MENTION_COPY = defineCopy(
  {
    group: '我的 Agent',
    contact: '联系其他 Agent',
    placeholder: '发消息，或用 @ 联系其他 Agent…',
    send: (name: string) => `发给${name}`,
    remove: '移除收件人',
    textOnly: '只发送这条消息的文字。请先移除文件和附件。',
    unavailable: '这个 Agent 现在无法接收消息',
    busy: '正在处理另一轮',
    history: 'Agent 协作',
    byPerson: (name: string) => `你联系了${name}`,
    expand: '展开回复',
    collapse: '收起回复',
    from: (source: string, target: string) => `${source}联系了${target}`,
    open: '打开对方聊天',
    approval: '查看待审批操作',
    modes: { 'text-only': '仅回复文字', 'own-permissions': '按自身权限接单' },
    full: '查看完整回复',
    retry: '重试同一请求',
    abandon: '放弃等待',
    unknown: '尚未确认送达',
    notRetained: '这条消息含有敏感文字，刷新后只能查看送达记录或放弃等待。',
    storageFailed: '浏览器无法保留这条请求，请恢复标签页存储后再发送。',
    failedRead: '无法读取协作记录',
    reload: '重试读取',
    empty: '没有匹配的 Agent',
    write: '写下要发给对方的消息',
    state: {
      sending: '正在发送',
      running: '处理中',
      'waiting-approval': '等待批准',
      completed: '已完成',
      failed: '发送或执行失败',
      cancelled: '已取消',
      interrupted: '已中断',
      unknown: '结果未知',
    },
  },
  {
    group: 'My Agents',
    contact: 'Contact another Agent',
    placeholder: 'Message, or type @ to contact another Agent…',
    send: (name: string) => `Send to ${name}`,
    remove: 'Remove recipient',
    textOnly: 'Only this message’s text is sent. Remove files and attachments first.',
    unavailable: 'This Agent cannot receive messages now',
    busy: 'Already working',
    history: 'Agent collaboration',
    byPerson: (name: string) => `You asked ${name}`,
    expand: 'Expand reply',
    collapse: 'Collapse reply',
    from: (source: string, target: string) => `${source} asked ${target}`,
    open: 'Open recipient chat',
    approval: 'Review pending approval',
    modes: { 'text-only': 'Text-only reply', 'own-permissions': 'Uses own permissions' },
    full: 'View full reply',
    retry: 'Retry the same request',
    abandon: 'Stop waiting',
    unknown: 'Delivery unconfirmed',
    notRetained: 'This message contained sensitive text. After a reload, check its delivery record or stop waiting.',
    storageFailed: 'This tab could not retain the request. Restore tab storage before sending.',
    failedRead: 'Couldn’t read collaboration history',
    reload: 'Retry loading',
    empty: 'No matching Agents',
    write: 'Write a message for this Agent',
    state: {
      sending: 'Sending',
      running: 'Working',
      'waiting-approval': 'Awaiting approval',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted',
      unknown: 'Outcome unknown',
    },
  },
)

type Request = { source: string; body: AgentMentionCreate }
type Attempt = { request: Request; state: 'sending' | 'unknown' | 'failed'; reason?: string }

const path = (source: string) => `custom-agents/${encodeURIComponent(source)}/mentions`
const unsettled = (item: AgentMention) => ['sending', 'running', 'waiting-approval', 'unknown'].includes(item.status)

type MentionScope = {
  recipients: Map<string, string>
  attempts: Map<string, Attempt>
  delivered: Map<string, Request>
  expanded: Set<string>
}

const storageKey = (device: string) => `latch.agent-mentions.${location.origin}.${device}`

function restoreRequests(device: string, allowed: boolean): MentionScope {
  const scope: MentionScope = { recipients: new Map(), attempts: new Map(), delivered: new Map(), expanded: new Set() }
  if (!allowed) return scope
  try {
    if (!storageDeviceCurrent(location.origin, device)) return scope
    const raw = readStorage('sessionStorage', storageKey(device))
    if (!raw || containsSecret(raw)) return scope
    for (const row of JSON.parse(raw) as Request[]) {
      const body = row?.body
      if (
        typeof row?.source !== 'string'
        || !body
        || typeof body.requestId !== 'string'
        || typeof body.text !== 'string'
        || body.target?.kind !== 'agent'
        || typeof body.target.customAgentId !== 'string'
      )
        continue
      scope.attempts.set(row.source, {
        request: row,
        state: 'unknown',
        reason: body.text ? MENTION_COPY.unknown : MENTION_COPY.notRetained,
      })
      scope.recipients.set(row.source, body.target.customAgentId)
    }
  } catch {
    /* Unreadable tab storage cannot restore a request. */
  }
  return scope
}

function saveRequests(device: string, scope: MentionScope) {
  if (!storageDeviceCurrent(location.origin, device)) throw new Error()
  const rows = [...scope.attempts.values()]
    .filter(a => a.state !== 'failed')
    .map(({ request }) => (containsSecret(request.body.text) ? { ...request, body: { ...request.body, text: '' } } : request))
  if (rows.length) sessionStorage.setItem(storageKey(device), JSON.stringify(rows))
  else sessionStorage.removeItem(storageKey(device))
}

export function useAgentMentions(snapshot: AppSnapshot, candidate: string | undefined, online: boolean, canRun: boolean) {
  const allowed =
    snapshot.catalog?.features?.agentMentions === true && readsAgents(snapshot) && snapshot.device.scopes?.includes('view') === true
  const source =
    allowed && (candidate === GENERAL_AGENT_ID || snapshot.customAgents?.some(a => a.id === candidate && !a.workComputer))
      ? candidate
      : undefined
  const device = snapshot.device.id
  // Navigation keeps recipients and unanswered writes. A new device or a loss of private access drops both.
  const scope = useMemo(() => restoreRequests(device, allowed && canRun), [device, allowed, canRun])
  useEffect(() => {
    if (!allowed || !canRun) {
      try {
        sessionStorage.removeItem(storageKey(device))
      } catch {
        /* No readable storage. */
      }
    }
  }, [device, allowed, canRun])
  const liveScope = useRef<MentionScope | undefined>(scope)
  useLayoutEffect(() => {
    liveScope.current = scope
    return () => {
      liveScope.current = undefined
    }
  }, [scope])
  const [, update] = useState(0)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision(n => n + 1), [])
  const [read, setRead] = useState<{ scope: typeof scope; source: string; rows: AgentMention[]; error?: string }>()
  const rows = source && read?.scope === scope && read.source === source ? read.rows : []
  const readError = source && read?.scope === scope && read.source === source ? read.error : undefined
  const active = rows.some(unsettled)
  // SSE only wakes a receipt read. A later turn on the same recipient must never settle this exchange.
  const pendingTargets = new Set(rows.filter(unsettled).map(row => row.targetSessionId))
  const targetStates = pendingTargets.size
    ? JSON.stringify(
        snapshot.tasks
          .filter(task => pendingTargets.has(task.id))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(task => [task.id, task.runId, task.status, task.runOutcome]),
      )
    : ''
  const atWork =
    source && snapshot.tasks.some(task => topicOwner(task) === source && (task.status === 'running' || task.status === 'waiting-approval'))
  useEffect(() => {
    if (!source || !online) return undefined
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const { mentions } = await api<{ mentions: AgentMention[] }>(path(source), { signal: controller.signal })
        if (controller.signal.aborted) return
        const held = scope.attempts.get(source)
        const confirmed =
          held?.state === 'unknown'
          && mentions.find(
            row =>
              row.requestId === held.request.body.requestId
              && row.sourceAgentId === source
              && row.targetAgentId === held.request.body.target.customAgentId
              && row.initiator === 'person',
          )
        if (held && confirmed && liveScope.current === scope && (confirmed.targetSessionId || confirmed.status === 'failed')) {
          if (confirmed.targetSessionId) {
            scope.delivered.set(source, held.request)
            scope.recipients.delete(source)
            scope.attempts.delete(source)
          } else {
            scope.attempts.set(source, { request: held.request, state: 'failed', reason: confirmed.failure ?? MENTION_COPY.state.failed })
          }
          try {
            saveRequests(device, scope)
          } catch {
            /* A later read can settle the same receipt again. */
          }
        }
        setRead({ scope, source, rows: mentions })
      } catch (cause) {
        if (controller.signal.aborted) return
        const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status)
        setRead(previous => ({
          scope,
          source,
          rows: !denied && previous?.source === source && previous.scope === scope ? previous.rows : [],
          error: errorMessage(cause),
        }))
      }
      timer = setTimeout(() => void load(), active || atWork ? 2000 : 15000)
    }
    void load()
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [scope, source, online, active, atWork, targetStates, revision, device])

  const agents = snapshot.customAgents ?? []
  const targets =
    source && canRun
      ? [
          ...agents
            .filter(agent => agent.id !== source && !agent.workComputer)
            .map(agent => ({
              id: agent.id,
              name: agent.name,
              description: agent.description,
              avatar: agent.avatar,
              disabled: agent.available ? undefined : (agent.unavailableReason ?? MENTION_COPY.unavailable),
            })),
          ...(source === GENERAL_AGENT_ID
            ? []
            : [
                {
                  id: GENERAL_AGENT_ID,
                  name: AGENT_SPACE_COPY.general,
                  description: AGENT_SPACE_COPY.generalDuty,
                  avatar: 'general' as const,
                  disabled: undefined,
                },
              ]),
        ].map(target => {
          const chat = personalChat(snapshot, target.id)
          const session = chat?.state === 'ready' ? snapshot.tasks.find(item => item.id === chat.sessionId) : undefined
          const busy = chat?.state === 'starting' || session?.status === 'running' || session?.status === 'waiting-approval'
          return { ...target, disabled: busy ? MENTION_COPY.busy : target.disabled }
        })
      : []
  const targetId = source ? scope.recipients.get(source) : undefined
  const target = targets.find(t => t.id === targetId)
  const attempt = source ? scope.attempts.get(source) : undefined
  const select = (id?: string) => {
    if (!source || attempt?.state === 'sending' || attempt?.state === 'unknown') return
    if (id) scope.recipients.set(source, id)
    else scope.recipients.delete(source)
    scope.attempts.delete(source)
    update(n => n + 1)
  }
  const dispatch = async (request: Request, retry: boolean) => {
    if (
      !online
      || !canRun
      || !source
      || request.source !== source
      || liveScope.current !== scope
      || scope.attempts.get(source)?.state === 'sending'
    )
      return false
    scope.attempts.set(source, { request, state: 'sending' })
    update(n => n + 1)
    try {
      saveRequests(device, scope)
    } catch {
      scope.attempts.set(source, { request, state: retry ? 'unknown' : 'failed', reason: MENTION_COPY.storageFailed })
      return false
    }
    try {
      const received = await api<AgentMention>(path(source), { method: 'POST', body: request.body })
      if (liveScope.current !== scope) return false
      if (
        (received.status === 'unknown' && !received.targetSessionId)
        || received.requestId !== request.body.requestId
        || received.targetAgentId !== request.body.target.customAgentId
        || received.sourceAgentId !== source
      ) {
        scope.attempts.set(source, { request, state: 'unknown', reason: received.failure ?? MENTION_COPY.unknown })
        return false
      }
      if (received.status === 'failed' && !received.targetSessionId) {
        scope.attempts.set(source, { request, state: 'failed', reason: received.failure ?? MENTION_COPY.state.failed })
        return false
      }
      scope.recipients.delete(source)
      scope.attempts.delete(source)
      return true
    } catch (cause) {
      if (liveScope.current === scope)
        scope.attempts.set(source, { request, state: retry || isUncertain(cause) ? 'unknown' : 'failed', reason: errorMessage(cause) })
      return false
    } finally {
      if (liveScope.current === scope) {
        try {
          saveRequests(device, scope)
        } catch {
          /* The original request still has the same receipt. */
        }
        update(n => n + 1)
        reload()
      }
    }
  }
  const send = async (text: string) => {
    if (!source || !target || target.disabled || !text.trim() || attempt?.state === 'unknown') return false
    return dispatch(
      { source, body: { requestId: newRequestId(), target: { kind: 'agent', customAgentId: target.id }, text: text.trim() } },
      false,
    )
  }
  const retry = (item?: AgentMention) => {
    const request =
      item && source
        ? {
            source,
            body: { requestId: item.requestId, text: item.text, target: { kind: 'agent' as const, customAgentId: item.targetAgentId } },
          }
        : attempt?.request
    return request ? dispatch(request, true) : Promise.resolve(false)
  }
  const abandon = () => {
    if (source && scope.attempts.get(source)?.state === 'unknown') {
      scope.attempts.delete(source)
      try {
        saveRequests(device, scope)
      } catch {
        /* The Host still owns the receipt. */
      }
      update(n => n + 1)
    }
  }
  const toggleReply = (id: string) => {
    if (!scope.expanded.delete(id)) scope.expanded.add(id)
    update(n => n + 1)
  }
  const takeDelivered = () => {
    if (!source) return
    const request = scope.delivered.get(source)
    scope.delivered.delete(source)
    return request
  }
  return {
    source,
    rows,
    loaded: source !== undefined && read?.scope === scope && read.source === source && !read.error,
    readError,
    reload,
    targets,
    targetId,
    target,
    select,
    attempt,
    send,
    retry,
    abandon,
    online,
    canRun,
    takeDelivered,
    expanded: scope.expanded,
    toggleReply,
  }
}
export type AgentMentions = ReturnType<typeof useAgentMentions>

function MentionReply({
  item,
  name,
  avatar,
  expanded,
  toggle,
}: {
  item: NonNullable<AgentMention['reply']>
  name: string
  avatar: PersonalAvatar | 'general'
  expanded: boolean
  toggle: () => void
}) {
  const preview = replyPreview({ reply: item.text })
  return (
    <div className="agent-mention-reply">
      <AgentAvatar avatar={avatar} size={28} still />
      <div className="agent-mention-reply-body">
        <strong className="agent-mention-author">
          <VisibleText text={name} />
        </strong>
        <div className="message-text">
          <MessageContent text={expanded ? item.text : preview.short} />
        </div>
        {preview.more && (
          <Button size="xs" variant="ghost" aria-expanded={expanded} onClick={toggle}>
            {expanded ? MENTION_COPY.collapse : MENTION_COPY.expand}
          </Button>
        )}
      </div>
    </div>
  )
}

export function AgentMentionHistory({
  mentions,
  snapshot,
  open,
  items = mentions.rows,
  reportError = true,
}: {
  mentions: AgentMentions
  snapshot: AppSnapshot
  open: (item: AgentMention) => void
  items?: AgentMention[]
  reportError?: boolean
}) {
  if (!mentions.source || (!items.length && !(reportError && mentions.readError))) return null
  return (
    <section className="agent-mention-history" aria-label={MENTION_COPY.history}>
      {items.map(item => {
        const agents = snapshot.customAgents
        const target = agents?.find(agent => agent.id === item.targetAgentId)
        const name = ownerName(agents, item.targetAgentId)
        const source = agents?.find(agent => agent.id === item.sourceAgentId)
        const route =
          item.initiator === 'agent' ? MENTION_COPY.from(ownerName(agents, item.sourceAgentId), name) : MENTION_COPY.byPerson(name)
        const session = snapshot.tasks.find(task => task.id === item.targetSessionId)
        const targetAvailable = !!session && topicOwner(session) === item.targetAgentId
        const approval =
          item.approval
          && session?.runId === item.approval.runId
          && snapshot.approvals.some(row => row.id === item.approval!.id && row.sessionId === item.targetSessionId)
        const mode = item.initiator === 'agent' && item.consultationMode ? MENTION_COPY.modes[item.consultationMode] : undefined
        const canRetry =
          item.canRetry
          && item.status === 'unknown'
          && mentions.canRun
          && (!mentions.attempt || (!mentions.attempt.request.body.text && mentions.attempt.request.body.requestId === item.requestId))
        const tone =
          item.status === 'completed'
            ? 'done'
            : item.status === 'failed'
              ? 'failed'
              : item.status === 'unknown' || item.status === 'waiting-approval'
                ? 'warn'
                : item.status === 'running' || item.status === 'sending'
                  ? 'running'
                  : 'neutral'
        return (
          <article
            className="agent-mention-record"
            key={item.id}
            aria-label={route}
            data-agent-mention-id={item.id}
            data-message-id={`agent-mention:${item.id}`}>
            <div className="agent-mention-request">
              <div className="agent-mention-request-icon" aria-hidden="true">
                {item.initiator === 'agent' ? (
                  <AgentAvatar avatar={source?.avatar ?? 'general'} size={24} still />
                ) : (
                  <Icon icon={MessageGlyph} size={16} />
                )}
              </div>
              <div className="agent-mention-request-body">
                <header>
                  <strong>
                    <VisibleText text={route} />
                  </strong>
                  <StatusWord tone={tone}>{MENTION_COPY.state[item.status]}</StatusWord>
                </header>
                <p className="agent-mention-question">
                  <VisibleText text={item.text} />
                </p>
              </div>
            </div>
            {item.reply && (
              <MentionReply
                item={item.reply}
                name={name}
                avatar={target?.avatar ?? 'general'}
                expanded={mentions.expanded.has(item.id)}
                toggle={() => mentions.toggleReply(item.id)}
              />
            )}
            {item.failure && (
              <p className="agent-mention-failure">
                <VisibleText text={item.failure} />
              </p>
            )}
            {(targetAvailable || canRetry || mode) && (
              <footer className="agent-mention-actions">
                {mode && <span className="agent-mention-mode">{mode}</span>}
                {canRetry && (
                  <Button size="xs" disabled={!mentions.online} onClick={() => void mentions.retry(item)}>
                    {MENTION_COPY.retry}
                  </Button>
                )}
                {targetAvailable && (
                  <Button size="xs" variant="ghost" data-open-agent-mention="" onClick={() => open(item)}>
                    {approval ? MENTION_COPY.approval : item.reply?.more ? MENTION_COPY.full : MENTION_COPY.open}
                    <Icon icon={ChevronRightGlyph} size={12} />
                  </Button>
                )}
              </footer>
            )}
          </article>
        )
      })}
      {reportError && mentions.readError && (
        <InlineNotice
          tone="warn"
          title={MENTION_COPY.failedRead}
          action={
            <Button size="xs" onClick={mentions.reload}>
              {MENTION_COPY.reload}
            </Button>
          }>
          {mentions.readError}
        </InlineNotice>
      )}
    </section>
  )
}
