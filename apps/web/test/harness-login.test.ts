import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { testHarness } from '@latch/testkit'
import { describe, expect, it } from 'vitest'
import type { HarnessInfo, HarnessLogin } from '@latch/protocol'
import { DraftLoginNotice, loginDoubted, shownLogin } from '../src/components/HarnessLogin.tsx'
import { loginHarness } from '../src/composerChoice.ts'

const ends = '2026-12-01T00:00:00.000Z'
const account: HarnessLogin['reported'] = { status: 'authenticated', label: 'Claude Max' }
const none: HarnessLogin['reported'] = { status: 'unauthenticated' }

describe('which login a page shows', () => {
  it('shows the answer it asked for over a push that was already there, as 重新检查 expects', () => {
    // Logged out in another terminal; the idle process still says what it said at its last turn.
    expect(shownLogin({ value: { status: 'unauthenticated' }, pushed: account }, account)).toEqual({ status: 'unauthenticated' })
    // Logged in again while a process that saw the logout sits idle.
    expect(shownLogin({ value: { status: 'authenticated', expiresAt: ends }, pushed: none }, none)).toEqual({
      status: 'authenticated',
      expiresAt: ends,
    })
  })

  it('shows a push that arrived after it asked', () => {
    expect(shownLogin({ value: { status: 'unauthenticated' }, pushed: undefined }, account)).toEqual(account)
    expect(shownLogin({ value: { status: 'authenticated', label: 'Claude Max', expiresAt: ends }, pushed: account }, none)).toEqual(none)
    // Still logged in under another plan: the harness's new label, the program's date.
    expect(
      shownLogin(
        { value: { status: 'authenticated', label: 'Claude Max', expiresAt: ends }, pushed: account },
        { status: 'authenticated', label: 'Claude Pro' },
      ),
    ).toEqual({ status: 'authenticated', label: 'Claude Pro', expiresAt: ends })
  })

  it('keeps a clear answer when the process that pushed is gone, and takes a push over an unclear answer', () => {
    expect(shownLogin({ value: { status: 'authenticated', label: 'Claude Max', expiresAt: ends }, pushed: account }, undefined)).toEqual({
      status: 'authenticated',
      label: 'Claude Max',
      expiresAt: ends,
    })
    expect(shownLogin({ value: { status: 'unknown' }, pushed: account }, account)).toEqual(account)
    // A push of a kind Latch does not know says nothing.
    expect(shownLogin({ value: { status: 'unauthenticated' }, pushed: undefined }, { status: 'unknown' })).toEqual({
      status: 'unauthenticated',
    })
  })

  it('shows the push until it has asked, and nothing while neither has spoken', () => {
    expect(shownLogin(undefined, account)).toEqual(account)
    expect(shownLogin(undefined, undefined)).toEqual({})
  })
})

describe('a test start that disagrees with the login check', () => {
  it('doubts a login the check reports but the last test start did not find', () => {
    expect(loginDoubted('authenticated', { login: 'unauthenticated' })).toBe(true)
  })

  it('leaves every other pair alone', () => {
    expect(loginDoubted('authenticated', { login: 'authenticated' })).toBe(false)
    expect(loginDoubted('authenticated', { login: 'unknown' })).toBe(false)
    expect(loginDoubted('authenticated', {})).toBe(false)
    expect(loginDoubted('authenticated', undefined)).toBe(false)
    // Not logged in already lists how to log in.
    expect(loginDoubted('unauthenticated', { login: 'unauthenticated' })).toBe(false)
    expect(loginDoubted(undefined, { login: 'unauthenticated' })).toBe(false)
  })
})

describe('a draft on a Harness that cannot be asked about its login', () => {
  // Qwen Code, like every preset without a status command: no `checkable`, so nothing is asked before sending.
  const login: HarnessLogin = { command: 'qwen', note: '进入 Qwen Code 后输入 /auth，按提示登录。' }
  const last = { at: '2026-11-15T03:00:00.000Z', ok: false, loginRequired: true as const, message: 'Qwen Code 还没登录。' }
  const qwen = (read: HarnessInfo['catalogueRead']): HarnessInfo => ({
    ...testHarness('qwen', { label: 'Qwen Code' }),
    login,
    ...(read ? { catalogueRead: read } : {}),
  })
  const notice = (harness: HarnessInfo | undefined) =>
    renderToStaticMarkup(createElement(DraftLoginNotice, { harness, allowed: true, surface: { kind: 'latch' } }))

  it('shows the login row once reading its lists was refused for want of a login, as a checkable Harness’s', () => {
    const html = notice(qwen({ when: 'select', modes: true, last }))
    expect(html).toContain('aria-label="登录"')
    expect(html).toContain('<strong>Qwen Code 还没登录</strong>')
    expect(html).toContain('<code>qwen</code>')
    for (const control of ['复制登录命令', '在终端里登录', '重新检查']) expect(html).toContain(control)
  })

  it('offers only to look again for a Harness Latch knows no login command of', () => {
    const { login: _login, ...unknown } = qwen({ when: 'select', modes: true, last })
    const html = notice(unknown)
    expect(html).toContain('<strong>Qwen Code 还没登录</strong>')
    expect(html).toContain('重新检查')
    for (const absent of ['在终端里登录', '复制登录命令', '<code>']) expect(html).not.toContain(absent)
    expect(notice({ ...unknown, catalogueRead: { when: 'select', modes: true } })).toBe('')
  })

  it('shows nothing before a read, after a read that failed otherwise, or after one that went through', () => {
    expect(notice(qwen({ when: 'select', modes: true }))).toBe('')
    expect(notice(qwen({ when: 'select', modes: true, last: { at: last.at, ok: false, message: last.message } }))).toBe('')
    expect(notice(qwen({ when: 'select', modes: true, last: { at: last.at, ok: true } }))).toBe('')
  })

  it('shows nothing while the draft is on a model of a service', () => {
    const harness = qwen({ when: 'select', modes: true, last })
    harness.capabilities.models = { ...harness.capabilities.models, wires: ['chat-completions'] }
    const catalog = {
      harnesses: [harness],
      providers: [{ id: 'relay', name: 'Relay', kind: 'openai-compatible' as const, models: ['relay-model'], defaultModel: 'relay-model' }],
      workspaces: [],
      defaults: { harnessId: harness.id, mode: 'agent' as const, workspaceId: 'default' },
    }
    const picks = { '~service': 'relay\u0000relay-model' }
    expect(loginHarness(catalog, harness, picks)).toBeUndefined()
    expect(notice(loginHarness(catalog, harness, picks))).toBe('')
    expect(notice(loginHarness(catalog, harness, undefined))).toContain('Qwen Code 还没登录')
  })
})
