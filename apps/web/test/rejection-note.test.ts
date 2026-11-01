import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Approval } from '@latch/protocol'
import { ApprovalStatuses } from '../src/components/ApprovalCard.tsx'
import { Composer } from '../src/components/Composer.tsx'
import { ToolCard } from '../src/components/ToolCard.tsx'
import { DECISION_COPY } from '../src/core/securityCopy.ts'
import { afterReject, stillApplies, type NoteContext, type RejectionNote } from '../src/hooks/useRejectionNote.ts'

const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: 'ap1',
  sessionId: 's1',
  toolName: 'write_file',
  reason: '写入需要确认',
  requestedAt: '2026-10-25T06:24:00.000Z',
  ...extra,
})
const context = (extra: Partial<NoteContext> = {}): NoteContext => ({
  selectedId: 's1',
  open: [approval()],
  active: true,
  mayType: true,
  hostTakesNote: true,
  ...extra,
})

describe('telling the agent what to do instead after 拒绝', () => {
  it('holds a Latch 内置 rejection for a note, then sends it with what was written, or without a note', () => {
    const first = afterReject(null, approval(), 'reject_once', context())
    expect(first).toEqual({ next: { kind: 'note', approval: approval(), optionId: 'reject_once', text: '' } })
    const written: RejectionNote = { ...(first.next as Extract<RejectionNote, { kind: 'note' }>), text: '  改写到 docs/ 下  ' }
    expect(afterReject(written, approval(), undefined, context())).toEqual({
      next: null,
      send: { optionId: 'reject_once', note: '改写到 docs/ 下' },
    })
    // Nothing written: the rejection goes without a note.
    expect(afterReject(first.next, approval(), undefined, context())).toEqual({ next: null, send: { optionId: 'reject_once' } })
  })

  it('sends nothing while the note cannot go, and says why', () => {
    const hidden: RejectionNote = { kind: 'note', approval: approval(), optionId: undefined, text: '改用‮docs' }
    expect(afterReject(hidden, approval(), undefined, context())).toEqual({
      next: { ...hidden, problem: DECISION_COPY.noteInvalid },
      send: 'problem',
    })
  })

  it('rejects at once where a note cannot go: an agent’s ask, an older Host, or a device that may not type', () => {
    // An agent's ask: sent now, and the composer says the text waits for the turn to end.
    expect(afterReject(null, approval({ advisory: true }), 'reject', context())).toEqual({
      next: { kind: 'after', sessionId: 's1' },
      send: { optionId: 'reject' },
    })
    expect(afterReject(null, approval(), undefined, context({ hostTakesNote: false }))).toEqual({
      next: null,
      send: { optionId: undefined },
    })
    expect(afterReject(null, approval(), undefined, context({ mayType: false }))).toEqual({ next: null, send: { optionId: undefined } })
    expect(afterReject(null, approval({ advisory: true }), undefined, context({ mayType: false }))).toEqual({
      next: null,
      send: { optionId: undefined },
    })
    // An approval of a session that is not open.
    expect(afterReject(null, approval({ sessionId: 's2' }), undefined, context())).toEqual({ next: null, send: { optionId: undefined } })
  })

  it('lets the note go once its approval is settled elsewhere, and the agent hint once the turn ends', () => {
    const noting: RejectionNote = { kind: 'note', approval: approval(), optionId: undefined, text: 'x' }
    expect(stillApplies(noting, context())).toBe(true)
    expect(stillApplies(noting, context({ open: [] }))).toBe(false)
    expect(stillApplies(noting, context({ selectedId: 's2' }))).toBe(false)
    const after: RejectionNote = { kind: 'after', sessionId: 's1' }
    expect(stillApplies(after, context())).toBe(true)
    expect(stillApplies(after, context({ active: false }))).toBe(false)
  })

  it('turns the composer into the answer: 返回 and 拒绝 in place of stop, sendable while the run waits and with no text', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        textareaRef: createRef<HTMLTextAreaElement>(),
        variant: 'session',
        label: DECISION_COPY.noteLabel,
        placeholder: DECISION_COPY.notePlaceholder,
        draft: '',
        onDraft: () => {},
        pending: null,
        sending: false,
        error: '',
        onRetry: () => {},
        canSend: true,
        onSubmit: () => {},
        sendKey: 'enter',
        coarse: false,
        controls: null,
        run: { cancel: 'idle', onCancel: () => {} },
        hint: DECISION_COPY.noteHint,
        answer: { label: DECISION_COPY.noteSubmit, onSubmit: () => {}, onCancel: () => {} },
      }),
    )
    expect(html).toContain(`placeholder="${DECISION_COPY.notePlaceholder}"`)
    expect(html).toContain(`aria-label="${DECISION_COPY.noteLabel}"`)
    expect(html).not.toContain('取消任务')
    expect(html).toMatch(/<button type="submit" class="ui-button"[^>]*>拒绝<\/button>/u)
    expect(html).not.toMatch(/<button type="submit"[^>]*aria-disabled="true"[^>]*>拒绝/u)
    expect(html).toContain('>返回</button>')
    expect(html).toContain(`<p class="composer-hint" role="note">${DECISION_COPY.noteHint}</p>`)
  })

  it('says on the card where to write while the rejection waits for its note', () => {
    const card = (noting: boolean) =>
      renderToStaticMarkup(
        createElement(
          ApprovalStatuses.Provider,
          { value: new Map(noting ? [['ap1', { noting: true as const }]] : []) },
          createElement(ToolCard, { message: null, approval: approval({ risk: 'R1' }), onDecide: () => {} }),
        ),
      )
    expect(card(true)).toContain('class="approval-footnote" aria-live="polite"')
    expect(card(true)).toContain(DECISION_COPY.noteCard)
    expect(card(false)).not.toContain(DECISION_COPY.noteCard)
  })
})
