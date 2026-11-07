import { describe, expect, it } from 'vitest'
import type { HarnessLogin } from '@latch/protocol'
import { loginDoubted, shownLogin } from '../src/components/HarnessLogin.tsx'

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
