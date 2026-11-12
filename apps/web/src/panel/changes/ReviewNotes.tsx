import { useState } from 'react'

import { noteLinesLabel, type ReviewNote } from '@latch/protocol'
import { Button, Hint, IconButton, StatusWord, CheckGlyph, AlertGlyph, MessageGlyph, CloseGlyph } from '@latch/ui'
import { VisibleText } from '../../components/VisibleText.tsx'
import { NOTE_STATUS_LABEL } from './notes.ts'
import type { ReviewNoteActions } from './useReviewNotes.ts'

/** What a note's actions need; absent: this device only reads. */
export interface NoteWriting {
  actions: ReviewNoteActions
  busy: boolean
}

function StateWord({ note }: { note: ReviewNote }) {
  if (note.status === 'pending' && note.queueId)
    return (
      <StatusWord tone="neutral" className="review-note-state">
        已排队
      </StatusWord>
    )
  if (note.status === 'pending' && note.sending)
    return (
      <StatusWord tone="running" className="review-note-state">
        发送中
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
        <Hint lead={<></>} label="锚定这一版">
          反馈记住文件的这一版；文件再变时会标出位置可能过期。
        </Hint>
      </div>
      <textarea
        aria-label="反馈"
        autoFocus
        rows={2}
        placeholder="写给 Agent 的反馈…"
        value={text}
        onChange={event => {
          setText(event.target.value)
        }}
      />
      <div className="changes-comment-actions">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          取消
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
        submitLabel="保存"
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
            位置可能过期
          </span>
        )}
        <span className="review-note-space" />
        <StateWord note={note} />
        {writing && !note.sending && (
          <IconButton
            size="xs"
            icon={CloseGlyph}
            label="删除反馈"
            disabled={writing.busy}
            onClick={() => {
              void writing.actions.remove(note.id)
            }}
          />
        )}
      </div>
      {(stale || quote) && (
        <pre className="review-note-snippet" aria-label="原来的代码">
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
              编辑
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
              Agent 称已修
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
              标为已复核
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
          发送结果未知 · {notes.sending} 条反馈仍待发
        </span>
        <span className="review-notes-foot-space" />
        <Button size="xs" variant="ghost" disabled={writing.busy || offline} onClick={writing.abandon}>
          放弃这次发送
        </Button>
        <Button size="xs" variant="outline" disabled={writing.busy || offline} onClick={writing.retry}>
          重试同一请求
        </Button>
      </div>
    )
  if (notes.ready > 0)
    return (
      <div className="review-notes-foot" role="status">
        <span className="review-notes-count">
          <MessageGlyph size={14} aria-hidden="true" />
          待发反馈 {notes.ready} 条
        </span>
        <Hint lead={<></>} label="发送后 Agent 修订">
          反馈作为一条消息发给这个会话，电脑上记下每条的状态：已发送、Agent 称已修、你已复核。
        </Hint>
        <span className="review-notes-foot-space" />
        {writing && (
          <>
            <Button size="xs" variant="ghost" disabled={writing.busy} onClick={onClear}>
              清空
            </Button>
            <Button size="sm" variant="primary" disabled={writing.busy || offline || (running && !canQueue)} onClick={writing.send}>
              {running ? (canQueue ? '排到下一轮' : '本轮结束后发') : '发给 Agent'}
            </Button>
          </>
        )}
        {(offline || error) && (
          <span className="review-notes-foot-note" data-tone="amber">
            {offline ? `${hostName ?? 'Mac'} 不在线，反馈留在待发` : error}
          </span>
        )}
      </div>
    )
  if (notes.sending > 0 || (running && notes.sent > 0))
    return (
      <div className="review-notes-foot" role="status">
        <StatusWord tone="running">
          {notes.sending > 0 ? `正在发送 ${notes.sending} 条反馈` : `Agent 在修订 ${notes.sent} 条反馈`}
        </StatusWord>
      </div>
    )
  if (notes.queued > 0)
    return (
      <div className="review-notes-foot" role="status">
        <span className="review-notes-foot-text">{notes.queued} 条反馈已排队</span>
      </div>
    )
  if (notes.toReview > 0)
    return (
      <div className="review-notes-foot" role="status">
        <span className="review-notes-foot-text">{notes.toReview} 条待你复核</span>
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
