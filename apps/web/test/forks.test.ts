import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageRow } from '../src/components/MessageRow.tsx'
import { resendText } from '../src/conversation.ts'
import { readPending, submissionRequest, writePending } from '../src/core/api.ts'
afterEach(() => vi.unstubAllGlobals())
describe('fork presentation and retries', () => {
  it('keeps a fork source in the exact stored request and excludes client history', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const input = {
      prompt: 'New path',
      requestId: 'same-request',
      harnessId: 'standard',
      forkOf: { taskId: 'source', upToMessageId: 'answer' },
    }
    writePending('pending', input)
    expect(readPending('pending')).toEqual(input)
    expect(submissionRequest(readPending('pending')!).body).toEqual({ ...input, mode: 'agent' })
    values.set('pending', JSON.stringify({ ...input, forkOf: { taskId: 3, upToMessageId: 'answer' } }))
    expect(readPending('pending')).toBeNull()
  })
  it('folds the Host context as escaped text, leaving the new instruction visible', () => {
    const prefix = '<script>host context</script>\n'
    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: {
          id: 'u',
          role: 'user',
          text: prefix + 'Try a different approach',
          forkContext: { taskId: 'source', upToMessageId: 'a', title: 'Source', turn: 2, prefixLength: prefix.length },
        },
      }),
    )
    expect(html).toContain('<details class="fork-context">')
    expect(html).toContain('第 2 轮为止的记录')
    expect(html).toContain('&lt;script&gt;host context&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('Try a different approach')
  })
  it('says the harness carries its own record when it forked natively, with no text record to unfold', () => {
    const prefix = 'host context that was not sent\n'
    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: {
          id: 'u',
          role: 'user',
          text: prefix + 'Try a different approach',
          nativeFork: true,
          forkContext: { taskId: 'source', upToMessageId: 'a', title: 'Source', turn: 2, prefixLength: prefix.length },
        },
        harness: 'pi',
      }),
    )
    expect(html).not.toContain('<details')
    expect(html).not.toContain('host context')
    expect(html).toContain('pi 自己带着会话「')
    expect(html).toContain('第 2 轮为止的记录')
    expect(html).toContain('Try a different approach')
  })
  it("resends a native fork's first words alone, and a text fork's with the record it sent", () => {
    const prefix = 'host context\n'
    const forkContext = { taskId: 'source', upToMessageId: 'a', title: 'Source', turn: 1, prefixLength: prefix.length }
    const first = { id: 'u', role: 'user' as const, text: prefix + 'Try a different approach', forkContext }
    // The Harness forked its own record and never got the text one.
    expect(resendText({ ...first, nativeFork: true })).toBe('Try a different approach')
    // The text record is what the Harness knows of the source; it may not have arrived when the turn failed.
    expect(resendText(first)).toBe(prefix + 'Try a different approach')
    expect(resendText({ text: 'Plain' })).toBe('Plain')
  })
})
