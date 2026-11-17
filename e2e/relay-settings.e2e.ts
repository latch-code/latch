import { createHash } from 'node:crypto'
import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Device, NativeLinkInfo, NativeRelayTest } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openEntry } from './helpers/layout.ts'

/**
 * 设置 › 中继 against a scripted Host: every state a relay row has, 添加中继 through a relay file with the check card and
 * the progress line, a file that is refused, and a device that only reads. Screenshots at four widths, light and dark.
 */
const OUTPUT = process.env.LATCH_RELAY_SHOTS ? resolve(process.env.LATCH_RELAY_SHOTS, 'settings') : 'test-results/relay-settings'
const SIZES = [
  { width: 390, height: 844, label: '390' },
  { width: 768, height: 1024, label: '768' },
  { width: 1100, height: 800, label: '1100' },
  { width: 1440, height: 900, label: '1440' },
] as const

const edge = {
  url: 'https://latch-relay-ne.example.workers.dev/',
  relayId: 'e'.repeat(32),
  kind: 'edge' as const,
  relayKey: 'f'.repeat(64),
  registrationKey: `lrt1.${'K'.repeat(43)}`,
}
const keyHash = createHash('sha256').update(Buffer.from(edge.relayKey, 'hex')).digest('hex').slice(0, 8)
type Relay = NativeLinkInfo['relays'][number]
const row = (relayId: string, status: Relay['status'], extra: Partial<Relay> = {}): Relay => ({
  relayId,
  url: `https://${relayId.slice(0, 6)}.example.com/`,
  kind: 'self',
  status,
  addresses: 1,
  keyHash: 'a1b2c3d4',
  ...extra,
})
const ALL_STATES: Relay[] = [
  row('1'.repeat(32), 'connecting'),
  row('2'.repeat(32), 'connected', { kind: 'edge', latencyMs: 38, connectedAt: Date.UTC(2026, 10, 18, 2) }),
  row('3'.repeat(32), 'mismatch', { kind: 'edge' }),
  row('4'.repeat(32), 'waiting', { retryAt: Date.UTC(2026, 10, 18, 3) }),
  row('5'.repeat(32), 'disabled'),
]

async function scripted(page: Page, local: boolean, relays: Relay[], listening = true) {
  const state = { relays, posted: [] as unknown[], patched: [] as unknown[], deleted: [] as string[] }
  // This Mac's desktop app: the page is local only inside the shell, on host.sock.
  if (local)
    await page.addInitScript(() => {
      Object.defineProperty(window, 'latchShell', { value: { kind: 'electron', platform: 'darwin' } })
    })
  const info = (): NativeLinkInfo => ({
    version: 1,
    enabled: true,
    directManaged: false,
    listening: listening ? { host: '192.168.1.20', port: 4319 } : null,
    directory: false,
    sourceCheckout: true,
    relays: state.relays,
  })
  await page.route('**/link/api/snapshot', async route => {
    const response = await route.fetch()
    const snapshot = (await response.json()) as { device: Device }
    snapshot.device = {
      ...snapshot.device,
      listener: local ? 'unix' : 'loopback-tcp',
      scopes: ['view', 'run', 'approve:standard', 'admin'],
    }
    await route.fulfill({ response, json: snapshot })
  })
  await page.route('**/link/api/native/info', route => route.fulfill({ json: info() }))
  await page.route('**/link/api/native/relays', route => {
    state.posted.push(route.request().postDataJSON())
    state.relays = [...state.relays, { ...row(edge.relayId, 'connected', { kind: 'edge', latencyMs: 41 }), url: edge.url, keyHash }]
    return route.fulfill({ status: 201, json: info() })
  })
  await page.route('**/link/api/native/relays/*', route => {
    const id = route.request().url().split('/').at(-1)!
    if (route.request().method() === 'DELETE') {
      state.deleted.push(id)
      state.relays = state.relays.filter(relay => relay.relayId !== id)
    } else {
      const body = route.request().postDataJSON() as { disabled: boolean }
      state.patched.push({ id, ...body })
      state.relays = state.relays.map(relay =>
        relay.relayId === id ? { ...relay, status: body.disabled ? 'disabled' : 'connecting' } : relay,
      )
    }
    return route.fulfill({ json: info() })
  })
  await page.route('**/link/api/native/relays/*/test', route =>
    route.fulfill({ json: { reached: 'identity', failure: 'refused', latencyMs: 40 } satisfies NativeRelayTest }),
  )
  return state
}

describe('设置 › 中继', () => {
  let host: TestHost
  let browser: Browser
  beforeAll(async () => {
    host = await startTestHost({ demo: true, uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser.close()
    await host.close()
  })

  for (const size of SIZES)
    it(`shows direct first, every relay state, adds from a file and refuses a bad one at ${size.label}`, async () => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } })
      context.setDefaultTimeout(15_000)
      try {
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `中继 ${size.label}`, scopes: ['admin'] })
        const state = await scripted(page, true, [...ALL_STATES])
        await page.reload()
        await connected(page)
        await openEntry(page, '中继')
        const capture = async (name: string) => {
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
            await page.waitForTimeout(500)
            await page.screenshot({ path: `${OUTPUT}/${name}-${size.label}-${colorScheme}.png`, animations: 'disabled' })
          }
          await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
        }
        await page.getByTestId('relay-direct').getByText('可用').waitFor()
        for (const word of ['连接中', '已连接 · 38 ms', '密钥不符', '连不上', '已停用'])
          await page.getByText(word, { exact: true }).first().waitFor()
        await expect.poll(() => page.getByText('官方中继').count()).toBe(0)
        await capture('relays-states')

        // ⋯ › 测试 shows the four steps where it stopped; ⋯ › 停用 and 移除 go to the Host.
        const second = page.getByTestId('relay-own').nth(1)
        await second.getByRole('button', { name: '更多' }).click()
        await page.getByRole('menuitem', { name: '测试' }).click()
        await second.getByText('注册', { exact: true }).waitFor()
        await capture('relays-test')
        await second.getByRole('button', { name: '更多' }).click()
        await page.getByRole('menuitem', { name: '停用' }).last().click()
        await expect.poll(() => state.patched).toEqual([{ id: '2'.repeat(32), disabled: true }])
        await page.getByTestId('relay-own').nth(4).getByRole('button', { name: '更多' }).click()
        await page.getByRole('menuitem', { name: '移除' }).last().click()
        await expect.poll(() => state.deleted).toEqual(['5'.repeat(32)])

        // 添加中继 › 已有中继文件: a file that is not one is refused; a good one shows the check card, never the token.
        await page.getByRole('button', { name: '添加中继' }).click()
        const sheet = page.locator('.relay-add-dialog')
        await sheet.getByTestId('relay-ways').waitFor()
        await capture('relays-add-ways')
        await sheet.getByRole('button', { name: 'Cloudflare Workers' }).click()
        await sheet.getByText('wrangler login', { exact: true }).waitFor()
        await capture('relays-add-cloudflare')
        await sheet.getByRole('button', { name: '返回' }).click()
        await sheet.getByRole('button', { name: '已有中继文件' }).click()
        await sheet
          .getByTestId('relay-file')
          .setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"version":9}') })
        await sheet.getByText('这个文件不是中继导出的连接配置。').waitFor()
        await capture('relays-file-rejected')
        await sheet.getByTestId('relay-file').setInputFiles({
          name: 'latch-relay.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ version: 2, profile: edge })),
        })
        const card = sheet.getByTestId('relay-candidate')
        await card.getByText(keyHash, { exact: true }).waitFor()
        await card.getByText('已包含', { exact: true }).waitFor()
        expect((await sheet.innerText()).includes(edge.registrationKey)).toBe(false)
        await capture('relays-check-card')
        await card.getByRole('button', { name: '确认并连接' }).click()
        await card.getByText('注册', { exact: true }).waitFor()
        await sheet.getByRole('button', { name: '完成' }).waitFor()
        expect(state.posted).toHaveLength(1)
        expect((state.posted[0] as { profile: unknown }).profile).toEqual(edge)
        await capture('relays-connected')
      } finally {
        await context.close()
      }
    })

  it('shows another admin device the list without any way to change it, and no relays at all as empty', async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '只读设备', scopes: ['admin'] })
      await scripted(page, false, [row('2'.repeat(32), 'connected', { kind: 'edge', latencyMs: 38 })], false)
      await page.reload()
      await connected(page)
      await openEntry(page, '中继')
      await page.getByText('已连接 · 38 ms', { exact: true }).waitFor()
      await page.getByTestId('relay-direct').getByText('未开启').waitFor()
      expect(await page.getByRole('button', { name: '添加中继' }).count()).toBe(0)
      expect(await page.getByRole('button', { name: '更多' }).count()).toBe(0)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.screenshot({ path: `${OUTPUT}/relays-read-only-1100-${colorScheme}.png`, animations: 'disabled' })
      }
    } finally {
      await context.close()
    }
    const empty = await browser.newContext({ viewport: { width: 390, height: 844 } })
    try {
      const page = await empty.newPage()
      await enrollBrowser(page, host, { name: '空的', scopes: ['admin'] })
      await scripted(page, true, [])
      await page.reload()
      await connected(page)
      await openEntry(page, '中继')
      await page.getByRole('button', { name: '添加中继' }).waitFor()
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.screenshot({ path: `${OUTPUT}/relays-empty-390-${colorScheme}.png`, animations: 'disabled' })
      }
    } finally {
      await empty.close()
    }
  })
})
