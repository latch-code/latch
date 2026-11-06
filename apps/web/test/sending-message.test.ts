import { expect, test } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { sendingMessageFor, type SendingMessage } from '../src/core/sendingMessage.ts'

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
