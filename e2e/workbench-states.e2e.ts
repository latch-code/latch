import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page, type Request } from '@playwright/test'
import { expect, it } from 'vitest'
import type { Device, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, settleShell } from './helpers/layout.ts'
import { switchLayout } from './helpers/workbench.ts'

const OUT = 'test-results/workbench-states'
const layout = switchLayout
const requestCount = 10
async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  if (!name.includes('loading'))
    await expect.poll(() => page.locator('.approval-panel[data-arming], .question-card[data-arming]').count()).toBe(0)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
  const geometry = await page.evaluate(() =>
    Object.fromEntries(
      [
        '.workbench-home',
        '.workbench-home-composer',
        '.workbench-home-composer .composer-stack',
        '.workbench-home-composer .composer',
        '.workbench-home-composer .composer-input',
        '.workbench-home-composer textarea',
        '.workbench-home-composer .composer-toolbar',
        '.work-overview',
      ].map(selector => {
        const element = document.querySelector(selector)
        if (!element) return [selector, null]
        const box = element.getBoundingClientRect()
        const css = getComputedStyle(element)
        return [
          selector,
          {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            padding: css.padding,
            margin: css.margin,
            gap: css.gap,
            borderTop: css.borderTopWidth,
            borderBottom: css.borderBottomWidth,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            offsetHeight: element instanceof HTMLElement ? element.offsetHeight : null,
            ...(selector.endsWith('.composer-stack')
              ? {
                  children: [...element.children].map(child => ({
                    className: child.className,
                    height: child.getBoundingClientRect().height,
                    state: child.getAttribute('data-state'),
                    margin: getComputedStyle(child).margin,
                  })),
                }
              : {}),
          },
        ]
      }),
    ),
  )
  await writeFile(`${OUT}/${name}--${theme}--${width}.json`, JSON.stringify(geometry, null, 2))
}

it('renders the empty, loading, many, limited, read-only and offline states from the real Host permissions', async () => {
  let releaseRead: (() => void) | undefined
  const plugin: HarnessPlugin = {
    id: 'workbench-states',
    name: '界面状态验收',
    version: '1',
    description: 'Local scripted provider only.',
    activate(context) {
      context.registerProvider({
        id: 'state-model',
        name: '本地验收模型',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content ?? ''
          const ordinal = /配置 (\d+)$/u.exec(prompt)?.[1] ?? '1'
          if (messages.at(-1)?.role !== 'tool') {
            yield { type: 'text', text: '准备保存配置，需要你确认写入。' }
            yield {
              type: 'tool-call',
              call: {
                id: randomUUID(),
                name: 'write_file',
                arguments: {
                  path: `settings-${ordinal}.ts`,
                  content:
                    ordinal === '2'
                      ? 'export const keep = true\n'
                        + Array.from({ length: 16 }, (_, index) => `export const field${index} = true\n`).join('')
                      : 'export const keep = true\n',
                },
              },
            }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: '配置已经保存。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    demo: false,
    plugins: [plugin],
    providerId: 'state-model',
    hostName: '验收电脑',
  })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  const ids: string[] = []
  page.setDefaultTimeout(15_000)
  try {
    await mkdir(OUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    const folder = join(host.root, 'state-project')
    const retained = join(host.root, 'retained-project')
    await mkdir(folder)
    await mkdir(retained)
    for (let i = 1; i <= requestCount; i++)
      await writeFile(join(i <= 3 ? retained : folder, `settings-${i}.ts`), 'export const keep = false\n')
    const added = await owner.addFolders({ name: '设置项目', paths: [folder] })
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    const second = await owner.addFolders({ name: '保留配置项目', paths: [retained] })
    const { workspace: secondWorkspace } = (await second.json()) as { workspace: WorkspaceInfo }
    await enrollBrowser(page, host, { name: '状态验收设备', scopes: ['admin'] })
    const { devices } = await owner.json<{ devices: Device[] }>('devices')
    const device = devices.find(item => item.name === '状态验收设备')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    expect(await page.locator('.workbench-home .work-overview-group').count()).toBe(0)
    await page.locator('.workbench-empty').getByRole('heading', { name: '还没有会话' }).waitFor()
    await shot(page, 'overview-empty', 1440, 'dark')
    const emptyCard = await page.locator('.workbench-home-composer .composer').boundingBox()
    const emptyStack = await page.locator('.workbench-home-composer .composer-stack').boundingBox()
    expect(emptyCard!.y).toBe(48)
    expect(emptyStack!.height).toBe(emptyCard!.height)
    await layout(page, 'triage')
    await shot(page, 'triage-empty', 1440, 'dark')
    await layout(page, 'overview')
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    await page.route(/\/link\/api\/tasks\/[^/?]+$/u, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      await readGate
      return route.continue().catch(cause => {
        if (route.request().failure()?.errorText === 'net::ERR_ABORTED') return
        throw cause
      })
    })
    for (let i = 1; i <= requestCount; i++) {
      const task = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          prompt: `保存配置 ${i}`,
          workspaceId: i <= 3 ? secondWorkspace.id : workspace.id,
          model: { providerId: 'state-model', model: 'fixture' },
        },
      })
      ids.push(task.sessionId)
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${task.sessionId}`)).approvals.length).toBe(1)
    }
    const newest = ids.at(-1)!
    await page.locator('.work-decision-placeholder[aria-label="正在读取请求"]').waitFor()
    await shot(page, 'overview-loading', 1440, 'dark')
    releaseRead?.()
    await page.unrouteAll({ behavior: 'wait' })
    const home = page.locator('.workbench-home')
    const review = home.locator('.approval-panel[data-document-review]')
    await review.getByText('拟议改动', { exact: true }).waitFor()
    expect(await review.locator('.approval-preview').textContent()).toContain('settings-10.ts')
    await review
      .locator('.diff-text')
      .filter({ hasText: /export const keep = true/u })
      .waitFor()
    await expect.poll(() => home.locator('.approval-panel').getByRole('button', { name: '允许', exact: true }).isDisabled()).toBe(false)
    const queue = home.getByRole('list', { name: '待处理会话', exact: true })
    const queued = (id: string) => queue.locator(`[data-request-session="${id}"]`)
    expect(await queue.getByRole('listitem').count()).toBe(5)
    const expandedReads: string[] = []
    const recordRead = (request: Request) => {
      const detail = /^\/link\/api\/tasks\/([^/]+)$/u.exec(new URL(request.url()).pathname)
      if (request.method() === 'GET' && detail) expandedReads.push(detail[1]!)
    }
    page.on('request', recordRead)
    await home.getByRole('button', { name: '还有 5 件', exact: true }).click()
    expect(await queue.getByRole('listitem').count()).toBe(requestCount)
    expect(await queued(newest).textContent()).toContain(workspace.name)
    expect(await queued(ids[1]!).textContent()).toContain(secondWorkspace.name)
    expect(await queue.getByText('Latch 内置', { exact: true }).count()).toBe(0)
    expect(await home.locator('.work-overview-review-context').textContent()).toContain('Latch 内置')
    await shot(page, 'overview-queue-start', 1440, 'light')
    page.off('request', recordRead)
    expect(expandedReads.filter(id => id !== newest)).toEqual([])
    await queued(ids[0]!).scrollIntoViewIfNeeded()
    const listBox = await queue.boundingBox()
    const top = await queue.evaluate(element => element.scrollTop)
    expect(top).toBeGreaterThan(0)
    const earlier = queued(ids[1]!)
    await earlier.press('Enter')
    await review.locator('.approval-document-header').getByText('settings-2.ts', { exact: true }).waitFor()
    await review
      .locator('.diff-text')
      .filter({ hasText: /export const field0 = true/u })
      .waitFor()
    expect(await earlier.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await earlier.getAttribute('aria-current')).toBe('true')
    expect(await queue.boundingBox()).toEqual(listBox)
    expect(await queue.evaluate(element => element.scrollTop)).toBe(top)
    await shot(page, 'overview-queue-last', 1440, 'light')
    await review.getByRole('button', { name: '允许', exact: true }).click()
    await expect.poll(() => queue.getByRole('listitem').count()).toBe(requestCount - 1)
    await review.locator('.approval-document-header').getByText('settings-1.ts', { exact: true }).waitFor()
    expect(await queued(ids[0]!).getAttribute('aria-current')).toBe('true')
    expect(
      await queue.evaluate(
        (element, previous) => element.scrollTop === Math.min(previous, element.scrollHeight - element.clientHeight),
        top,
      ),
    ).toBe(true)
    await expect.poll(() => readFile(join(retained, 'settings-2.ts'), 'utf8')).toContain('export const field0 = true')
    expect(await home.getByRole('button', { name: '收起', exact: true, expanded: true }).count()).toBe(1)
    await home.getByRole('button', { name: '收起', exact: true, expanded: true }).click()
    const delayed = ids[7]!
    let didRead: (() => void) | undefined
    const staleStarted = new Promise<void>(resolve => {
      didRead = resolve
    })
    const staleGate = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    await page.route(`**/link/api/tasks/${delayed}`, async route => {
      didRead?.()
      await staleGate
      await route.continue().catch(cause => {
        if (route.request().failure()?.errorText === 'net::ERR_ABORTED') return
        throw cause
      })
    })
    await queued(delayed).click()
    await staleStarted
    await queued(newest).click()
    await review.locator('.approval-document-header').getByText('settings-10.ts', { exact: true }).waitFor()
    releaseRead?.()
    await page.unrouteAll({ behavior: 'wait' })
    expect(await queued(newest).getAttribute('aria-current')).toBe('true')
    expect(await review.locator('.approval-document-header').textContent()).toContain('settings-10.ts')
    await layout(page, 'triage')
    await expect.poll(() => review.count()).toBe(1)
    await expect.poll(() => review.getAttribute('data-arming')).toBeNull()
    const decisionRequests: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/approvals/')) decisionRequests.push(request.url())
    })
    await queued(newest).press('2')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    expect(decisionRequests).toEqual([])
    await layout(page, 'overview')
    for (const theme of ['light', 'dark'] as const) {
      await shot(page, 'overview-many', 1440, theme)
      for (const value of ['overview', 'triage'] as const) {
        await layout(page, value)
        await shot(page, `${value}-home`, 768, theme)
        await shot(page, `${value}-phone`, 390, theme)
        const words = page.locator('.workbench-phone-heading .ui-segmented-label').filter({ hasText: '我的 Agent' })
        if (await words.count()) expect(await words.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        await page.setViewportSize({ width: 1440, height: 1000 })
      }
      await layout(page, 'overview')
    }
    // Work scope retains the pending operation and path, while file bodies, diffs and project delivery stay unavailable.
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    await page.reload()
    await connected(page)
    await home.locator('.approval-panel').waitFor()
    expect(await home.locator('.diff-line').count()).toBe(0)
    expect(await home.locator('.approval-panel[data-document-review]').count()).toBe(0)
    const limited = await page.evaluate(async id => {
      const current: TaskDetail = await (await fetch(`/link/api/tasks/${id}`)).json()
      return current.approvals[0]
    }, newest)
    expect(limited?.toolName).toBe('write_file')
    expect(limited?.tool).not.toHaveProperty('diffs')
    expect(JSON.stringify(limited)).toContain('settings-10.ts')
    expect(JSON.stringify(limited)).not.toContain('export const keep')
    expect(await home.locator('[data-group="delivery"]').textContent()).toContain('这台设备不能读取项目改动')
    await shot(page, 'overview-limited', 1440, 'dark')
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all', scopes: ['view'] } })
    await page.reload()
    await connected(page)
    await home.locator('.approval-panel').waitFor()
    expect(await home.locator('.approval-panel').getByRole('button', { name: '允许', exact: true }).count()).toBe(0)
    expect(await home.locator('.approval-panel').getByRole('button', { name: '拒绝', exact: true }).count()).toBe(1)
    expect(await review.count()).toBe(0)
    expect(await home.locator('.approval-hint').textContent()).toContain('这台设备')
    expect(await home.locator('.approval-preview .diff-line').count()).toBeGreaterThan(0)
    await expect.poll(() => home.locator('.approval-panel').getByRole('button', { name: '拒绝', exact: true }).isDisabled()).toBe(false)
    await shot(page, 'overview-readonly', 1440, 'dark')
    await owner.confirmedJson(`devices/${device.id}`, {
      method: 'PATCH',
      body: { dataScope: 'all', scopes: ['view', 'run', 'approve:standard', 'approve:elevated', 'admin'] },
    })
    await page.reload()
    await connected(page)
    await home.locator('.approval-panel').waitFor()
    await context.setOffline(true)
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-connection')).toMatch(/offline|reconnecting/u)
    for (const theme of ['light', 'dark'] as const) await shot(page, 'overview-offline', 1440, theme)
    await layout(page, 'triage')
    await shot(page, 'triage-offline', 1440, 'dark')
    await context.setOffline(false)
    await connected(page)
    await layout(page, 'overview')
    await page.keyboard.press('Alt+,')
    const settings = page.locator('.settings-page')
    await settings.waitFor()
    await openSection(settings, '通用')
    for (const theme of ['light', 'dark'] as const) await shot(page, 'overview-settings', 1440, theme)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })

    const original = (await owner.json<TaskDetail>(`tasks/${newest}`)).approvals[0]!
    const writes: Array<{ decision: string; requestId: string; optionId?: string }> = []
    await page.route(`**/link/api/approvals/${original.id}`, async route => {
      writes.push(route.request().postDataJSON())
      if (writes.length === 1) await route.abort('connectionreset')
      else await route.continue()
    })
    const card = home.locator(`[data-approval-id="${original.id}"]`)
    await card.getByRole('button', { name: '允许', exact: true }).click()
    await card.getByText('「允许」的结果未知', { exact: true }).waitFor()
    for (const name of ['拒绝', '允许']) expect(await card.getByRole('button', { name, exact: true }).isDisabled()).toBe(true)
    await card.getByRole('button', { name: '重试', exact: true }).focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('2')
    expect(writes).toHaveLength(1)
    await queued(ids[8]!).click()
    await queued(newest).getByText('审批结果尚未确认', { exact: true }).waitFor()
    await writeFile(join(folder, 'settings-11.ts'), 'export const keep = false\n')
    const next = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        prompt: '保存配置 11',
        workspaceId: workspace.id,
        model: { providerId: 'state-model', model: 'fixture' },
      },
    })
    ids.push(next.sessionId)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${next.sessionId}`)).approvals.length).toBe(1)
    await queued(next.sessionId).waitFor()
    expect(await queue.locator('[data-request-session]').first().getAttribute('data-request-session')).toBe(next.sessionId)
    expect(await queued(ids[8]!).getAttribute('aria-current')).toBe('true')
    await context.setOffline(true)
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-connection')).toMatch(/offline|reconnecting/u)
    await queued(newest).click()
    await home.locator('.work-overview-review-detail').getByText('审批结果尚未确认', { exact: true }).waitFor()
    expect(await home.locator('.work-overview-review-detail').getByRole('button', { name: '重试', exact: true }).count()).toBe(0)
    await shot(page, 'overview-approval-unconfirmed-offline', 1440, 'dark')

    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
    await context.setOffline(false)
    await connected(page)
    await card.getByText('审批结果尚未确认', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: '重试', exact: true }).count()).toBe(0)
    expect(await card.getByRole('button', { name: '拒绝', exact: true }).isDisabled()).toBe(true)
    expect(writes).toHaveLength(1)
    await shot(page, 'overview-approval-unconfirmed-readonly', 1440, 'dark')
    await owner.confirmedJson(`devices/${device.id}`, {
      method: 'PATCH',
      body: { scopes: ['view', 'run', 'approve:standard', 'approve:elevated', 'admin'] },
    })
    await card.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => readFile(join(folder, 'settings-10.ts'), 'utf8')).toBe('export const keep = true\n')
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    await card.waitFor({ state: 'detached' })
  } finally {
    releaseRead?.()
    await page.unrouteAll({ behavior: 'wait' })
    await context.setOffline(false)
    for (const id of ids) await host.host.bridge.cancel(id).catch(() => {})
    await context.close()
    await browser.close()
    await host.close()
  }
})
