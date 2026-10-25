import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageRow } from '../src/components/MessageRow.tsx'
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
})
