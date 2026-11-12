import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { Message } from '@latch/protocol'
import { FAILURE_ACTION_LABEL, failureAction } from '../src/conversation/failureAction.ts'
import { MessageRow } from '../src/components/MessageRow.tsx'

it('offers the one next step a failure code names, and 重试 for any other', () => {
  expect(failureAction(undefined)).toBe('retry')
  expect(failureAction('something-new')).toBe('retry')
  expect(failureAction('agent-start-failed')).toBe('harness')
  expect(failureAction('harness-version-unsupported')).toBe('harness')
  expect(failureAction('model-unavailable')).toBe('model')
  expect(failureAction('http-404')).toBe('model')
  expect(failureAction('http-401')).toBe('providers')
  expect(failureAction('egress-denied')).toBe('providers')
  expect(failureAction('harness-session-lost')).toBe('continue')
  // The project recovery panel already says what to do.
  expect(failureAction('workspace-changed')).toBe('none')
})

it('shows a failed note with its reason and its own step, and an interrupted note as no failure', () => {
  const failed: Message = { id: 'n', role: 'system', text: '模型 x 未在此服务中启用。', state: 'failed', errorCode: 'model-unavailable' }
  const html = renderToStaticMarkup(
    createElement(MessageRow, { message: failed, onRetry: () => {}, action: { label: FAILURE_ACTION_LABEL.model, run: () => {} } }),
  )
  expect(html).toContain('模型 x 未在此服务中启用。')
  expect(html).toContain('换个模型')
  expect(html).not.toContain('重试')
  const plain = renderToStaticMarkup(createElement(MessageRow, { message: { ...failed, errorCode: undefined }, onRetry: () => {} }))
  expect(plain).toContain('重试')
  const interrupted: Message = { id: 'i', role: 'system', text: 'Latch 重启时中断。', state: 'cancelled', interrupted: true }
  const cut = renderToStaticMarkup(createElement(MessageRow, { message: interrupted }))
  expect(cut).toContain('is-interrupted')
  expect(cut).not.toContain('is-failed')
})
