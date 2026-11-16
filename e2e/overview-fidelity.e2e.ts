import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { Device, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { closeSettings, noHorizontalOverflow, openSection, reachable, settleShell } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'
import { switchLayout } from './helpers/workbench.ts'

const OUTPUT = 'test-results/overview-fidelity'
const MODEL = { providerId: 'overview-fixture', model: 'fixture' }
const NOTES = '# 活动报名页\n\n- 重新打开表单可以恢复未提交的填写项。\n- 活动满额时可以加入候补名单。\n'
const RESULT = 'src/registration/WaitlistForm.tsx'
const LONG_PATH = `docs/${'活动报名页面与候补确认版本验收'.repeat(4)}.md`
const LONG = Array.from({ length: 22 }, (_, index) => `记录 ${index + 1}：${'交付路径与内容需要在原请求中逐项核对。'.repeat(6)}`).join('\n')
const WAITING = '整理报名页发布说明'
const FAILED = '检查窄屏报名表构建'
const RUNNING = '核对候补确认文案'

async function capture(page: Page, name: string, width: number, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUTPUT}/${name}-${width}-${colorScheme}.png`, animations: 'disabled', caret: 'hide' })
}

async function turnOffBackdrop(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).locator('visible=true').first().click()
  const settings = page.locator('.settings-page')
  await openSection(settings, '通用')
  await settings.getByRole('radiogroup', { name: '背景效果', exact: true }).getByRole('radio', { name: '关', exact: true }).click()
  await closeSettings(settings)
  expect(await page.locator('.workbench-home .workbench-backdrop').count()).toBe(0)
}

it('keeps the real request, its material and the work to resume on the same overview', async () => {
  let finishRun: (() => void) | undefined
  const resultReads: Array<{ updatedAt: string; revision?: number; pending: boolean; files: string[] }> = []
  const plugin: HarnessPlugin = {
    id: 'overview-fixture',
    name: '总览验收',
    version: '1',
    description: 'Scripted local model.',
    activate(context) {
      context.registerProvider({
        id: MODEL.providerId,
        name: '本地验收模型',
        model: MODEL.model,
        async *stream({ messages, signal }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content ?? ''
          if (prompt === FAILED) throw new Error('本地构建未通过：窄屏的候补按钮不能完整显示。请核对按钮文字与布局后重试。')
          if (prompt === RUNNING) {
            yield { type: 'text', text: '正在核对候补确认文案。' }
            await new Promise<void>(done => {
              finishRun = done
              signal.addEventListener('abort', () => done(), { once: true })
            })
          } else if (messages.at(-1)?.role !== 'tool') {
            const ordinal = /请求 (\d+)$/u.exec(prompt)?.[1]
            const path =
              prompt === WAITING ? 'docs/release-notes.md' : ordinal === '1' ? LONG_PATH : ordinal ? `docs/review-${ordinal}.md` : RESULT
            const content = prompt === WAITING ? NOTES : ordinal ? LONG : '// 实际写入的候补表单\nexport const waitlist = true\n'
            yield { type: 'tool-call', call: { id: randomUUID(), name: 'write_file', arguments: { path, content } } }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: '本轮已完成。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    demo: false,
    providerId: MODEL.providerId,
    hostName: '验收电脑',
    plugins: [plugin],
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    await mkdir(OUTPUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    const folder = join(host.root, 'registration')
    await mkdir(join(folder, 'docs'), { recursive: true })
    await mkdir(join(folder, 'src', 'registration'), { recursive: true })
    await writeFile(join(folder, 'docs', 'release-notes.md'), '# 活动报名页\n\n旧版说明。\n')
    const added = await owner.addFolders({ name: '活动报名页', paths: [folder] })
    expect(added.status).toBe(201)
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    const start = (prompt: string) =>
      owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt, workspaceId: workspace.id, model: MODEL, requestId: randomUUID() },
      })
    const read = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
    const waitForApproval = async (id: string) => {
      await expect.poll(async () => (await read(id)).approvals.length).toBe(1)
      return (await read(id)).approvals[0]!
    }
    const open = async (width: number, height: number) => {
      const context = await browser.newContext({
        viewport: { width, height },
        locale: 'zh-CN',
        hasTouch: width < 1024,
        isMobile: width < 768,
      })
      const page = await context.newPage()
      const name = `总览验收 ${width}`
      await enrollBrowser(page, host, { name, scopes: ['admin'] })
      const { devices } = await owner.json<{ devices: Device[] }>('devices')
      const device = devices.find(item => item.name === name)!
      await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
      await page.reload()
      await connected(page)
      return { context, page }
    }
    const desktop = await open(1440, 900)
    const page = desktop.page
    const home = page.getByRole('region', { name: '工作总览', exact: true })
    await home.getByRole('heading', { name: '还没有会话' }).waitFor()
    await page.locator('.workbench-home .workbench-backdrop').waitFor()
    await capture(page, 'empty-backdrop', 1440, 'light')
    await turnOffBackdrop(page)
    await capture(page, 'empty', 1440, 'light')
    const result = await start('核对候补表单组件')
    const resultApproval = await waitForApproval(result.sessionId)
    page.on('response', response => {
      if (new URL(response.url()).pathname !== `/link/api/tasks/${result.sessionId}` || !response.ok()) return
      void response
        .json()
        .then((detail: TaskDetail) => {
          resultReads.push({
            updatedAt: detail.summary.updatedAt,
            ...(detail.sync ? { revision: detail.sync.revision } : {}),
            pending: detail.messages.some(message => message.outputsPending),
            files: detail.messages.flatMap(message => message.outputs ?? []).map(file => file.path),
          })
        })
        .catch(() => {})
    })
    await owner.json(`approvals/${resultApproval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
    await expect.poll(() => readFile(join(folder, RESULT), 'utf8').catch(() => ''), { timeout: 10_000 }).toContain('export const waitlist')
    await expect
      .poll(
        async () => {
          const detail = await read(result.sessionId)
          return {
            state: detail.summary.runOutcome,
            pending: detail.messages.some(message => message.outputsPending),
            unavailable: detail.messages.some(message => message.outputsUnavailable),
            outputs: detail.messages.flatMap(message => message.outputs ?? []).map(file => file.path),
          }
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ state: 'completed', pending: false, unavailable: false, outputs: expect.arrayContaining([RESULT]) })
    const running = await start(RUNNING)
    await expect.poll(async () => (await read(running.sessionId)).summary.status).toBe('running')
    const waiting = await start(WAITING)
    const approval = await waitForApproval(waiting.sessionId)
    const current = home.getByRole('region', { name: '当前请求', exact: true })
    const material = current.locator('.work-feature-material')
    await expect.poll(() => current.locator('[data-work-session]').getAttribute('data-work-session')).toBe(waiting.sessionId)
    await material.getByText('活动满额时可以加入候补名单。').waitFor()
    await material.getByText('核对材料 · 原文件内容').click()
    await material.getByText(/旧版说明/u).waitFor()
    await material.getByText('核对材料 · 原文件内容').click()
    expect(await current.getByRole('button', { name: '查看原请求' }).count()).toBe(1)
    expect(await current.locator('.approval-panel').count()).toBe(0)
    const output = home.getByRole('region', { name: '最近成果' }).getByRole('button', { name: /WaitlistForm\.tsx/u })
    await output.waitFor({ timeout: 8_000 })
    expect(resultReads.some(read => !read.pending && read.files.includes(RESULT))).toBe(true)
    const runningRow = home.getByRole('region', { name: '接着做' }).locator(`[data-work-session="${running.sessionId}"]`)
    await expect.poll(async () => (await runningRow.textContent())?.match(/\b\d+:\d\d\b/gu)?.length).toBe(1)
    expect(await home.getByRole('list', { name: '待处理会话' }).count()).toBe(0)
    await page.locator('.titlebar .work-landing-context').getByText('验收电脑').waitFor()
    const workTitle = (await home.getByRole('heading', { name: '工作总览' }).boundingBox())!
    expect(workTitle.y).toBeGreaterThanOrEqual(104)
    expect(workTitle.y).toBeLessThanOrEqual(126)
    expect((await current.getByRole('button', { name: '查看原请求' }).boundingBox())!.height).toBeGreaterThanOrEqual(36)
    const anchor = () => page.locator('.workbench-home-composer .composer').boundingBox()
    const sectionBox = (await home.boundingBox())!
    const composerBox = (await anchor())!
    expect(sectionBox.width).toBe(1016)
    expect(composerBox.width).toBeCloseTo(sectionBox.width, 0)
    expect(composerBox.x).toBeCloseTo(sectionBox.x, 0)
    expect(composerBox.height).toBeLessThanOrEqual(120)
    const before = (await material.boundingBox())!
    expect(before.x - sectionBox.x).toBeCloseTo(48 + (1016 - 48) * 0.42, 1)
    for (const scheme of ['light', 'dark'] as const) await capture(page, 'overview', 1440, scheme)
    for (const [width, height] of [
      [768, 1024],
      [390, 844],
    ] as const) {
      const mobile = await open(width, height)
      try {
        await mobile.page.locator('.work-feature-material').getByText('活动满额时可以加入候补名单。').waitFor()
        await turnOffBackdrop(mobile.page)
        for (const scheme of ['light', 'dark'] as const) await capture(mobile.page, 'overview', width, scheme)
        await reachable(mobile.page.getByRole('button', { name: '查看原请求' }))
      } finally {
        await mobile.context.close()
      }
    }
    await output.click()
    await page
      .locator('.file-preview')
      .getByText(/实际写入的候补表单/u)
      .waitFor()
    await capture(page, 'file', 1440, 'light')
    const detailRoute = `**/link/api/tasks/${result.sessionId}`
    let failNextResultRead = true
    await page.route(detailRoute, route => {
      if (route.request().method() !== 'GET' || !failNextResultRead) return route.continue()
      failNextResultRead = false
      return route.fulfill({ status: 503, json: { error: '成果读取暂不可用' } })
    })
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    await home.getByText('暂时无法读取成果', { exact: true }).waitFor()
    expect(await output.count()).toBe(0)
    await home.getByRole('button', { name: '重试读取成果', exact: true }).click()
    await output.waitFor()
    await page.unroute(detailRoute)
    const earlier = []
    for (let index = 1; index <= 5; index++) {
      const item = await start(`处理第 ${index} 个请求 ${index}`)
      earlier.push({ sessionId: item.sessionId, approval: await waitForApproval(item.sessionId) })
    }
    const failed = await start(FAILED)
    await expect.poll(async () => (await read(failed.sessionId)).summary.runOutcome).toBe('failed')
    const queueToggle = home.getByRole('button', { name: '7 项待处理' })
    expect(await queueToggle.getAttribute('aria-expanded')).toBe('false')
    expect(await home.getByRole('list', { name: '待处理会话' }).count()).toBe(0)
    await queueToggle.click()
    const queue = home.getByRole('list', { name: '待处理会话' })
    expect(await queue.getByRole('listitem').count()).toBe(5)
    await home.getByRole('button', { name: '还有 2 件', exact: true }).click()
    expect(await queue.getByRole('listitem').count()).toBe(7)
    // The list grows in place; it never scrolls on its own.
    expect(await queue.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true)
    const listBox = await queue.boundingBox()
    const workScroll = () =>
      home.evaluate(node => ({ workspace: node.closest('.code-home-queue')!.scrollTop, document: document.scrollingElement!.scrollTop }))
    const initialScroll = await workScroll()
    const failure = queue.locator(`[data-request-session="${failed.sessionId}"]`)
    await failure.click()
    await current.getByRole('button', { name: '查看失败' }).waitFor()
    await material.getByText(/窄屏的候补按钮不能完整显示/u).waitFor()
    await capture(page, 'failure', 1440, 'dark')
    const long = earlier[0]!
    await queue.locator(`[data-request-session="${long.sessionId}"]`).click()
    await material.getByText('拟写内容 · 摘录').waitFor()
    const title = current.getByRole('heading').first()
    expect(await title.getAttribute('title')).toContain(LONG_PATH.split('/').at(-1))
    const titleBox = (await title.boundingBox())!
    const metaBox = (await current.locator('.work-feature-meta').boundingBox())!
    const actionBox = (await current.getByRole('button', { name: '查看原请求' }).boundingBox())!
    expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(metaBox.y)
    expect(metaBox.y + metaBox.height).toBeLessThanOrEqual(actionBox.y)
    expect(actionBox.y + actionBox.height).toBeLessThan(listBox!.y)
    const longBox = (await material.boundingBox())!
    expect(longBox.height).toBeGreaterThan(before.height)
    expect(await material.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true)
    const excerpt = material.getByRole('region', { name: '拟写内容', exact: true })
    expect(await excerpt.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    await excerpt.evaluate(node => {
      node.scrollTop = node.scrollHeight
    })
    expect(await excerpt.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    await excerpt.evaluate(node => {
      node.scrollTop = 0
    })
    expect(await queueToggle.getAttribute('aria-expanded')).toBe('true')
    // Choosing rows does not move the list within the page; only the page itself may have scrolled.
    const listNow = (await queue.boundingBox())!
    const scrolled = (await workScroll()).workspace - initialScroll.workspace
    expect({ ...listNow, y: listNow.y + scrolled }).toEqual(listBox)
    expect((await workScroll()).document).toBe(initialScroll.document)
    expect(await anchor()).toEqual(composerBox)
    expect(longBox.y + longBox.height).toBeLessThan(composerBox.y)
    await capture(page, 'queue', 1440, 'light')
    await switchLayout(page, 'triage')
    await page.locator('.workbench-home .work-overview-group[data-group="attention"] .approval-panel').waitFor()
    await switchLayout(page, 'overview')
    if ((await queueToggle.getAttribute('aria-expanded')) !== 'true') await queueToggle.click()
    const rest = home.getByRole('button', { name: '还有 2 件', exact: true })
    if (await rest.isVisible()) await rest.click()
    await queue.locator(`[data-request-session="${waiting.sessionId}"]`).click()
    await current.getByRole('button', { name: '查看原请求' }).click()
    const exact = page.locator(`main.workspace [data-approval-id="${approval.id}"]`)
    await exact.waitFor()
    expect(await exact.getByText(/release-notes\.md/u).count()).toBeGreaterThan(0)
    expect((await read(waiting.sessionId)).approvals.map(item => item.id)).toEqual([approval.id])
    await desktop.context.close()
  } finally {
    finishRun?.()
    await browser.close()
    await host.close()
    await writeFile(`${OUTPUT}/result-reads.json`, JSON.stringify(resultReads, null, 2))
  }
})
