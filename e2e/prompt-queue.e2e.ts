import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { closeSettings, noHorizontalOverflow, openSection, openSession, openSettings, reachable } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64')

describe('queued follow-ups', () => {
  it('queues and edits during work, drains after success, parks at stop, resumes explicitly and displays dropped authority', async () => {
    const releases = new Map<string, () => void>(),
      calls: string[] = []
    const provider: ModelProvider = {
      id: 'queue-browser-model',
      name: '测试模型',
      model: 'fake',
      async *stream({ messages, signal }) {
        const prompt = messages.at(-1)?.content ?? ''
        calls.push(prompt)
        yield { type: 'text', text: `正在处理：${prompt}` }
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          if (signal.aborted) {
            abort()
            return
          }
          signal.addEventListener('abort', abort, { once: true })
          releases.set(prompt, () => {
            signal.removeEventListener('abort', abort)
            resolve()
          })
        })
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const plugin: HarnessPlugin = {
      id: 'queue-browser-fixture',
      name: '排队测试',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider(provider)
      },
    }
    const host = await startTestHost({ plugins: [plugin], providerId: provider.id }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      for (const width of [1440, 768, 390]) {
        const first = `排队会话 ${width}`,
          edited = `编辑后的下一句 ${width}`,
          second = `再下一句 ${width}`
        const created = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { prompt: first, requestId: randomUUID() },
        })
        const path = `tasks/${created.sessionId}`
        await expect.poll(() => calls.includes(first)).toBe(true)
        const context = await browser.newContext({
            viewport: { width, height: 960 },
            hasTouch: width === 390,
            reducedMotion: width === 768 ? 'no-preference' : 'reduce',
            colorScheme: width === 390 ? 'dark' : 'light',
          }),
          page = await context.newPage()
        await enrollBrowser(page, host, { name: `排队 ${width}` })
        const deviceId = await page.evaluate(
          async () => ((await (await fetch('/link/api/snapshot')).json()) as { device: { id: string } }).device.id,
        )
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(first)
        await palette.getByRole('option', { name: first, exact: true }).click()
        const input = page.getByRole('textbox', { name: '继续对话', exact: true }),
          tray = page.getByRole('region', { name: '排队发送', exact: true })
        const enqueue = async (text: string, byShortcut = false) => {
          await input.fill(text)
          const reply = page.waitForResponse(
            response =>
              response.request().method() === 'POST'
              && response.url().endsWith(`${path}/prompt`)
              && response.request().postDataJSON()?.prompt === text,
          )
          if (byShortcut) await input.press('Control+Shift+Enter')
          else await page.getByRole('button', { name: '排队发送', exact: true }).click()
          expect((await reply).status()).toBe(202)
        }
        await enqueue(`下一句 ${width}`, width === 1440)
        await tray.getByText(`下一句 ${width}`, { exact: true }).waitFor()
        await enqueue(second)
        await expect.poll(() => tray.locator('.prompt-queue-title').textContent()).toBe('接下来 · 2')
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue?.length).toBe(2)
        await input.fill(`仍在输入的草稿 ${width}`)
        await tray.getByRole('button', { name: '编辑', exact: true }).first().click()
        const composer = page.locator('form.composer:visible'),
          editInput = composer.getByRole('textbox')
        await expect.poll(() => promptValue(editInput)).toBe(`下一句 ${width}`)
        await editInput.fill(edited)
        await composer.getByRole('button', { name: /^保存/u }).click()
        await tray.getByText(edited, { exact: true }).waitFor()
        const rows = tray.getByRole('listitem')
        const grip = rows.nth(1).getByRole('button', { name: '调整顺序', exact: true })
        if (width === 1440) {
          await grip.dragTo(rows.first())
        } else {
          if (width === 768) await grip.press('Enter')
          else await grip.tap()
          const up = page.getByRole('menuitem', { name: '上移', exact: true })
          if (width === 768) await up.press('Enter')
          else await up.tap()
        }
        await expect.poll(() => rows.locator('.prompt-queue-text').allTextContents()).toEqual([second, edited])
        expect(await promptValue(input)).toBe(`仍在输入的草稿 ${width}`)
        expect((await owner.json<TaskDetail>(path)).queue?.map(item => item.text)).toEqual([second, edited])
        expect(await tray.getByRole('button', { name: '立即发送' }).count()).toBe(0)
        await input.fill('')
        await page.screenshot({ path: `test-results/queue-waiting-${width}.png`, fullPage: true })
        await page.emulateMedia({ colorScheme: width === 390 ? 'light' : 'dark' })
        await page.screenshot({ path: `test-results/queue-waiting-${width}-alternate.png`, fullPage: true })
        await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
        releases.get(first)!()
        await expect.poll(() => calls.includes(second)).toBe(true)
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue?.map(item => item.text)).toEqual([edited])
        await page.getByRole('button', { name: '停止', exact: true }).click()
        await tray.getByText('已暂停 · 请确认后发送', { exact: true }).waitFor()
        await page.screenshot({ path: `test-results/queue-parked-${width}.png`, fullPage: true })
        await tray.getByRole('button', { name: '发送', exact: true }).click()
        await expect.poll(() => calls.includes(edited)).toBe(true)
        await enqueue(`暂时不用 ${width}`)
        await tray.getByRole('button', { name: '移除', exact: true }).click()
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue).toEqual([])
        await enqueue(`权限改变后不发送 ${width}`)
        await tray.getByText(`权限改变后不发送 ${width}`, { exact: true }).waitFor()
        await owner.json(`devices/${deviceId}`, { method: 'PATCH', body: { scopes: ['view'] } })
        releases.get(edited)!()
        await tray.getByText('未发送 · 请检查排队内容', { exact: true }).waitFor()
        await page.screenshot({ path: `test-results/queue-dropped-${width}.png`, fullPage: true })
        expect(calls).not.toContain(`权限改变后不发送 ${width}`)
        const final = await owner.json<TaskDetail>(path)
        expect(final.messages.find(message => message.text === edited)?.queuedAt).toEqual(expect.any(String))
        await owner.json(`${path}/queue/${final.queue![0]!.id}`, { method: 'DELETE' })
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })
  it('restores queued attachments after reload, isolates edits from the current draft and delivers the saved files once', async () => {
    const first = '先等待界面草稿'
    const follow = '下一轮按图检查按钮'
    let release = () => {}
    const finish = new Promise<void>(resolve => {
      release = resolve
    })
    const seen: Array<{ text: string; images: string[] }> = []
    const host = await startTestHost({
      providerId: 'queue-vision',
      plugins: [
        {
          id: 'queued-image-fixture',
          name: '排队图片测试',
          version: '1',
          description: '',
          activate(ctx) {
            ctx.registerProvider({
              id: 'queue-vision',
              name: 'Vision fixture',
              model: 'fixture',
              modelCapabilities: { fixture: { vision: true } },
              async *stream({ messages }) {
                const last = messages.at(-1)!
                seen.push({ text: last.content, images: (last.attachments ?? []).flatMap(a => (a.type === 'image' ? [a.data] : [])) })
                if (last.content === first) {
                  await finish
                }
                yield { type: 'text', text: '已核对' }
                yield { type: 'finish', reason: 'stop' }
              },
            })
          },
        },
      ],
    })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'dark' })
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, host, { name: '排队截图' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: first, requestId: randomUUID() },
      })
      await expect.poll(() => seen.length).toBe(1)
      await openSession(page, sessionId)
      const composer = page.locator('form.composer:visible')
      const screenshots = await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 128
        canvas.height = 80
        const draw = canvas.getContext('2d')!
        return ['#315568', '#467147'].map(background => {
          draw.fillStyle = background
          draw.fillRect(0, 0, canvas.width, canvas.height)
          draw.fillStyle = 'white'
          draw.fillRect(12, 20, 72, 8)
          draw.fillRect(12, 48, 100, 4)
          return canvas.toDataURL('image/png').split(',')[1]!
        })
      })
      const attach = async (names: string[], count: number) => {
        await composer.getByLabel('选择附件', { exact: true }).setInputFiles(
          names.map(name => ({
            name,
            mimeType: 'image/png',
            buffer: Buffer.from(screenshots[name === 'after.png' ? 1 : 0]!, 'base64'),
          })),
        )
        await expect.poll(() => composer.locator('.attachment-draft[data-state="ready"]').count()).toBe(count)
      }
      const remove = (name: string) => composer.getByRole('button', { name: `移除附件 ${name}`, exact: true })
      const input = composer.getByRole('textbox')
      const save = composer.getByRole('button', { name: /^保存/u })
      const cancel = composer.getByRole('button', { name: /^取消/u })
      await attach(['button.png', 'before.png'], 2)
      await composer.getByRole('button', { name: '排队发送', exact: true }).click()
      const queue = page.getByRole('region', { name: '排队发送', exact: true })
      const edit = queue.getByRole('button', { name: '编辑', exact: true })
      await queue.getByText('2 个附件').waitFor()
      await page.reload()
      await queue.getByText('2 个附件').waitFor()
      const draft = '这是还没排队的草稿'
      await input.fill(draft)
      await attach(['draft.png'], 1)
      await edit.click()
      await remove('button.png').waitFor()
      await remove('before.png').waitFor()
      await expect
        .poll(() =>
          composer
            .locator('.attachment-draft img')
            .evaluateAll(images => images.filter(img => img instanceof HTMLImageElement && img.naturalWidth === 128).length),
        )
        .toBe(2)
      expect(await promptValue(input)).toBe('')
      expect(await remove('draft.png').count()).toBe(0)
      await remove('before.png').click()
      const [uploaded] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/link/api/attachments')),
        attach(['temporary.png'], 2),
      ])
      const { attachment: temporary } = (await uploaded.json()) as { attachment: { id: string } }
      await input.fill('取消这次修改')
      const [released] = await Promise.all([
        page.waitForResponse(
          response => response.request().method() === 'DELETE' && response.url().endsWith(`/attachments/${temporary.id}`),
        ),
        cancel.click(),
      ])
      expect(released.ok()).toBe(true)
      await expect.poll(() => promptValue(input)).toBe(draft)
      await remove('draft.png').waitFor()
      await edit.click()
      await remove('before.png').click()
      await attach(['after.png'], 2)
      expect(await promptValue(input)).toBe('')
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
      ] as const) {
        await page.setViewportSize({ width, height })
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await reachable(save)
          await reachable(cancel)
          await noHorizontalOverflow(page, composer)
          await page.screenshot({ path: `test-results/queue-edit-${width}-${colorScheme}.png`, animations: 'disabled' })
        }
      }
      const changes: Array<{ body: unknown; status: number }> = []
      const path = `**/tasks/${sessionId}/queue/*`
      await page.route(path, async route => {
        if (route.request().method() !== 'PATCH') return route.continue()
        const response = await route.fetch()
        changes.push({ body: route.request().postDataJSON(), status: response.status() })
        if (changes.length === 1) return route.abort('connectionreset')
        return route.fulfill({ response })
      })
      await save.click()
      const retry = composer.getByRole('button', { name: '重试保存', exact: true })
      await retry.waitFor()
      expect(await input.isEditable()).toBe(false)
      expect(await remove('after.png').isDisabled()).toBe(true)
      await retry.click()
      await expect.poll(() => promptValue(input)).toBe(draft)
      expect(changes).toHaveLength(2)
      expect(changes[0]!.status).toBe(200)
      expect(changes[1]).toEqual(changes[0])
      await page.unroute(path)
      await remove('draft.png').waitFor()
      await edit.click()
      await remove('button.png').waitFor()
      await remove('after.png').waitFor()
      expect(await remove('before.png').count()).toBe(0)
      await input.fill(follow)
      await save.click()
      await expect.poll(() => promptValue(input)).toBe(draft)
      expect(seen).toHaveLength(1)
      release()
      await expect.poll(() => seen.slice(1)).toEqual([{ text: follow, images: screenshots }])
      const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
      await expect.poll(async () => (await detail()).queue ?? []).toEqual([])
      const delivered = (await detail()).messages.filter(message => message.queuedAt)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.attachments?.map(file => file.name)).toEqual(['button.png', 'after.png'])
    } finally {
      release()
      await browser.close()
      await host.close()
    }
  })

  it('sends an attachment from the queue or composer into the live turn and preserves other queued messages and drafts', async () => {
    const host = await startTestHost()
    const log = join(host.root, 'agent.jsonl')
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: {
          id: 'steer-agent',
          name: 'Steer fixture',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_CAPS: 'steer,steerAttachments,images', FAKE_ACP_LOG: log },
        },
      })
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      })
      await enrollBrowser(page, host, { name: '队列追加' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'steer-agent', prompt: 'steerable hold', requestId: randomUUID() },
      })
      const path = `tasks/${sessionId}`
      const detail = () => owner.json<TaskDetail>(path)
      await expect.poll(async () => (await detail()).steerAttachments).toBe(true)
      const runId = (await detail()).summary.runId
      const earlier = '下一轮再看',
        now = '先看这个问题'
      await openSession(page, sessionId)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const tray = page.getByRole('region', { name: '排队发送', exact: true })
      const composer = page.locator('form.composer:visible')
      const send = composer.locator('.composer-slot').getByRole('button', { name: '立即发送', exact: true })
      const queue = composer.locator('.composer-slot').getByRole('button', { name: '排队发送', exact: true })
      const menu = page.getByRole('menu', { name: '选择发送方式' })
      const sendChoice = menu.getByRole('menuitem', { name: '立即发送', exact: true })
      const queueChoice = menu.getByRole('menuitem', { name: '排队发送', exact: true })
      const mac = await page.evaluate(() => navigator.platform.startsWith('Mac'))
      const menuKeys = async () => {
        await menu.waitFor()
        expect(await menu.getByRole('menuitem').count()).toBe(2)
        const keys = await Promise.all([sendChoice.locator('kbd').allInnerTexts(), queueChoice.locator('kbd').allInnerTexts()])
        return keys.map(caps => caps.join(' · '))
      }
      const promptResponse = () =>
        page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${path}/prompt`))
      const attach = async () => {
        await composer.getByLabel('选择附件', { exact: true }).setInputFiles({ name: 'button.png', mimeType: 'image/png', buffer: image })
        await expect.poll(() => composer.locator('.attachment-draft[data-state="ready"]').count()).toBe(1)
      }
      await attach()
      await input.fill(earlier)
      await send.hover()
      expect(await menuKeys()).toEqual(['Enter', mac ? '⇧⌘⏎' : 'Ctrl Shift Enter'])
      await queueChoice.click()
      await expect.poll(async () => (await detail()).queue?.map(item => [item.text, item.attachmentCount])).toEqual([[earlier, 1]])
      await input.fill(now)
      const settings = await openSettings(page)
      await openSection(settings, '通用')
      await settings.getByRole('radiogroup', { name: '运行中默认发送方式' }).getByRole('radio', { name: '排队', exact: true }).click()
      await closeSettings(settings)
      await queue.hover()
      expect(await menuKeys()).toEqual([mac ? '⇧⌘⏎' : 'Ctrl Shift Enter', 'Enter'])
      const menuBox = (await menu.boundingBox())!
      const trigger = (await queue.boundingBox())!
      await page.screenshot({
        path: 'test-results/queue-send-menu-default.png',
        animations: 'disabled',
        clip: { x: menuBox.x - 12, y: menuBox.y - 12, width: menuBox.width + 24, height: trigger.y + trigger.height - menuBox.y + 24 },
      })
      await input.click()
      const shortcuts = await openSettings(page)
      await openSection(shortcuts, '快捷键')
      const bind = async (action: string, chord: string, label: RegExp) => {
        const edit = shortcuts.getByRole('button', { name: `改「${action}」的快捷键`, exact: true })
        await edit.click()
        await shortcuts.getByRole('status').getByText('按下新的组合键').waitFor()
        await page.keyboard.press(chord)
        await expect.poll(() => edit.locator('kbd').last().innerText()).toMatch(label)
      }
      const queueChord = 'Control+Alt+KeyG'
      const directChord = 'Control+Shift+KeyY'
      await bind('立即发送', directChord, /Y$/u)
      await bind('排队发送', queueChord, /G$/u)
      await closeSettings(shortcuts)
      await page.reload()
      await openSession(page, sessionId)
      await attach()
      await input.fill(now)
      await queue.waitFor()
      const [queuedResponse] = await Promise.all([promptResponse(), input.press(queueChord)])
      expect(queuedResponse.status()).toBe(202)
      expect(queuedResponse.request().postDataJSON()).toMatchObject({ queue: true, prompt: now, attachmentIds: [expect.any(String)] })
      await expect.poll(async () => (await detail()).queue?.map(item => item.text)).toEqual([earlier, now])
      const row = tray.getByRole('listitem').filter({ hasText: now })
      await input.fill('还在写的草稿')
      await row.getByRole('button', { name: '立即发送' }).waitFor()
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
      ] as const) {
        await page.setViewportSize({ width, height })
        await page.emulateMedia({ colorScheme: width === 768 ? 'light' : 'dark' })
        await row.getByRole('button', { name: '立即发送', exact: true }).click({ trial: true })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await page.screenshot({ path: `test-results/queue-steer-${width}.png`, animations: 'disabled' })
      }
      const [steered] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/steer')),
        row.getByRole('button', { name: '立即发送' }).click(),
      ])
      expect(steered.status()).toBe(200)
      expect(steered.request().postDataJSON()).toEqual({ runId, contentRevision: 0 })
      await expect
        .poll(async () => (await detail()).messages.filter(message => message.steered).map(message => message.text))
        .toEqual([now])
      const after = await detail()
      expect(after.summary).toMatchObject({ status: 'running', runId })
      expect(after.queue?.map(item => item.text)).toEqual([earlier])
      expect(after.messages.find(message => message.steered)).toMatchObject({
        queuedAt: expect.any(String),
        attachments: [{ name: 'button.png' }],
      })
      expect(await promptValue(input)).toBe('还在写的草稿')
      await input.fill('')
      await attach()
      await queue.hover()
      expect(await menuKeys()).toEqual([
        expect.stringContaining(mac ? '⇧⌘Y' : 'Ctrl Shift Y'),
        expect.stringContaining(mac ? '⌥⌘G' : 'Ctrl Alt G'),
      ])
      await page.screenshot({ path: 'test-results/queue-send-menu.png', animations: 'disabled' })
      const [directResponse] = await Promise.all([promptResponse(), sendChoice.click()])
      expect(directResponse.status()).toBe(200)
      expect(directResponse.request().postDataJSON()).toMatchObject({ steer: true, prompt: '', attachmentIds: [expect.any(String)] })
      await expect.poll(async () => (await detail()).messages.filter(message => message.steered).length).toBe(2)
      const immediate = '使用快捷键立即发送'
      await input.fill(immediate)
      const [shortcutResponse] = await Promise.all([promptResponse(), input.press(directChord)])
      expect(shortcutResponse.status()).toBe(200)
      expect(shortcutResponse.request().postDataJSON()).toMatchObject({ steer: true, prompt: immediate })
      await expect.poll(async () => (await detail()).messages.filter(message => message.steered).length).toBe(3)
      expect((await detail()).queue?.map(item => item.text)).toEqual([earlier])
      const received = (await readFile(log, 'utf8'))
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line) as { method?: string; params?: { prompt: unknown[] } })
        .filter(event => event.method === '_session/steering')
        .map(event => event.params?.prompt)
      const imageBlock = { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }
      expect(received).toEqual([[{ type: 'text', text: now }, imageBlock], [imageBlock], [{ type: 'text', text: immediate }]])
      await page.setViewportSize({ width: 390, height: 844 })
      const emulation = await page.context().newCDPSession(page)
      await emulation.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      await input.fill('从手机选择排队')
      const point = await queue.evaluate(button => {
        const { x, y, width, height } = button.getBoundingClientRect()
        return { x: x + width / 2, y: y + height / 2 }
      })
      await emulation.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await emulation.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await menu.getByRole('menuitem', { name: '排队发送', exact: true }).click()
      await expect.poll(async () => (await detail()).queue?.map(item => item.text)).toEqual([earlier, '从手机选择排队'])
      expect((await detail()).messages.filter(message => message.steered)).toHaveLength(3)
      await page.getByRole('button', { name: '停止', exact: true }).click()
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
