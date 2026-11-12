import { expect, test, vi } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { ApiError, ApiTimeoutError, readPending, writePending, type PendingSubmission } from '../src/core/api.ts'
import {
  abandonSubmission,
  deliveredSubmission,
  sendingMessageFor,
  unconfirmedReason,
  type SendingMessage,
} from '../src/core/sendingMessage.ts'

const snapshot = {
  catalog: {
    features: { messageIdentity: true },
    defaults: { harnessId: 'standard' },
    harnesses: [
      { id: 'standard', level: 'L1' },
      { id: 'external', level: 'L3' },
    ],
  },
} as AppSnapshot
const view: SendingMessage = {
  submission: { prompt: '你好', requestId: 'request', sessionId: 'session' },
  sessionId: 'session',
  startedAt: 0,
  state: 'sending',
}
const detail = { summary: { id: 'session' }, messages: [] } as unknown as TaskDetail

test('shows a local submission only in its own session and removes it by confirmed identity and exact input', () => {
  expect(sendingMessageFor(snapshot, view, 'session', detail)).toBe(view)
  expect(sendingMessageFor(snapshot, view, 'different', detail)).toBeNull()
  expect(
    sendingMessageFor(snapshot, view, 'session', {
      ...detail,
      messages: [{ id: 'host-user', requestId: 'request', role: 'user', text: '你好' }],
    }),
  ).toBeNull()
  expect(
    sendingMessageFor(snapshot, view, 'session', {
      ...detail,
      messages: [{ id: 'host-user', requestId: 'another', role: 'user', text: '你好' }],
    }),
  ).toBe(view)
  expect(
    sendingMessageFor(snapshot, view, 'session', {
      ...detail,
      messages: [{ id: 'host-user', requestId: 'request', role: 'user', text: 'different' }],
    }),
  ).toBe(view)
})

test('recognises its message under the note the Host adds after an undo', () => {
  expect(
    sendingMessageFor(snapshot, view, 'session', {
      ...detail,
      messages: [{ id: 'host-user', requestId: 'request', role: 'user', text: '[Latch] 上一轮的改动已撤销。\n\n你好' }],
    }),
  ).toBeNull()
})

test('never duplicates queued input or shows one on a Host without confirmed message identities', () => {
  expect(sendingMessageFor(snapshot, { ...view, submission: { ...view.submission, queue: true } }, 'session', detail)).toBeNull()
  expect(sendingMessageFor({ ...snapshot, catalog: { ...snapshot.catalog!, features: {} } }, view, 'session', detail)).toBeNull()
})

test('shows a new start at once on every Harness, full access too, until its session holds the message', () => {
  const start: SendingMessage = { ...view, submission: { prompt: '你好', requestId: 'request', harnessId: 'external' }, sessionId: null }
  expect(sendingMessageFor(snapshot, start, null, null)).toBe(start)
  expect(sendingMessageFor(snapshot, { ...start, submission: { ...start.submission, harnessId: 'standard' } }, null, null)).not.toBeNull()
  const accepted: SendingMessage = { ...start, sessionId: 'session', state: 'accepted' }
  expect(sendingMessageFor(snapshot, accepted, 'session', detail)).toBe(accepted)
  expect(
    sendingMessageFor(snapshot, accepted, 'session', {
      ...detail,
      messages: [{ id: 'host-user', requestId: 'request', role: 'user', text: '你好' }],
    }),
  ).toBeNull()
})

test('preserves attachment and explicit file identities, including a fork prefix', () => {
  const pending: SendingMessage = {
    ...view,
    submission: { ...view.submission, attachmentIds: ['upload'], fileRefs: [{ root: 'docs', path: 'notes.md' }] },
  }
  const message = {
    id: 'user',
    role: 'user' as const,
    text: 'seed你好',
    requestId: 'request',
    forkContext: { taskId: 'source', upToMessageId: 'previous', title: 'source', turn: 1, prefixLength: 4 },
    attachments: [{ id: 'upload', name: 'notes.txt', mime: 'text/plain' as const, kind: 'text' as const, size: 2, sha256: 'a'.repeat(64) }],
    fileRefs: [{ root: 'docs', path: 'notes.md' }],
  }
  expect(sendingMessageFor(snapshot, pending, 'session', { ...detail, messages: [message] })).toBeNull()
  expect(sendingMessageFor(snapshot, pending, 'session', { ...detail, messages: [{ ...message, attachments: [] }] })).toBe(pending)
})

test('an uncertain retry keeps the submission and says why; a definitive answer settles it', () => {
  expect(unconfirmedReason(new ApiTimeoutError())).toBe(new ApiTimeoutError().message)
  expect(unconfirmedReason(new ApiError(502, 'harness-unavailable', 'Harness 没有答复。'))).toBe('Harness 没有答复。')
  expect(unconfirmedReason(new ApiError(408, 'timeout', '请求超时。'))).toBe('请求超时。')
  expect(unconfirmedReason(new TypeError('Failed to fetch'))).toBe('连接暂时不可用，请检查网络后重试。')
  expect(unconfirmedReason(new ApiError(503, 'agent-busy', '忙'))).toBeNull()
  expect(unconfirmedReason(new ApiError(409, 'request-conflict', '冲突'))).toBeNull()
})

test('放弃这次提交 lets go of the stored submission and hands its text back, never another window’s newer one', () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  })
  try {
    const held: PendingSubmission = { requestId: 'held-request', prompt: '你好', sessionId: 'session' }
    writePending('k', held)
    expect(abandonSubmission('k', held)).toEqual({ sessionId: 'session', text: '你好' })
    expect(readPending('k')).toBeNull()
    const fresh: PendingSubmission = { requestId: 'fresh-request', prompt: '新的' }
    writePending('k', fresh)
    expect(abandonSubmission('k', held)).toEqual({ sessionId: 'session', text: '你好' })
    expect(readPending('k')).toEqual(fresh)
    expect(abandonSubmission('k', fresh)).toEqual({ sessionId: null, text: '新的' })
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a submission the Host lists in its session by requestId counts as delivered', () => {
  const held: PendingSubmission = { requestId: 'request', prompt: '你好', sessionId: 'session' }
  const listed: TaskDetail = { ...detail, messages: [{ id: 'm', requestId: 'request', role: 'user', text: '你好' }] }
  expect(deliveredSubmission(held, listed)).toBe(true)
  expect(deliveredSubmission(held, detail)).toBe(false)
  expect(deliveredSubmission(held, { ...listed, summary: { ...listed.summary, id: 'other' } })).toBe(false)
  expect(deliveredSubmission(held, { ...listed, messages: [{ id: 'm', requestId: 'request', role: 'assistant', text: '' }] })).toBe(false)
  // A new session's ID comes only with the answer, so nothing can be checked.
  expect(deliveredSubmission({ requestId: 'request', prompt: '你好' }, listed)).toBe(false)
  expect(deliveredSubmission(null, listed)).toBe(false)
})
