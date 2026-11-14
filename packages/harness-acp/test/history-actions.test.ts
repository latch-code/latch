import { describe, expect, it } from 'vitest'
import { captureUpdate, newCapture } from '../src/history.ts'

const call = {
  sessionUpdate: 'tool_call',
  toolCallId: 'c1',
  title: 'cat secret-token.txt',
  kind: 'execute',
  status: 'completed',
  rawInput: { command: 'cat secret-token.txt' },
  actions: [{ kind: 'search', query: 'secret-token', path: '/work/secret-token.txt' }],
}
const redact = (text: string) => text.replaceAll('secret-token', '[已隐藏]')

describe("a command's classification in history brought in from an agent", () => {
  it('is dropped unless the wire is the Codex one', () => {
    const capture = newCapture('s')
    captureUpdate(capture, call, '2026-11-14T10:00:00.000Z', redact)
    expect(capture.entries[0]?.message.tool?.actions).toBeUndefined()
    expect(capture.entries[0]?.message.tool?.title).toBe('cat [已隐藏].txt')
  })

  it('is redacted like the title and the input where it is kept', () => {
    const capture = newCapture('s')
    captureUpdate(capture, call, '2026-11-14T10:00:00.000Z', redact, true)
    expect(capture.entries[0]?.message.tool?.actions).toEqual([{ kind: 'search', query: '[已隐藏]', path: '/work/[已隐藏].txt' }])
  })
})
