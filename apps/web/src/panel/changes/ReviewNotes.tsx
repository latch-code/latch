import { useState } from 'react'

import { noteLinesLabel, type ReviewNote } from '@latch/protocol'
import { Button, Hint, IconButton, StatusWord, CheckGlyph, AlertGlyph, MessageGlyph, CloseGlyph } from '@latch/ui'
import { VisibleText } from '../../components/VisibleText.tsx'
import { NOTE_STATUS_LABEL } from './notes.ts'
import type { ReviewNoteActions } from './useReviewNotes.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    unknown: (count: number) => `发送结果未知 · ${formatNumber(count)} 条反馈仍待发`,
    ready: (count: number) => `待发反馈 ${formatNumber(count)} 条`,
    queuedCount: (count: number) => `${formatNumber(count)} 条反馈已排队`,
    reviewCount: (count: number) => `${formatNumber(count)} 条待你复核`,
    queued: '已排队',
    sending: '发送中',
    anchored: '锚定这一版',
    anchoredInfo: '反馈记住文件的这一版；文件再变时会标出位置可能过期。',
    feedback: '反馈',
    hint: '写给 Agent 的反馈…',
    cancel: '取消',
    save: '保存',
    stale: '位置可能过期',
    delete: '删除反馈',
    original: '原来的代码',
    edit: '编辑',
    agentFixed: 'Agent 称已修',
    markReviewed: '标为已复核',
    abandon: '放弃这次发送',
    retry: '重试同一请求',
    revisions: '发送后 Agent 修订',
    revisionsInfo: '反馈作为一条消息发给这个会话，电脑上记下每条的状态：已发送、Agent 称已修、你已复核。',
    clear: '清空',
    nextTurn: '排到下一轮',
    afterTurn: '本轮结束后发',
    send: '发给 Agent',
    offline: (value1: string | number) => `${value1} 不在线，反馈留在待发`,
    sendingItems: (count: number) => `正在发送 ${formatNumber(count)} 条反馈`,
    fixing: (count: number) => `Agent 在修订 ${formatNumber(count)} 条反馈`,
  },
  {
    unknown: (count: number) =>
      plural(count, {
        one: 'Send outcome unknown · {n} feedback item awaiting send',
        other: 'Send outcome unknown · {n} feedback items awaiting send',
      }),
    ready: (count: number) => plural(count, { one: '{n} feedback item to send', other: '{n} feedback items to send' }),
    queuedCount: (count: number) => plural(count, { one: '{n} feedback item queued', other: '{n} feedback items queued' }),
    reviewCount: (count: number) => plural(count, { one: '{n} item needs review', other: '{n} items need review' }),
    queued: 'Queued',
    sending: 'Sending',
    anchored: 'Anchored to this version',
    anchoredInfo: 'Feedback stays attached to this file version. If it changes, the location is marked out of date.',
    feedback: 'Feedback',
    hint: 'Write feedback for the agent…',
    cancel: 'Cancel',
    save: 'Save',
    stale: 'Location may be out of date',
    delete: 'Delete feedback',
    original: 'Original code',
    edit: 'Edit',
    agentFixed: 'Agent reported fixed',
    markReviewed: 'Mark reviewed',
    abandon: 'Stop waiting for this send',
    retry: 'Retry same request',
    revisions: 'Agent revises after sending',
    revisionsInfo:
      'Feedback is sent to this session as a message. The computer tracks each item as sent, reported fixed by the agent, or reviewed by you.',
    clear: 'Clear',
    nextTurn: 'Queue for next turn',
    afterTurn: 'Send after this turn',
    send: 'Send to agent',
    offline: (value1: string | number) => `${value1} is offline. Feedback stays queued.`,
    sendingItems: (count: number) => `Sending ${plural(count, { one: '{n} feedback item', other: '{n} feedback items' })}`,
    fixing: (count: number) => `Agent is addressing ${plural(count, { one: '{n} feedback item', other: '{n} feedback items' })}`,
  },
)

/** What a note's actions need; absent: this device only reads. */
export interface NoteWriting {
  actions: ReviewNoteActions
  busy: boolean
}

function StateWord({ note }: { note: ReviewNote }) {
  if (note.status === 'pending' && note.queueId)
    return (
      <StatusWord tone="neutral" className="review-note-state">
        {COPY.queued}
      </StatusWord>
    )
  if (note.status === 'pending' && note.sending)
    return (
      <StatusWord tone="running" className="review-note-state">
        {COPY.sending}
      </StatusWord>
    )
  return (
    <StatusWord tone={note.status === 'sent' || note.status === 'reviewed' ? 'done' : 'neutral'} className="review-note-state">
      {NOTE_STATUS_LABEL[note.status]}
    </StatusWord>
  )
}

/** The text box of a note: a new one under the selected lines, or a pending one being reworded. */
export function NoteEditor({
  label,
  initial = '',
  submitLabel,
  busy,
  onCancel,
  onSubmit,
  onStep,
}: {
  label: string
  initial?: string
  submitLabel: string
  busy: boolean
  onCancel: () => void
  onSubmit: (text: string) => Promise<boolean>
  /** Shift ↑ / Shift ↓ while the box is still empty: the selection grows or shrinks by a line. */
  onStep?: (by: 1 | -1) => void
}) {
  const [text, setText] = useState(initial)
  const submit = async () => {
    if (text.trim() && (await onSubmit(text.trim()))) setText('')
  }
  return (
    <div
      className="changes-comment review-note"
      data-editing=""
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void submit()
        } else if (onStep && !text && event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          onStep(event.key === 'ArrowDown' ? 1 : -1)
        }
      }}>
      <div className="review-note-head">
        <span className="review-note-lines">{label}</span>
        <Hint lead={<></>} label={COPY.anchored}>
          {COPY.anchoredInfo}
        </Hint>
      </div>
      <textarea
        aria-label={COPY.feedback}
        autoFocus
        rows={2}
        placeholder={COPY.hint}
        value={text}
        onChange={event => {
          setText(event.target.value)
        }}
      />
      <div className="changes-comment-actions">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          {COPY.cancel}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!text.trim() || busy}
          onClick={() => {
            void submit()
          }}>
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

/** One kept note: where it is, its state, its words, and what the person can set next. */
export function NoteCard({
  note,
  at,
  stale,
  quote,
  where,
  writing,
}: {
  note: ReviewNote
  /** Where its lines are now, when they moved. */
  at?: { start: number; end: number }
  /** Its lines are no longer where they were: the original lines show with it. */
  stale?: boolean
  /** Shown apart from its lines: the original lines show with it. */
  quote?: boolean
  /** The file, for a note shown apart from its diff. */
  where?: string
  writing?: NoteWriting
}) {
  const [editing, setEditing] = useState(false)
  const label = noteLinesLabel(at ?? note.range)
  if (editing && writing)
    return (
      <NoteEditor
        label={label}
        initial={note.text}
        submitLabel={COPY.save}
        busy={writing.busy}
        onCancel={() => {
          setEditing(false)
        }}
        onSubmit={async text => {
          const done = await writing.actions.edit(note.id, text)
          if (done) setEditing(false)
          return done
        }}
      />
    )
  const canEdit = writing && note.status === 'pending' && !note.sending
  return (
    <div className="changes-comment review-note" data-note={note.id} data-status={note.status} data-stale={stale ? '' : undefined}>
      <div className="review-note-head">
        <span className="review-note-lines">
          {where && (
            <span className="review-note-file">
              <VisibleText text={where} />
            </span>
          )}
          {label}
        </span>
        {stale && (
          <span className="review-note-stale">
            <AlertGlyph size={12} aria-hidden="true" />
            {COPY.stale}
          </span>
        )}
        <span className="review-note-space" />
        <StateWord note={note} />
        {writing && !note.sending && (
          <IconButton
            size="xs"
            icon={CloseGlyph}
            label={COPY.delete}
            disabled={writing.busy}
            onClick={() => {
              void writing.actions.remove(note.id)
            }}
          />
        )}
      </div>
      {(stale || quote) && (
        <pre className="review-note-snippet" aria-label={COPY.original}>
          {note.anchor.lines.join('\n')}
        </pre>
      )}
      <p className="review-note-text">
        <VisibleText text={note.text} />
      </p>
      {writing && (canEdit || note.status === 'sent' || note.status === 'agent-claimed') && (
        <div className="changes-comment-actions">
          {canEdit && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setEditing(true)
              }}>
              {COPY.edit}
            </Button>
          )}
          {note.status === 'sent' && (
            <Button
              size="xs"
              variant="ghost"
              disabled={writing.busy}
              onClick={() => {
                void writing.actions.status(note.id, 'agent-claimed')
              }}>
              {COPY.agentFixed}
            </Button>
          )}
          {(note.status === 'sent' || note.status === 'agent-claimed') && (
            <Button
              size="xs"
              variant="outline"
              icon={CheckGlyph}
              disabled={writing.busy}
              onClick={() => {
                void writing.actions.status(note.id, 'reviewed')
              }}>
              {COPY.markReviewed}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The tab's foot for line feedback: the pending set and the one 「发给 Agent」, a send whose result is unknown with its
 * retry, the Agent at work on what was sent, or what is left to review.
 */
export function NotesFoot({
  notes,
  running,
  canQueue,
  offline,
  hostName,
  writing,
  unknown,
  error,
  onClear,
}: {
  notes: { ready: number; sending: number; sent: number; queued: number; toReview: number }
  running: boolean
  /** A running session takes the message into its queue for the next turn. */
  canQueue: boolean
  offline: boolean
  hostName?: string
  writing?: NoteWriting & { send: () => void; retry: () => void; abandon: () => void }
  unknown: boolean
  error?: string
  onClear: () => void
}) {
  if (unknown && writing)
    return (
      <div className="review-notes-foot" data-tone="amber" role="status">
        <span className="review-notes-foot-text">
          <AlertGlyph size={14} aria-hidden="true" />
          {COPY.unknown(notes.sending)}
        </span>
        <span className="review-notes-foot-space" />
        <Button size="xs" variant="ghost" disabled={writing.busy || offline} onClick={writing.abandon}>
          {COPY.abandon}
        </Button>
        <Button size="xs" variant="outline" disabled={writing.busy || offline} onClick={writing.retry}>
          {COPY.retry}
        </Button>
      </div>
    )
  if (notes.ready > 0)
    return (
      <div className="review-notes-foot" role="status">
        <span className="review-notes-count">
          <MessageGlyph size={14} aria-hidden="true" />
          {COPY.ready(notes.ready)}
        </span>
        <Hint lead={<></>} label={COPY.revisions}>
          {COPY.revisionsInfo}
        </Hint>
        <span className="review-notes-foot-space" />
        {writing && (
          <>
            <Button size="xs" variant="ghost" disabled={writing.busy} onClick={onClear}>
              {COPY.clear}
            </Button>
            <Button size="sm" variant="primary" disabled={writing.busy || offline || (running && !canQueue)} onClick={writing.send}>
              {running ? (canQueue ? COPY.nextTurn : COPY.afterTurn) : COPY.send}
            </Button>
          </>
        )}
        {(offline || error) && (
          <span className="review-notes-foot-note" data-tone="amber">
            {offline ? COPY.offline(hostName ?? 'Mac') : error}
          </span>
        )}
      </div>
    )
  if (notes.sending > 0 || (running && notes.sent > 0))
    return (
      <div className="review-notes-foot" role="status">
        <StatusWord tone="running">{notes.sending > 0 ? COPY.sendingItems(notes.sending) : COPY.fixing(notes.sent)}</StatusWord>
      </div>
    )
  if (notes.queued > 0)
    return (
      <div className="review-notes-foot" role="status">
        <span className="review-notes-foot-text">{COPY.queuedCount(notes.queued)}</span>
      </div>
    )
  if (notes.toReview > 0)
    return (
      <div className="review-notes-foot" role="status">
        <span className="review-notes-foot-text">{COPY.reviewCount(notes.toReview)}</span>
        {error && (
          <span className="review-notes-foot-note" data-tone="amber">
            {error}
          </span>
        )}
      </div>
    )
  if (error)
    return (
      <div className="review-notes-foot" role="status">
        <span className="review-notes-foot-note" data-tone="amber">
          {error}
        </span>
      </div>
    )
  return null
}
