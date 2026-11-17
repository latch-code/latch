import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Message } from '@latch/protocol'
import { MessageRow, TurnEditLocked } from '../src/components/MessageRow.tsx'
import { editDraft } from '../src/conversation/EditFrom.tsx'

const noop = () => {}

describe('从这里编辑', () => {
  it('puts back the words the person wrote, without a fork’s context or an undo’s note, and what went with them', () => {
    const context = '以下是会话「a」到第 1 轮为止的记录\n<会话记录>…</会话记录>\n\n'
    const message: Message = {
      id: 'u2',
      role: 'user',
      text: `${context}[Latch] 在这条消息之前，用户撤销了上一轮\n\n改成蓝色 @src/a.ts`,
      forkContext: { taskId: 's', upToMessageId: 'a1', title: 'a', turn: 1, prefixLength: context.length },
      fileRefs: [{ root: 'main', path: 'src/a.ts' }],
      attachments: [{ id: 'A'.repeat(22), name: 'x.png', mime: 'image/png', kind: 'image', size: 10, sha256: 'a'.repeat(64) }],
    }
    expect(editDraft(message)).toEqual({
      text: '改成蓝色 @src/a.ts ',
      refs: [{ root: 'main', path: 'src/a.ts' }],
      attachments: message.attachments,
    })
  })

  it('stays on the message while a turn runs, unavailable with the reason in its hover', () => {
    const message: Message = { id: 'u', role: 'user', text: '问', createdAt: new Date().toISOString() }
    const open = renderToStaticMarkup(createElement(MessageRow, { message, onEdit: noop }))
    expect(open).toContain('aria-label="从这里编辑"')
    expect(open).not.toContain('aria-disabled')
    const locked = renderToStaticMarkup(
      createElement(TurnEditLocked.Provider, { value: true }, createElement(MessageRow, { message, onEdit: noop })),
    )
    expect(locked).toMatch(/aria-label="从这里编辑"[^>]*aria-disabled="true"/u)
    expect(locked).toContain('这一轮结束后才能编辑')
  })
})
