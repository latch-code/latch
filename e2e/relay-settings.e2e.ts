import { createHash } from 'node:crypto'
import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Device, NativeLinkInfo, NativeRelayFile, NativeRelayTest } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openEntry } from './helpers/layout.ts'

/**
 * 设置 › 连接转发 against a scripted Host: every state a relay row has, 添加转发服务 through a relay file with the check card and
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
const self = {
  url: 'https://relay.example/',
  relayId: 'a'.repeat(32),
  spkiHash: 'b'.repeat(64),
  registrationKey: edge.registrationKey,
}
const keyHash = self.spkiHash.slice(0, 8)
const edgeHash = createHash('sha256').update(Buffer.from(edge.relayKey, 'hex')).digest('hex').slice(0, 8)
const fileIdentity = 'a'.repeat(64)
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
  row('2'.repeat(32), 'connected', { latencyMs: 38, connectedAt: Date.UTC(2026, 10, 18, 2) }),
  row('3'.repeat(32), 'mismatch'),
  row('4'.repeat(32), 'waiting', { retryAt: Date.UTC(2026, 10, 18, 3) }),
  row('5'.repeat(32), 'disabled'),
  row('6'.repeat(32), 'unsupported', { kind: 'edge' }),
  row('7'.repeat(32), 'invalid'),
]

async function scripted(page: Page, local: boolean, relays: Relay[], listening = true, localNetwork?: NativeLinkInfo['localNetwork']) {
  const files: NativeRelayFile[] = [
    {
      name: 'home',
      source: 'legacy',
      relayId: edge.relayId,
      fileIdentity,
      kind: 'edge',
      urls: [edge.url],
      keyHash: edgeHash,
      hasRegistrationKey: true,
    },
  ]
  const state = {
    relays,
    files,
    fileReads: 0,
    dropAddResponse: false,
    posted: [] as unknown[],
    patched: [] as unknown[],
    deleted: [] as string[],
  }
  const receipts = new Map<string, string>()
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
    edgeRelayAvailable: true,
    ...(localNetwork ? { localNetwork } : {}),
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
  await page.route('**/link/api/native/relay-files', route => {
    state.fileReads++
    return route.fulfill({ json: { files: state.files.filter(file => !state.relays.some(relay => relay.relayId === file.relayId)) } })
  })
  await page.route('**/link/api/native/relays', route => {
    const body = route.request().postDataJSON()
    state.posted.push(body)
    const receipt = receipts.get(body.requestId)
    if (receipt) return route.fulfill({ json: { ...info(), addedRelayId: receipt } })
    const node = body.file || body.profile?.relayId === edge.relayId ? edge : self
    const added = row(node.relayId, 'connected', {
      url: node.url,
      kind: 'kind' in node ? 'edge' : 'self',
      keyHash: node === edge ? edgeHash : keyHash,
      latencyMs: 41,
    })
    // The new row can be anywhere in a response containing other concurrent registrations.
    state.relays = [added, ...state.relays]
    receipts.set(body.requestId, added.relayId)
    if (state.dropAddResponse) return route.abort()
    return route.fulfill({ status: 201, json: { ...info(), addedRelayId: added.relayId } })
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

describe('设置 › 连接转发', () => {
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
        await openEntry(page, '连接转发')
        const capture = async (name: string) => {
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
            await page.waitForTimeout(500)
            await page.screenshot({ path: `${OUTPUT}/${name}-${size.label}-${colorScheme}.png`, animations: 'disabled' })
          }
          await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
        }
        const listening = page.getByTestId('relay-direct').getByText('已开启', { exact: true })
        await listening.waitFor()
        expect(await listening.getAttribute('data-tone')).toBe('neutral')
        for (const word of ['连接中', '已连接 · 38 ms', '密钥不符', '连不上', '已停用', '尚未实现', '地址无效'])
          await page.getByText(word, { exact: true }).first().waitFor()
        await expect.poll(() => page.getByText('官方转发服务').count()).toBe(0)
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
        await page.getByRole('menuitem', { name: '从这台 Mac 移除' }).last().click()
        await expect.poll(() => state.deleted).toEqual(['5'.repeat(32)])
        // A saved address outside the book's grammar can only be removed.
        await page.getByTestId('relay-own').filter({ hasText: '地址无效' }).getByRole('button', { name: '更多' }).click()
        await page.getByRole('menuitem', { name: '从这台 Mac 移除' }).last().waitFor()
        expect(await page.getByRole('menuitem', { name: '测试' }).count()).toBe(0)
        expect(await page.getByRole('menuitem', { name: '启用' }).count()).toBe(0)
        await page.keyboard.press('Escape')

        // 添加转发服务 › 已有配置文件: a file that is not one is refused; a good one shows the check card, never the token.
        await page.getByRole('button', { name: '添加转发服务' }).click()
        const sheet = page.locator('.relay-add-dialog')
        await sheet.getByTestId('relay-ways').waitFor()
        await capture('relays-add-ways')
        expect(await sheet.getByRole('button', { name: /Cloudflare Workers/u }).getAttribute('aria-disabled')).toBeNull()
        // Cloudflare Workers: a name and a location of the person's own, one latch command, then the file the Host found.
        await sheet.getByRole('button', { name: /Cloudflare Workers/u }).click()
        await sheet.getByText('pnpm latch relay setup cloudflare --name relay', { exact: true }).waitFor()
        await sheet.getByLabel('名称').fill('home')
        await sheet.getByText('pnpm latch relay setup cloudflare --name home', { exact: true }).waitFor()
        expect(await sheet.getByText(/东京|新加坡|relay-edge/u).count()).toBe(0)
        const found = sheet.getByTestId('relay-found')
        await found.getByText(edgeHash, { exact: true }).waitFor()
        await capture('relays-cloudflare')
        await found.getByRole('button', { name: '核对并连接' }).click()
        await sheet.getByTestId('relay-candidate').getByText('已包含', { exact: true }).waitFor()
        await capture('relays-check-card-found')
        await sheet.getByTestId('relay-candidate').getByRole('button', { name: '确认并连接' }).click()
        await sheet.getByRole('button', { name: '完成' }).click()
        // The Host reads the named legacy file and verifies its ID; the page only submits the selection.
        expect(state.posted.at(-1)).toMatchObject({ file: 'home', fileSource: 'legacy', fileRelayId: edge.relayId, fileIdentity })
        expect(state.posted.at(-1)).not.toHaveProperty('profile')
        state.posted.length = 0
        // 自己的服务器: the form's answers become the commands.
        await page.getByRole('button', { name: '添加转发服务' }).click()
        await sheet.getByRole('button', { name: '自己的服务器' }).click()
        await sheet.getByLabel('服务器', { exact: true }).fill('me@relay.example.com')
        await sheet.getByLabel('服务器地址').fill('relay.example.com')
        await sheet.getByLabel('证书链').fill('/etc/ssl/relay/fullchain.pem')
        await sheet.getByLabel('私钥').fill('/etc/ssl/relay/key.pem')
        await sheet.getByText(/pnpm relay init --data-dir \/srv\/latch-relay --domain relay\.example\.com --port 8443/u).waitFor()
        await capture('relays-server')
        await sheet.getByRole('button', { name: '返回', exact: true }).click()
        await sheet.getByRole('button', { name: '已有配置文件' }).click()
        await sheet
          .getByTestId('relay-file')
          .setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"version":9}') })
        await sheet.getByText('请选择由转发服务导出的连接配置。').waitFor()
        await capture('relays-file-rejected')
        await sheet.getByTestId('relay-file').setInputFiles({
          name: 'latch-relay.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ version: 2, profile: edge })),
        })
        // A Workers relay file shows its relay key's short hash, the one the Mac's confirmation sheet shows.
        await sheet.getByTestId('relay-candidate').getByText(edgeHash, { exact: true }).waitFor()
        await capture('relays-check-card-edge')
        // Back to the ways and the file step again: the check card replaced it.
        await sheet.getByRole('button', { name: '返回', exact: true }).click()
        await sheet.getByRole('button', { name: '已有配置文件' }).click()
        await sheet.getByTestId('relay-file').setInputFiles({
          name: 'underscore.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ version: 1, profile: { ...self, url: 'https://a_b.example/' } })),
        })
        await sheet.getByText('请选择由转发服务导出的连接配置。').waitFor()
        await sheet.getByTestId('relay-file').setInputFiles({
          name: 'latch-relay.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ version: 1, profile: self })),
        })
        const card = sheet.getByTestId('relay-candidate')
        await card.getByText(keyHash, { exact: true }).waitFor()
        await card.getByText('已包含', { exact: true }).waitFor()
        expect((await sheet.innerText()).includes(self.registrationKey)).toBe(false)
        await capture('relays-check-card')
        await card.getByRole('button', { name: '确认并连接' }).click()
        await card.getByText('注册', { exact: true }).waitFor()
        await sheet.getByRole('button', { name: '完成' }).waitFor()
        expect(state.posted).toHaveLength(1)
        expect(state.posted[0]).toMatchObject({ profile: self, saveFile: true })
        await capture('relays-connected')
      } finally {
        await context.close()
      }
    })

  it('manages a discovered Worker on this Mac from the main list and can reconnect it from its preserved file', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '本机 Workers', scopes: ['admin'] })
      const state = await scripted(page, true, [])
      await page.reload()
      await connected(page)
      await openEntry(page, '连接转发')
      const localFile = page.getByTestId('relay-local-file')
      await localFile.getByText('未添加', { exact: true }).waitFor()
      const address = localFile.getByText(new URL(edge.url).host, { exact: false }).first()
      await address.waitFor()
      const details = await address.boundingBox()
      const review = localFile.getByRole('button', { name: '核对并连接' })
      const action = await review.boundingBox()
      expect(details).not.toBeNull()
      expect(action).not.toBeNull()
      expect(action!.y).toBeGreaterThanOrEqual(details!.y + details!.height)
      expect(state.posted).toEqual([])
      expect(await page.getByTestId('relay-own').count()).toBe(0)
      const sheet = page.locator('.relay-add-dialog')
      await review.click()
      await sheet.getByTestId('relay-candidate').getByText(edgeHash, { exact: true }).waitFor()
      expect(state.posted).toHaveLength(0)
      await sheet.getByRole('button', { name: '关闭', exact: true }).click()
      await localFile.getByRole('button', { name: '更多' }).click()
      await page.getByRole('menuitem', { name: '从列表隐藏' }).click()
      await localFile.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: '添加转发服务' }).click()
      await sheet.getByRole('button', { name: '已有配置文件' }).click()
      await sheet.getByTestId('relay-found').getByRole('button', { name: '核对并连接' }).click()
      await sheet.getByTestId('relay-candidate').getByText(edgeHash, { exact: true }).waitFor()
      await sheet.getByRole('button', { name: '确认并连接' }).click()
      await sheet.getByRole('button', { name: '完成' }).click()
      expect(state.posted).toEqual([
        { requestId: expect.any(String), file: 'home', fileSource: 'legacy', fileRelayId: edge.relayId, fileIdentity },
      ])
      const added = page.getByTestId('relay-own')
      await added.getByText('Cloudflare Workers', { exact: true }).waitFor()
      await added.getByRole('button', { name: '更多' }).click()
      await page.getByRole('menuitem', { name: '停用' }).click()
      await added.getByText('已停用', { exact: true }).waitFor()
      await added.getByRole('button', { name: '更多' }).click()
      await page.getByRole('menuitem', { name: '启用' }).click()
      await added.getByText('连接中', { exact: true }).waitFor()
      await added.getByRole('button', { name: '更多' }).click()
      await page.getByRole('menuitem', { name: '从这台 Mac 移除' }).click()
      await added.waitFor({ state: 'detached' })
      await page.reload()
      await connected(page)
      await openEntry(page, '连接转发')
      await page.getByRole('button', { name: '添加转发服务' }).click()
      await sheet.getByRole('button', { name: '已有配置文件' }).click()
      await sheet.getByTestId('relay-found').getByText(edgeHash, { exact: true }).waitFor()
      expect(await localFile.count()).toBe(0)
      expect(state.deleted).toEqual([edge.relayId])
      expect(state.patched).toEqual([
        { id: edge.relayId, disabled: true },
        { id: edge.relayId, disabled: false },
      ])
      expect(state.posted).toHaveLength(1)
    } finally {
      await context.close()
    }
  })

  it('shows a recovered add receipt without reviving a relay removed in the meantime', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '中继回执', scopes: ['admin'] })
      const state = await scripted(page, true, [])
      state.dropAddResponse = true
      await page.reload()
      await connected(page)
      await openEntry(page, '连接转发')

      const localFile = page.getByTestId('relay-local-file')
      await localFile.getByRole('button', { name: '核对并连接' }).click()
      const sheet = page.locator('.relay-add-dialog')
      const candidate = sheet.getByTestId('relay-candidate')
      await candidate.getByRole('button', { name: '确认并连接' }).click()
      await candidate.getByText('添加结果待确认', { exact: true }).waitFor()
      expect(state.relays.map(relay => relay.relayId)).toEqual([edge.relayId])
      state.relays = []
      await sheet.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('button', { name: '添加转发服务' }).click()
      await candidate.getByRole('button', { name: '重试', exact: true }).click()
      await candidate.getByText('本次添加已完成。该转发服务已从这台 Mac 移除。', { exact: true }).waitFor()
      expect(await candidate.locator('.relay-steps').count()).toBe(0)
      const { requestId } = state.posted[0] as { requestId: string }
      expect(state.posted).toEqual([
        { requestId, file: 'home', fileSource: 'legacy', fileRelayId: edge.relayId, fileIdentity },
        { requestId },
      ])

      await sheet.getByRole('button', { name: '完成' }).click()
      expect(await page.getByTestId('relay-own').count()).toBe(0)
      await page.getByRole('button', { name: '添加转发服务' }).click()
      await sheet.getByRole('button', { name: '已有配置文件' }).click()
      await sheet.getByTestId('relay-found').getByText(edgeHash, { exact: true }).waitFor()
      expect(await localFile.count()).toBe(0)
    } finally {
      await context.close()
    }
  })

  it('says 本地网络未允许 on the direct row: a button in the desktop app, the settings path in a browser', async () => {
    const shots = process.env.LATCH_LOCAL_NETWORK_SHOTS ?? OUTPUT
    await mkdir(shots, { recursive: true })
    for (const [local, place] of [
      [true, 'app'],
      [false, 'browser'],
    ] as const)
      for (const width of [390, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } })
        try {
          const page = await context.newPage()
          await enrollBrowser(page, host, { name: `本地网络-${place}-${width}`, scopes: ['admin'] })
          await scripted(page, local, [], true, 'denied')
          await page.reload()
          await connected(page)
          await openEntry(page, '连接转发')
          const hint = page.getByTestId('local-network-hint')
          await hint.getByText('本地网络未允许').waitFor()
          if (local) {
            const open = page.getByRole('link', { name: '打开系统设置' })
            expect(await open.getAttribute('href')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork')
          } else {
            await hint.getByText('系统设置 › 隐私与安全性 › 本地网络').waitFor()
            expect(await page.getByRole('link', { name: '打开系统设置' }).count()).toBe(0)
          }
          await hint.getByText('corepack pnpm desktop', { exact: true }).waitFor({ state: 'visible' })
          await hint.getByText(/先停止同一数据目录的 Latch 服务。关窗口后它仍会运行。/u).waitFor({ state: 'visible' })
          expect(await page.getByTestId('relay-direct').count()).toBe(0)
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme })
            await page.screenshot({ path: `${shots}/local-network-${place}-${width}-${colorScheme}.png`, animations: 'disabled' })
          }
        } finally {
          await context.close()
        }
      }
  })

  it('shows another admin device the list without any way to change it, and no relays at all as empty', async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '只读设备', scopes: ['admin'] })
      const state = await scripted(page, false, [row('2'.repeat(32), 'connected', { latencyMs: 38 })], false)
      await page.reload()
      await connected(page)
      await openEntry(page, '连接转发')
      await page.getByText('已连接 · 38 ms', { exact: true }).waitFor()
      await page.getByTestId('relay-direct').getByText('未开启').waitFor()
      expect(await page.getByRole('button', { name: '添加转发服务' }).count()).toBe(0)
      expect(await page.getByRole('button', { name: '更多' }).count()).toBe(0)
      expect(state.fileReads).toBe(0)
      expect(await page.getByTestId('relay-local-file').count()).toBe(0)
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
      const state = await scripted(page, true, [])
      state.files = []
      await page.reload()
      await connected(page)
      await openEntry(page, '连接转发')
      await page.getByRole('button', { name: '添加转发服务' }).waitFor()
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.screenshot({ path: `${OUTPUT}/relays-empty-390-${colorScheme}.png`, animations: 'disabled' })
      }
    } finally {
      await empty.close()
    }
  })
})
