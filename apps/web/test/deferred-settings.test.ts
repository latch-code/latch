import { createElement } from 'react'
import { renderToReadableStream, renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { deferredComponent } from '../src/components/DeferredContent.tsx'
import { entrySection, settingsPanel, type SettingsSection } from '../src/settings/SettingsPage.tsx'
import { pairingQr } from '../src/settings/pairingQr.ts'

describe('optional settings loading', () => {
  it('does not run an optional module loader until its body is actually rendered', async () => {
    const load = vi.fn(async () => ({ default: ({ value }: { value: string }) => createElement('p', null, value) }))
    const Content = deferredComponent(load, '测试设置')
    renderToStaticMarkup(createElement('section', null))
    expect(load).not.toHaveBeenCalled()
    const stream = await renderToReadableStream(createElement(Content, { value: 'Actual body props retained' }))
    await stream.allReady
    expect(await new Response(stream).text()).toContain('Actual body props retained')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('unselects an already chosen or remembered private section as soon as its actual permission disappears', () => {
    const permitted: SettingsSection[] = ['general', 'plugins', 'devices', 'about']
    const revoked: SettingsSection[] = ['general', 'devices', 'about']
    expect(settingsPanel(permitted, 'plugins', false, 'plugins')).toEqual({ active: 'plugins', panel: 'plugins' })
    expect(settingsPanel(revoked, 'plugins', false, 'plugins')).toEqual({ active: 'general', panel: 'general' })
    expect(settingsPanel(revoked, 'plugins', true, 'plugins')).toEqual({ active: null, panel: null })
    expect(settingsPanel(revoked, null, true, 'plugins')).toEqual({ active: null, panel: null })
    expect(settingsPanel(permitted, null, true, 'plugins')).toEqual({ active: null, panel: 'plugins' })
    expect(settingsPanel(revoked, 'providers', true, 'providers')).toEqual({ active: null, panel: null })
  })

  it('encodes real QR pixels only when requested, respecting dimensions and never reusing another payload', async () => {
    const options = { width: 160, margin: 1 }
    const first = await pairingQr('Latch fixture one', options)
    const second = await pairingQr('Latch fixture two', options)
    expect(first).toMatch(/^data:image\/png;base64,/u)
    expect(second).not.toBe(first)
    const bytes = Buffer.from(first.split(',')[1]!, 'base64')
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(bytes.readUInt32BE(16)).toBe(160)
    expect(bytes.readUInt32BE(20)).toBe(160)
    await expect(pairingQr('', options)).rejects.toThrow()
    expect(await pairingQr('Latch fixture one', options)).toBe(first)
  })

  it('names the section a page entry shows, for what stands over the page', () => {
    const all: SettingsSection[] = ['general', 'agents', 'assistants', 'routines']
    expect(entrySection({ entry: 'automations' }, all, false)).toBe('routines')
    expect(entrySection({ entry: 'agents' }, all, false)).toBe('agents')
    // A device without 管理此 Host has no Agent 成员, so the entry starts on 个人助手.
    expect(entrySection({ entry: 'agents' }, ['general', 'assistants'], false)).toBe('assistants')
    expect(entrySection({ entry: 'agents', section: 'agents' }, ['general', 'assistants'], false)).toBe('assistants')
    expect(entrySection({ entry: 'agents', section: 'routines' }, all, true)).toBe('routines')
    expect(entrySection({ entry: 'agents' }, all, true)).toBeNull()
    expect(entrySection({ entry: 'sessions' }, all, false)).toBeNull()
  })
})
