import { expect, test } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { sendingMessageFor, type SendingMessage } from '../src/core/sendingMessage.ts'

const snapshot = {
  catalog: {
    features: { messageIdentity: true },
    defaults: { harnessId: 'standard' },
    harnesses: [
      { id: 'standard', source: 'builtin', level: 'L1' },
      { id: 'external', source: 'acp', level: 'L3' },
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

test('never duplicates queued input, a full-access start or a Host without confirmed message identities', () => {
  expect(sendingMessageFor(snapshot, { ...view, submission: { ...view.submission, queue: true } }, 'session', detail)).toBeNull()
  const start = { ...view, submission: { prompt: '你好', requestId: 'request', harnessId: 'external' }, sessionId: null }
  expect(sendingMessageFor(snapshot, start, null, null)).toBeNull()
  expect(sendingMessageFor(snapshot, { ...start, submission: { ...start.submission, harnessId: 'standard' } }, null, null)).not.toBeNull()
  expect(sendingMessageFor({ ...snapshot, catalog: { ...snapshot.catalog!, features: {} } }, view, 'session', detail)).toBeNull()
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
