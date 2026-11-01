import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Approval } from '@latch/protocol'
import { ApprovalDrawer } from '../src/composer/ApprovalDrawer.tsx'
import { Composer } from '../src/composer/Composer.tsx'
import { holdEarlierDraft } from '../src/composer/useEarlierDraft.ts'
import { rejectionFor, takesNote, useRejectionNote, type NoteContext } from '../src/composer/useRejectionNote.ts'
import { approvalActions } from '../src/core/permissions.ts'
import { APPROVAL_COPY, DECISION_COPY } from '../src/core/securityCopy.ts'

const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: 'ap1',
  sessionId: 's1',
  toolName: 'write_file',
  reason: '写入需要确认',
  requestedAt: '2026-10-25T06:24:00.000Z',
  ...extra,
})
const context = (extra: Partial<NoteContext> = {}): NoteContext => ({ selectedId: 's1', mayType: true, hostTakesNote: true, ...extra })

describe('text written before a request arrived', () => {
  const start = { ids: [] as string[], held: false }

  it('is not an answer to what arrives, and text written after it is', () => {
    expect(holdEarlierDraft(start, ['ap1'], '下一条消息').held).toBe(true)
    expect(holdEarlierDraft(start, ['ap1'], '   ').held).toBe(false)
    expect(holdEarlierDraft({ ids: ['ap1'], held: false }, ['ap1'], '改写到 docs/').held).toBe(false)
  })

  it('stays held while edited, and lets go once the input is empty or nothing waits', () => {
    const held = { ids: ['ap1'], held: true }
    expect(holdEarlierDraft(held, ['ap1'], '下一条消息，再加一句').held).toBe(true)
    expect(holdEarlierDraft(held, ['ap1'], '').held).toBe(false)
    expect(holdEarlierDraft(held, [], '下一条消息').held).toBe(false)
  })

  it('holds again for a new request, but not for one already waiting that the pager shows', () => {
    expect(holdEarlierDraft({ ids: ['ap1'], held: false }, ['ap1', 'ap2'], '改写到 docs/').held).toBe(true)
    expect(holdEarlierDraft({ ids: ['ap1', 'ap2'], held: false }, ['ap2'], '改写到 docs/').held).toBe(false)
  })
})

describe('refusing with text in the input', () => {
  // Server rendering runs the hook once; the state it would set afterwards goes nowhere, and what it sends is what counts.
  const run = (draft: string, taken = true) => {
    const decided: Array<[string | undefined, string | undefined]> = []
    const events: string[] = []
    let result: ReturnType<typeof useRejectionNote> | undefined
    function Probe() {
      result = useRejectionNote({
        ...context(),
        approval: approval({ risk: 'R1' }),
        draft,
        clearDraft: () => events.push('cleared'),
        restoreDraft: (sessionId, text) => events.push(`restored ${sessionId} ${text}`),
        decide: (_approval, optionId, note) => {
          decided.push([optionId, note])
          return Promise.resolve(taken)
        },
        rejectOption: () => 'reject_once',
      })
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return { result: result!, decided, events }
  }
  const invalid = '改用\u202edocs'

  it('never lets text that cannot go block 拒绝: it refuses plainly and leaves the text', () => {
    const { result, decided, events } = run(invalid)
    expect(result.composer?.rejectLabel).toBe(APPROVAL_COPY.reject)
    result.reject(approval(), 'reject_once')
    expect(decided).toEqual([['reject_once', undefined]])
    expect(events).toEqual([])
  })

  it('sends nothing from Enter while the text cannot go', () => {
    const { result, decided } = run(invalid)
    result.composer?.submit()
    expect(decided).toEqual([])
  })

  it('puts the note back when the rejection did not take effect', async () => {
    const { result, decided, events } = run('改写到 docs/', false)
    expect(result.composer?.rejectLabel).toBe(APPROVAL_COPY.rejectAndSend)
    result.reject(approval(), 'reject_once')
    expect(decided).toEqual([['reject_once', '改写到 docs/']])
    await Promise.resolve()
    expect(events).toEqual(['cleared', 'restored s1 改写到 docs/'])
  })

  it('leaves the input empty when it did', async () => {
    const { result, events } = run('改写到 docs/')
    result.reject(approval(), 'reject_once')
    await Promise.resolve()
    expect(events).toEqual(['cleared'])
  })
})

describe('what is typed while an approval waits', () => {
  it('goes back with the rejection, trimmed; with nothing typed the rejection goes alone', () => {
    expect(rejectionFor(approval(), 'reject_once', '  改写到 docs/ 下  ', context())).toEqual({
      optionId: 'reject_once',
      note: '改写到 docs/ 下',
    })
    expect(rejectionFor(approval(), 'reject_once', '   ', context())).toEqual({ optionId: 'reject_once' })
  })

  it('sends nothing while the text cannot go, and says why', () => {
    expect(rejectionFor(approval(), undefined, '改用\u202edocs', context())).toEqual({ problem: DECISION_COPY.noteInvalid })
  })

  it('stays a draft where a note cannot go: an agent’s ask, an older Host, a device that may not type, another session', () => {
    for (const [item, ctx] of [
      [approval({ advisory: true }), context()],
      [approval(), context({ hostTakesNote: false })],
      [approval(), context({ mayType: false })],
      [approval(), context({ selectedId: 's2' })],
    ] as const) {
      expect(takesNote(item, ctx)).toBe(false)
      expect(rejectionFor(item, 'reject', '改用 docs', ctx)).toEqual({ optionId: 'reject' })
    }
  })

  it('turns the drawer’s 拒绝 into 拒绝并发送', () => {
    const drawer = (rejectLabel?: string) =>
      renderToStaticMarkup(
        createElement(ApprovalDrawer, {
          approvals: [approval({ risk: 'R1' })],
          messages: [],
          index: 0,
          onIndex: () => {},
          gateFor: item => approvalActions(item, null, null),
          busy: new Map(),
          statuses: new Map(),
          onDecide: () => {},
          rejectLabel,
        }),
      )
    expect(drawer(APPROVAL_COPY.reject)).toContain('>拒绝</button>')
    expect(drawer(APPROVAL_COPY.rejectAndSend)).toContain('>拒绝并发送</button>')
  })

  it('keeps stop in the slot and sends only with text', () => {
    const noop = () => {}
    const base = {
      textareaRef: { current: null },
      variant: 'session' as const,
      label: APPROVAL_COPY.rejectPlaceholder,
      placeholder: APPROVAL_COPY.rejectPlaceholder,
      onDraft: noop,
      pending: null,
      sending: false,
      error: '',
      onRetry: noop,
      canSend: true,
      onSubmit: noop,
      sendKey: 'enter' as const,
      coarse: false,
      controls: null,
      run: { cancel: 'idle' as const, onCancel: noop },
      answer: { kind: 'reject' as const, onSubmit: noop },
      queueable: true,
    }
    const html = renderToStaticMarkup(createElement(Composer, { ...base, draft: '改用 docs' }))
    expect(html).toContain('aria-label="停止"')
    expect(html).not.toContain('排队')
  })
})
