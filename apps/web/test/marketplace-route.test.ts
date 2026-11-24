import { describe, expect, it } from 'vitest'
import { PLUGIN_MARKETPLACE_PAGE } from '@latch/protocol'
import { isMarketplaceLink, marketplaceAvailable, marketplaceUrl } from '../src/plugin-marketplace/route.ts'
import { pluginAddInput } from '../src/plugin-marketplace/pluginAddInput.ts'

const desktop = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 }
const available = {
  catalog: { workspacePages: [PLUGIN_MARKETPLACE_PAGE] },
  device: { scopes: ['view'] as ['view'] },
}

describe('marketplace routes', () => {
  it('requires this release’s marketplace contribution and view permission', () => {
    expect(marketplaceAvailable(available, desktop)).toBe(true)
    expect(marketplaceAvailable({ ...available, catalog: {} }, desktop)).toBe(false)
    expect(marketplaceAvailable({ ...available, device: { scopes: ['run'] } }, desktop)).toBe(false)
    expect(marketplaceAvailable({ ...available, catalog: { workspacePages: [{ ...PLUGIN_MARKETPLACE_PAGE, version: 2 }] } }, desktop)).toBe(
      false,
    )
    expect(
      marketplaceAvailable(
        { ...available, catalog: { workspacePages: [{ ...PLUGIN_MARKETPLACE_PAGE, pluginId: 'same-route' }] } },
        desktop,
      ),
    ).toBe(false)
  })

  it('excludes iPhone, iPad and iPad desktop-mode Safari without excluding Android touch clients', () => {
    for (const device of [
      { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6)', platform: 'iPhone', maxTouchPoints: 5 },
      { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_6)', platform: 'iPad', maxTouchPoints: 5 },
      { ...desktop, maxTouchPoints: 5 },
    ])
      expect(marketplaceAvailable(available, device)).toBe(false)
    expect(
      marketplaceAvailable(available, { userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux aarch64', maxTouchPoints: 5 }),
    ).toBe(true)
  })

  it('routes the deep link without replacing unrelated URL data', () => {
    const base = 'https://example.com/link/?theme=dark'
    const market = new URL(marketplaceUrl(base, true), base).href
    expect(market).toBe(`${base}&page=marketplace`)
    expect(isMarketplaceLink(market)).toBe(true)
    expect(marketplaceUrl(market, false)).toBe('/link/?theme=dark')
    expect(isMarketplaceLink('https://example.com/link/?page=other')).toBe(false)
  })
})

it('routes the shared input by its source while preserving exact npm versions and GitHub refs', () => {
  expect(pluginAddInput('@studio/notes')).toEqual({ kind: 'npm', name: '@studio/notes' })
  expect(pluginAddInput('  @studio/notes@1.2.3-rc.1  ')).toEqual({ kind: 'npm', name: '@studio/notes', version: '1.2.3-rc.1' })
  expect(pluginAddInput('notes@2.0.0')).toEqual({ kind: 'npm', name: 'notes', version: '2.0.0' })
  for (const input of [
    'https://github.com/team/plugins.git',
    'https://github.com/team/plugins/tree/release/v1',
    '~/My Plugins',
    '/tmp/plugins',
  ])
    expect(pluginAddInput(input)).toEqual({ kind: 'external', input })
  for (const input of [
    'https://github.com.invalid/team/plugins',
    'https://github.com/team/plugins?token=secret',
    './plugins',
    '@studio/notes@latest',
  ])
    expect(pluginAddInput(input)).toBeUndefined()
})
