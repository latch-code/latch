import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AppFrameMessage, AppHostInfo } from '@latch/protocol'
import { isAppFrameMessage, isAppShellMessage } from '@latch/protocol'
import { AppBridgeError, createBridge } from '../src/bridge.ts'
import { defineApp, isAppDefinition } from '../src/index.ts'
import { createAppUi, type AppPrimitives } from '../src/ui.tsx'
import { removeSockets } from '../src/runtime.tsx'

const INFO: AppHostInfo = { sdk: '1.0.0', appProtocol: 1, theme: 'light', offline: false, canRun: true, harnesses: [] }

function client() {
  const posted: AppFrameMessage[] = []
  const { latch, receive } = createBridge(message => posted.push(message), { info: INFO, view: { scroll: 3 } })
  const last = () => posted.at(-1) as Extract<AppFrameMessage, { t: 'call' }>
  return { latch, receive, posted, last }
}

describe('the bridge client in the frame', () => {
  it('sends only messages the shell accepts, and resolves each call by its ID', async () => {
    const { latch, receive, posted, last } = client()
    const listed = latch.tasks.list({ mine: true })
    expect(isAppFrameMessage(last())).toBe(true)
    expect(last()).toMatchObject({ t: 'call', method: 'tasks.list', params: { filter: { mine: true } } })
    receive({ t: 'result', id: last().id, ok: true, value: [{ id: 's' }] })
    expect(await listed).toEqual([{ id: 's' }])
    // Anything that is not a shell message is dropped.
    receive({ t: 'result', id: 99, ok: true, value: 1, extra: true })
    expect(posted).toHaveLength(1)
  })

  it('keeps the request ID of a start for the retry of an unknown result', async () => {
    const { latch, receive, last } = client()
    const started = latch.tasks.start({ prompt: '检查' })
    const { requestId } = last().params as { requestId: string }
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u)
    receive({ t: 'result', id: last().id, ok: false, code: 'unknown' })
    const error = await started.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(AppBridgeError)
    expect(error).toMatchObject({ code: 'unknown', requestId })
    const again = latch.tasks.start({ prompt: '检查', requestId })
    expect((last().params as { requestId: string }).requestId).toBe(requestId)
    receive({ t: 'result', id: last().id, ok: true, value: { sessionId: 's1' } })
    expect(await again).toEqual({ sessionId: 's1', requestId })
  })

  it('feeds a subscription once the shell names it, and unsubscribes', async () => {
    const { latch, receive, last } = client()
    const updates: unknown[] = []
    const stop = latch.tasks.subscribe({}, update => updates.push(update))
    receive({ t: 'result', id: last().id, ok: true, value: { subscription: 4 } })
    await Promise.resolve()
    receive({ t: 'event', name: 'tasks', subscription: 4, offline: true, tasks: [] })
    expect(updates).toEqual([{ offline: true, tasks: [] }])
    stop()
    expect(last()).toMatchObject({ method: 'tasks.unsubscribe', params: { subscription: 4 } })
    receive({ t: 'event', name: 'tasks', subscription: 4, offline: false, tasks: [] })
    expect(updates).toHaveLength(1)
  })

  it('keeps a list that arrives before the subscription is named and hands it over', async () => {
    const { latch, receive, last } = client()
    const updates: unknown[] = []
    latch.tasks.subscribe({}, update => updates.push(update))
    const id = last().id
    receive({ t: 'event', name: 'tasks', subscription: 7, offline: false, tasks: [{ id: 's' }] })
    receive({ t: 'result', id, ok: true, value: { subscription: 7 } })
    await Promise.resolve()
    expect(updates).toEqual([{ offline: false, tasks: [{ id: 's' }] }])
  })

  it('keeps view state in the tab, at most 64 KiB, and reads host facts without asking', () => {
    const { latch, last } = client()
    expect(latch.view.getState()).toEqual({ scroll: 3 })
    latch.view.setState({ open: ['a'] })
    expect(latch.view.getState()).toEqual({ open: ['a'] })
    expect(last()).toMatchObject({ method: 'view.setState', params: { state: { open: ['a'] } } })
    expect(() => {
      latch.view.setState('x'.repeat(70 * 1024))
    }).toThrow(AppBridgeError)
    expect(latch.host.info()).toEqual(INFO)
  })

  it('checks shell messages strictly', () => {
    expect(isAppShellMessage({ t: 'result', id: 1, ok: false, code: 'forbidden' })).toBe(true)
    expect(isAppShellMessage({ t: 'result', id: 1, ok: false, code: 'Host 原文' })).toBe(false)
    expect(isAppShellMessage({ t: 'event', name: 'tasks', subscription: 1, offline: false, tasks: [], more: 1 })).toBe(false)
    expect(isAppFrameMessage({ t: 'call', id: 1, method: 'approvals.allow', params: {} })).toBe(false)
    expect(isAppFrameMessage({ t: 'key', key: 'k', code: 'KeyK', meta: true, ctrl: false, shift: false, alt: false })).toBe(true)
  })
})

describe('page definitions and primitives', () => {
  it('knows only the definitions defineApp made', () => {
    const page = () => null
    expect(isAppDefinition(defineApp({ page }))).toBe(true)
    expect(isAppDefinition({ page })).toBe(false)
    expect(() => defineApp({} as never)).toThrow(TypeError)
  })

  it('never passes secure, icons or anything unlisted through to the primitives', () => {
    const seen = vi.fn()
    const spy: ComponentType<Record<string, unknown>> = props => {
      seen(props)
      return null
    }
    const primitives = Object.fromEntries(
      [
        'Button',
        'TextField',
        'TextAreaField',
        'Checkbox',
        'Switch',
        'SegmentedControl',
        'Group',
        'Row',
        'StatusPill',
        'Badge',
        'Count',
        'InlineNotice',
        'Hint',
        'Loading',
        'EmptyState',
        'ProgressBar',
      ].map(name => [name, spy]),
    ) as AppPrimitives
    const ui = createAppUi(primitives)
    expect(Object.keys(ui)).not.toContain('Dialog')
    expect(Object.keys(ui)).not.toContain('Toast')
    renderToStaticMarkup(createElement(ui.Notice as ComponentType<Record<string, unknown>>, { tone: 'warn', secure: true, title: 't' }))
    expect(seen.mock.lastCall?.[0]).toMatchObject({ secure: false, tone: 'warn' })
    renderToStaticMarkup(
      createElement(ui.Button as ComponentType<Record<string, unknown>>, { children: 'x', icon: 'Trash', shortcut: 'mod+k' }),
    )
    expect(seen.mock.lastCall?.[0]).not.toHaveProperty('icon')
    expect(seen.mock.lastCall?.[0]).not.toHaveProperty('shortcut')
    // A hint with a detail has the primitive's ⓘ button, so no lead glyph (whose default is the same ⓘ); a label alone keeps it.
    renderToStaticMarkup(
      createElement(ui.Hint as ComponentType<Record<string, unknown>>, { label: '开一个真实会话', lead: 'x', children: '说明' }),
    )
    expect(seen.mock.lastCall?.[0]).toEqual({ label: '开一个真实会话', lead: false, children: '说明' })
    renderToStaticMarkup(createElement(ui.Hint as ComponentType<Record<string, unknown>>, { label: '只有标签' }))
    expect(seen.mock.lastCall?.[0]).toEqual({ label: '只有标签' })
  })
})

describe('the runtime', () => {
  it('removes what opens a connection without connect-src before a page runs', () => {
    class Navigator {
      get mediaDevices() {
        return {}
      }
      get connection() {
        return {}
      }
    }
    const scope = {
      RTCPeerConnection: class {},
      webkitRTCPeerConnection: class {},
      RTCDataChannel: class {},
      WebTransport: class {},
      MediaStream: class {},
      fetch: () => {},
      Navigator,
      navigator: new Navigator(),
    } as unknown as typeof globalThis
    removeSockets(scope)
    expect(Object.keys(scope).sort()).toEqual(['Navigator', 'fetch', 'navigator'])
    expect((scope.navigator as unknown as { mediaDevices?: unknown }).mediaDevices).toBeUndefined()
    expect((scope.navigator as unknown as { connection?: unknown }).connection).toBeUndefined()
  })
})
