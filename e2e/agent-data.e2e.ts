import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { expect, it } from 'vitest'
import type { AgentFile, AutomationList, CustomAgent, CustomAgentDetail, CustomAgentList } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const OUT = 'test-results/agent-data'
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const

/** A browser with the full data scope, which Agents need. */
async function fullScopeBrowser(page: Page, host: TestHost, owner: TestDevice, name: string) {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await connected(page)
}
const place = (page: Page, name: 'Code' | '我的 Agent') => page.getByRole('radio', { name, exact: true }).first()
const still = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))))
const shot = async (page: Page, name: string) => {
  await still(page)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

/** An 8-bit RGBA PNG of one colour, with a text chunk the Host must not keep. */
function png(side: number, colour: [number, number, number]): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'latin1')
    body.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  const raw = Buffer.alloc(side * (1 + side * 4))
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) raw.set([...colour, 255], y * (1 + side * 4) + 1 + x * 4)
  const head = Buffer.alloc(13)
  head.writeUInt32BE(side, 0)
  head.writeUInt32BE(side, 4)
  head[8] = 8
  head[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('tEXt', Buffer.from('Comment\0hidden-note', 'latin1')),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
/** A real JPEG, made by the browser itself: the page must decode it and upload pixels. */
const jpeg = async (page: Page): Promise<Buffer> =>
  Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 300
      canvas.height = 200
      const context = canvas.getContext('2d')!
      context.fillStyle = '#2f6f4f'
      context.fillRect(0, 0, 300, 200)
      const blob = await new Promise<Blob>(resolve => {
        canvas.toBlob(made => resolve(made!), 'image/jpeg', 0.9)
      })
      return [...new Uint8Array(await blob.arrayBuffer())]
    }),
  )

/** Opens the Agent's page from 我的 Agent and its 资料 panel. */
async function openProfile(page: Page, agent: CustomAgent, width: number) {
  const phone = width < 768
  if (phone)
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '我的 Agent', exact: true }).click()
  else if (width < 1024)
    await page.getByRole('navigation', { name: '工作台导航', exact: true }).getByRole('button', { name: '我的 Agent', exact: true }).click()
  else await place(page, '我的 Agent').click()
  const roster = page.getByRole('list', { name: '我的 Agent', exact: true })
  await roster.locator(`[data-agent-id="${agent.id}"]`).click()
  const heading = page.locator('.topbar')
  await heading.getByRole('button', { name: `${agent.name} 的资料`, exact: true }).click()
  const profile = phone ? page.getByRole('dialog', { name: agent.name, exact: true }) : page
  const panel = profile.getByRole('region', { name: `${agent.name} 的资料`, exact: true })
  await panel.waitFor()
  return panel
}
/** Agents an import already made, so the next one is told apart from them. */
const seen = new Set<string>()
const create = (owner: TestDevice, name: string) =>
  owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name,
      description: '查资料',
      harnessId: 'standard',
      mode: 'agent',
      instructions: '先给结论',
      skills: [],
    },
  })

it('an Agent is exported to a file after a look at what it holds, and imported from one as a new Agent, at three widths', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch(browserLaunchOptions())
    const owner = await host.enroll({ listener: 'unix' })
    const agent = await create(owner, '资料助手')
    await owner.json(`custom-agents/${agent.id}/memories`, { method: 'POST', body: { requestId: randomUUID(), content: '项目都用 pnpm' } })
    await owner.json(`custom-agents/${agent.id}/memories`, {
      method: 'POST',
      body: { requestId: randomUUID(), content: '密钥是 sk-proj-abcdefghijklmnopqrstuvwxyz0123' },
    })
    await owner.json('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '早报',
        customAgentId: agent.id,
        prompt: '整理昨天的改动',
        schedule: { kind: 'daily', time: '09:00' },
        notify: true,
        enabled: false,
      },
    })
    let exported: AgentFile | undefined
    for (const viewport of WIDTHS)
      for (const scheme of ['light', 'dark'] as const) {
        const phone = viewport.width === 390
        const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce', acceptDownloads: true })
        await stillMotion(context)
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        await fullScopeBrowser(page, host, owner, `数据 ${viewport.width} ${scheme}`)
        const tag = `${viewport.width}-${scheme}`

        // 导出: nothing downloads before the preview says what the file holds and leaves out.
        const panel = await openProfile(page, agent, viewport.width)
        await panel.getByRole('button', { name: '设置', exact: true }).click()
        const section = panel.getByRole('region', { name: '导出', exact: true })
        await section.getByRole('button', { name: '导出', exact: true }).click()
        const preview = section.getByRole('group', { name: '导出前确认', exact: true })
        await expect.poll(() => preview.textContent()).toContain('记忆 1 · 定时 1')
        expect(await preview.textContent()).toContain('像密钥的不导出：记忆 1 条，定时 0 个')
        await preview.scrollIntoViewIfNeeded()
        await noHorizontalOverflow(page)
        await shot(page, `export-preview-${tag}`)
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          preview.getByRole('button', { name: '下载', exact: true }).click(),
        ])
        expect(download.suggestedFilename()).toBe('资料助手.latch-agent.json')
        const file = JSON.parse(await readFile(await download.path(), 'utf8')) as AgentFile
        expect(file).toMatchObject({ format: 'latch-agent', version: 1, agent: { name: '资料助手', instructions: '先给结论' } })
        expect(file.memories.map(memory => memory.content)).toEqual(['项目都用 pnpm'])
        expect(JSON.stringify(file)).not.toContain('sk-proj')
        await expect.poll(() => section.textContent()).toContain('已导出')
        exported ??= file

        // 导入: from the creation page; the preview first, with a Harness this computer does not have.
        if (phone) {
          const sheet = page.getByRole('dialog', { name: agent.name, exact: true })
          await sheet.getByRole('banner').getByRole('button', { name: '关闭', exact: true }).click()
          await sheet.waitFor({ state: 'hidden' })
          await page.locator('.topbar').getByRole('button', { name: '返回', exact: true }).click()
        }
        await page.getByRole('button', { name: '新建 Agent', exact: true }).first().click()
        await page.getByRole('button', { name: '从文件导入', exact: true }).click()
        const chooser = page.getByLabel('选择 Agent 导出文件', { exact: true })
        const upload = (value: unknown, name = 'agent.latch-agent.json') =>
          chooser.setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
        await upload({ ...file, agent: { ...file.agent, harnessId: 'not-installed' } })
        const importPage = page.locator('.agent-import')
        await expect.poll(() => importPage.textContent()).toContain('这台电脑上没有 not-installed')
        expect(await importPage.getByRole('button', { name: '导入', exact: true }).isDisabled()).toBe(true)
        await noHorizontalOverflow(page)
        await shot(page, `import-missing-harness-${tag}`)
        // A file that is not one is refused before anything is shown.
        await upload({ ...file, version: 2 })
        await expect.poll(() => importPage.textContent()).toContain('不能导入')
        // The real file: what it holds, then one write.
        await upload(file)
        await expect.poll(() => importPage.textContent()).toContain('记忆 · 1')
        const text = (await importPage.textContent())!
        for (const words of ['资料助手', '先给结论', '项目都用 pnpm', '文件标注：用户', '定时 · 1', '导入后是关的', '已有同名，会新建一个'])
          expect(text).toContain(words)
        await noHorizontalOverflow(page)
        await shot(page, `import-preview-${tag}`)
        const before = (await owner.json<CustomAgentList>('custom-agents')).agents.length
        await importPage.getByRole('button', { name: '导入', exact: true }).click()
        await page.locator('.agent-frame').first().waitFor()
        const agents = (await owner.json<CustomAgentList>('custom-agents')).agents
        expect(agents).toHaveLength(before + 1)
        const made = agents.find(item => item.name === '资料助手' && item.id !== agent.id && !seen.has(item.id))!
        seen.add(made.id)
        const detail = await owner.json<CustomAgentDetail>(`custom-agents/${made.id}`)
        expect(detail.memories).toEqual([
          expect.objectContaining({ content: '项目都用 pnpm', imported: expect.objectContaining({ origin: 'user' }) }),
        ])
        const schedules = (await owner.json<AutomationList>('automations')).automations.filter(item => item.customAgentId === made.id)
        expect(schedules).toEqual([expect.objectContaining({ name: '早报', enabled: false })])
        // The original is as it was.
        expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).agent.revision).toBe(agent.revision)
        await context.close()
      }
    expect(exported).toBeDefined()
  } finally {
    await browser?.close()
    await host.close()
  }
}, 600_000)

it('a picture takes the face’s place from PNG and JPEG, says why a file cannot be used, and is cleared back to the face', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch(browserLaunchOptions())
    const owner = await host.enroll({ listener: 'unix' })
    const agent = await create(owner, '资料助手')
    const avatarOf = async () => (await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).agent.avatar
    const stored = async () =>
      (await readdir(join(host.dataDir, 'agents', 'avatars')).catch(() => [])).filter(name => name.endsWith('.png'))
    for (const viewport of WIDTHS)
      for (const scheme of ['light', 'dark'] as const) {
        const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' })
        await stillMotion(context)
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        await fullScopeBrowser(page, host, owner, `头像 ${viewport.width} ${scheme}`)
        const tag = `${viewport.width}-${scheme}`
        const panel = await openProfile(page, agent, viewport.width)
        await panel.getByRole('button', { name: '资料助手 的头像', exact: true }).click()
        const row = page.locator('.avatar-picker-row[data-part="picture"]')
        await row.waitFor()
        const choose = (name: string, mimeType: string, buffer: Buffer) =>
          page.getByLabel('选择图片', { exact: true }).setInputFiles({ name, mimeType, buffer })
        await noHorizontalOverflow(page)
        await shot(page, `avatar-row-${tag}`)

        // The honest failures: by what the bytes are, never the name or the declared type.
        await choose('avatar.png', 'image/png', Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000', 'latin1'))
        await expect.poll(() => row.textContent()).toContain('只能用 PNG、JPEG 或 WebP')
        await shot(page, `avatar-wrong-type-${tag}`)
        await choose(
          'avatar.png',
          'image/png',
          Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<html>')]),
        )
        await expect.poll(() => row.textContent()).toContain('读不了这张图片')
        await shot(page, `avatar-unreadable-${tag}`)
        await choose('big.png', 'image/png', Buffer.concat([png(16, [0, 0, 0]), Buffer.alloc(10 * 1024 * 1024 + 1)]))
        await expect.poll(() => row.textContent()).toContain('图片太大')
        await shot(page, `avatar-too-large-${tag}`)
        expect((await avatarOf()).kind).toBe('face')

        // A PNG, then a JPEG in its place: each shows only once the Host has it, as the Host's own picture.
        await choose('face.png', 'image/png', png(64, [200, 40, 40]))
        await expect.poll(async () => (await avatarOf()).kind).toBe('image')
        const first = await avatarOf()
        await expect.poll(() => row.textContent()).toContain('换一张')
        await expect.poll(() => page.locator('.avatar-picker-preview svg[data-picture]').count()).toBe(1)
        const [name] = await stored()
        const bytes = await readFile(join(host.dataDir, 'agents', 'avatars', name!))
        expect(bytes.includes(Buffer.from('hidden-note'))).toBe(false)
        expect(bytes.readUInt32BE(16)).toBe(256)
        await shot(page, `avatar-picture-${tag}`)
        await choose('photo.jpg', 'image/jpeg', await jpeg(page))
        await expect.poll(async () => JSON.stringify(await avatarOf())).not.toBe(JSON.stringify(first))
        expect((await avatarOf()).kind).toBe('image')
        await expect.poll(async () => (await stored()).length).toBe(1)
        // Nothing of the page carries the picture as a data URL. The input's editor (CodeMirror) injects its own base
        // stylesheet, which draws a tab mark as an SVG data URL; that sheet alone is set aside.
        expect(
          await page.evaluate(() => {
            const copy = document.documentElement.cloneNode(true) as HTMLElement
            const editorSheets = [...copy.querySelectorAll('style')].filter(sheet => /\.cm-[a-z]/iu.test(sheet.textContent ?? ''))
            for (const sheet of editorSheets) sheet.remove()
            return {
              editorSheets: editorSheets.length <= 1,
              picture: /data:image\/(?:png|jpe?g|webp)/iu.test(document.documentElement.innerHTML),
              dataImage: copy.innerHTML.includes('data:image'),
            }
          }),
        ).toEqual({ editorSheets: true, picture: false, dataImage: false })

        // 清除: the face again, the one it had.
        await row.getByRole('button', { name: '清除', exact: true }).click()
        await expect.poll(async () => await avatarOf()).toEqual(agent.avatar)
        await expect.poll(async () => (await stored()).length).toBe(0)
        await expect.poll(() => page.locator('.avatar-picker-preview svg[data-picture]').count()).toBe(0)
        await context.close()
      }
  } finally {
    await browser?.close()
    await host.close()
  }
}, 600_000)
