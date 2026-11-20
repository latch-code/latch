import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import {
  canOpenSystemSettings,
  LOCAL_NETWORK_SETTINGS,
  LocalNetworkHint,
  LocalNetworkNote,
  LocalNetworkOpen,
  openLocalNetworkSettings,
} from '../src/settings/LocalNetworkHint.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
})
const render = (props: Parameters<typeof LocalNetworkHint>[0]) => renderToStaticMarkup(createElement(LocalNetworkHint, props))

it('says nothing while access is allowed or unknown', () => {
  expect(render({ state: undefined, openable: true, source: true })).toBe('')
  expect(render({ state: 'allowed', openable: true, source: true })).toBe('')
})

it('offers the Local Network settings page in the desktop app and its path elsewhere', () => {
  for (const state of ['denied', 'unreadable'] as const) {
    const app = render({ state, openable: true, source: false })
    expect(app).toContain('本地网络未允许')
    expect(app).toContain('打开系统设置')
    expect(app).toContain(`href="${LOCAL_NETWORK_SETTINGS}"`)
    expect(app).toContain('target="_blank"')
    expect(app).not.toContain('scripts/desktop.sh')
    const browser = render({ state, openable: false, source: false })
    expect(browser).toContain('本地网络未允许')
    expect(browser).toContain('系统设置 › 隐私与安全性 › 本地网络')
    expect(browser).not.toContain('href=')
  }
  // The settings row splits them: the note under the title, the button at the end, and the path only without one.
  expect(renderToStaticMarkup(createElement(LocalNetworkNote, { state: 'denied', openable: true, source: false }))).not.toContain(
    '系统设置 ›',
  )
  expect(renderToStaticMarkup(createElement(LocalNetworkOpen, { state: 'denied', openable: false }))).toBe('')
  expect(renderToStaticMarkup(createElement(LocalNetworkOpen, { state: 'allowed', openable: true }))).toBe('')
  // A source run names the script that starts the Host with access.
  expect(render({ state: 'denied', openable: true, source: true })).toContain('scripts/desktop.sh')
})

it('lets only this Mac’s own desktop window open System Settings', () => {
  expect(canOpenSystemSettings(true)).toBe(false)
  vi.stubGlobal('window', { latchShell: { kind: 'electron', platform: 'darwin' } })
  expect(canOpenSystemSettings(true)).toBe(true)
  expect(canOpenSystemSettings(false)).toBe(false)
  vi.stubGlobal('window', { latchShell: { kind: 'electron', platform: 'darwin', remote: true } })
  expect(canOpenSystemSettings(true)).toBe(false)
})

it('opens System Settings and the guide through the desktop app’s one call, and leaves the link alone elsewhere', async () => {
  // A browser (no shell) and an older shell without the call: the link goes as before.
  for (const shell of [undefined, { kind: 'electron', platform: 'darwin' }]) {
    vi.stubGlobal('window', shell ? { latchShell: shell } : {})
    const preventDefault = vi.fn()
    openLocalNetworkSettings({ preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
  }
  const openSettings = vi.fn(async () => true)
  vi.stubGlobal('window', { latchShell: { kind: 'electron', platform: 'darwin', localNetwork: { openSettings } } })
  const preventDefault = vi.fn()
  openLocalNetworkSettings({ preventDefault })
  expect(preventDefault).toHaveBeenCalledTimes(1)
  expect(openSettings).toHaveBeenCalledTimes(1)
  expect(openSettings).toHaveBeenCalledWith()
  // A refusal from main is quiet; the hint stays.
  openSettings.mockRejectedValueOnce(new Error('refused'))
  openLocalNetworkSettings({ preventDefault })
  await Promise.resolve()
})
