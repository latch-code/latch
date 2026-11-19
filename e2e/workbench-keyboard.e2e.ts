import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, webkit, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { backToPhoneSessions, noHorizontalOverflow, openSession, reachable, settleShell } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

async function choose(page: Page, title: string) {
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
  await palette.getByRole('searchbox').fill(title)
  await palette.getByRole('option', { name: title, exact: true }).click()
  await palette.waitFor({ state: 'hidden' })
}

it.each([
  [390, 'light'],
  [900, 'dark'],
  [1440, 'light'],
] as const)('cycles real pending requests and navigates sessions and files with keys at %i %s', async (width, theme) => {
  let modelCalls = 0
  const plugin: HarnessPlugin = {
    id: 'keyboard-model',
    name: 'Keyboard fixture',
    version: '1',
    description: 'Only local test responses.',
    activate(context) {
      context.registerProvider({
        id: 'keyboard-model',
        name: 'Keyboard fixture',
        model: 'fixture',
        async *stream({ messages }) {
          modelCalls++
          if (messages.findLast(message => message.role === 'user')?.content.startsWith('批准 键盘')) {
            yield { type: 'tool-call', call: { id: randomUUID(), name: 'write_report', arguments: {} } }
            yield { type: 'finish', reason: 'tool-calls' }
          } else {
            yield { type: 'text', text: '键盘导航基准。导航和文件预览不会发送这段草稿。' }
            yield { type: 'finish', reason: 'stop' }
          }
        },
      })
    },
  }
  const host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  const active: string[] = []
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const source = join(host.root, 'keyboard-project')
    await mkdir(source)
    await writeFile(join(source, 'keyboard-navigation.txt'), '真实文件键盘预览，不触发模型。\n')
    const added = await owner.addFolders({ name: '键盘验收项目', paths: [source] })
    expect(added.status).toBe(201)
    const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
    const create = async (prompt: string) => {
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt,
          mode: 'agent',
          workspaceId: project.id,
          model: { providerId: 'keyboard-model', model: 'fixture' },
          requestId: randomUUID(),
        },
      })
      active.push(created.sessionId)
      return created.sessionId
    }
    const pending: TaskDetail[] = []
    for (const letter of ['A', 'B']) {
      const id = await create('批准 键盘 ' + letter)
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + id)).approvals.length, { timeout: 10_000 }).toBe(1)
      pending.push(await owner.json<TaskDetail>('tasks/' + id))
    }
    const neutralId = await create('键盘基准会话')
    await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + neutralId)).summary.status, { timeout: 10_000 }).toBe('idle')
    const neutral = await owner.json<TaskDetail>('tasks/' + neutralId)
    const details = [...pending, neutral]
    const messagesBefore = details.map(detail => detail.messages.map(message => message.id))
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const submissions: string[] = []
    const fileSearches: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && /^\/link\/api\/(?:tasks(?:\/[^/]+\/(?:prompt|cancel))?|approvals\/[^/]+)$/u.test(path))
        submissions.push(path)
      if (path.endsWith('/files/search')) fileSearches.push(path)
    })
    try {
      const name = `键盘 ${width} ${theme}`
      await enrollBrowser(page, host, { name, scopes: ['view', 'run', 'approve:standard'] })
      const deviceId = host.host.security.devices.list().find(device => device.name === name)!.id
      expect((await owner.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
      await choose(page, neutral.summary.title)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const draft = `仅保留的键盘草稿 ${width} ${theme}`
      await input.fill(draft)
      const callsBefore = modelCalls
      // Read the actual list at this width; the desktop project tree and phone history have different grouping.
      if (width < 768) await backToPhoneSessions(page)
      else {
        const opener = page.getByRole('button', { name: '打开会话列表', exact: true })
        if (await opener.isVisible()) await opener.click()
      }
      await settleShell(page)
      const rows = page.locator(width < 768 ? '.phone-list:not([inert]) [data-task-id]' : '.sidebar [data-task-id]')
      const orderedIds = (await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-task-id')!))).filter(id =>
        active.includes(id),
      )
      expect(new Set(orderedIds).size).toBe(3)
      if (width >= 768) {
        await page.keyboard.press('Escape')
        await settleShell(page)
      } else await openSession(page, neutralId)
      const selected = async (id: string) => {
        const detail = details.find(item => item.summary.id === id)!
        const message = detail.messages.find(item => item.role === 'user')!
        await page.locator(`.transcript [data-message-id="${message.id}"]`).waitFor({ state: 'visible' })
      }
      // Alt digits follow the drawn rows, and never type into the parked draft.
      const neutralIndex = orderedIds.indexOf(neutralId)
      const url = page.url()
      for (const index of [2, 0, 1, neutralIndex]) {
        await page.keyboard.press(`Alt+${index + 1}`)
        await selected(orderedIds[index]!)
      }
      await page.keyboard.press('Alt+9')
      await page.waitForTimeout(300)
      await selected(neutralId)
      expect(await input.inputValue()).toBe(draft)
      expect(page.url()).toBe(url)
      expect(context.pages()).toHaveLength(1)
      await page.keyboard.press('Alt+]')
      await selected(orderedIds[(neutralIndex + 1) % orderedIds.length]!)
      await page.keyboard.press('Alt+[')
      await selected(neutralId)
      await page.keyboard.press('Alt+[')
      await selected(orderedIds[(neutralIndex + orderedIds.length - 1) % orderedIds.length]!)
      await page.keyboard.press('Alt+]')
      await selected(neutralId)

      const approvals = pending.flatMap(detail => detail.approvals).toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      for (const approval of [...approvals, approvals[0]!]) {
        await page.keyboard.press('Alt+Shift+a')
        const card = page.locator(`.transcript [data-message-id="tool:${approval.toolCallId}"]`)
        await card.waitFor({ state: 'visible' })
        await expect
          .poll(() => card.evaluate(element => element === document.activeElement && element.hasAttribute('data-approval-target')))
          .toBe(true)
        expect(await page.locator('.transcript [data-approval-target]').count()).toBe(1)
        await reachable(card)
        // A row's light reaches 8 past its words by design (the rail), so the card is measured against the column it sits
        // in: it ends inside the transcript, and the transcript does not scroll sideways.
        const transcript = page.locator('.transcript').first()
        const [cardBox, columnBox] = await Promise.all([card.boundingBox(), transcript.boundingBox()])
        expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(columnBox!.x + columnBox!.width)
        await noHorizontalOverflow(page, transcript)
      }
      await mkdir('test-results/workbench-keyboard', { recursive: true })
      await page.screenshot({ path: `test-results/workbench-keyboard/approval-${width}-${theme}.png`, animations: 'disabled' })
      // The input of a session waiting on a request is named for what typing does there.
      expect(await page.locator('.composer textarea').filter({ visible: true }).inputValue()).toBe('')
      await choose(page, neutral.summary.title)
      expect(await input.inputValue()).toBe(draft)

      await input.focus()
      fileSearches.length = 0
      await page.keyboard.press('Alt+p')
      const files = page.getByRole('dialog', { name: '搜索文件', exact: true })
      const query = files.getByRole('searchbox', { name: '搜索文件名', exact: true })
      await query.fill('keyboard-navigation.txt')
      const result = files.getByRole('option', { name: 'keyboard-navigation.txt', exact: true })
      await result.waitFor()
      expect(await result.getAttribute('aria-selected')).toBe('true')
      await query.press('Enter')
      await files.waitFor({ state: 'hidden' })
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.getByText('真实文件键盘预览，不触发模型。', { exact: true }).waitFor()
      await page.getByRole('tab', { name: 'keyboard-navigation.txt', exact: true }).waitFor()
      expect(fileSearches.length).toBeGreaterThan(0)
      expect(fileSearches.every(path => path === `/link/api/tasks/${neutralId}/files/search`)).toBe(true)
      await noHorizontalOverflow(page, preview)
      await page.screenshot({ path: `test-results/workbench-keyboard/file-${width}-${theme}.png`, animations: 'disabled' })
      await page.keyboard.press('Alt+w')
      await preview.waitFor({ state: 'hidden' })
      expect(await page.getByRole('tab', { name: 'keyboard-navigation.txt', exact: true }).count()).toBe(0)
      expect(await input.inputValue()).toBe(draft)
      await page.keyboard.press('Alt+l')
      await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await input.inputValue()).toBe(draft)
      expect(submissions).toEqual([])
      expect(modelCalls).toBe(callsBefore)
      for (const [index, detail] of details.entries()) {
        const after = await owner.json<TaskDetail>('tasks/' + detail.summary.id)
        expect(after.messages.map(message => message.id)).toEqual(messagesBefore[index])
        expect(after.approvals.map(approval => approval.id)).toEqual(detail.approvals.map(approval => approval.id))
      }
    } finally {
      await context.close()
    }
  } finally {
    const owner = await host.enroll({ listener: 'unix' })
    for (const id of active)
      await owner.request(`tasks/${id}/cancel`, { method: 'POST', body: { requestId: randomUUID() } }).catch(() => {})
    await browser.close()
    await host.close()
  }
})

const SHOTS = 'test-results/workbench-keyboard'

it.each([
  ['chromium', 390, 'light'],
  ['chromium', 900, 'dark'],
  ['chromium', 1440, 'light'],
  ['webkit', 390, 'dark'],
  ['webkit', 900, 'light'],
  ['webkit', 1440, 'dark'],
] as const)(
  'opens the shortcuts over a running session and each composer control with keys in %s at %i %s',
  async (engine, width, theme) => {
    let modelCalls = 0
    let release: () => void = () => {}
    const held = new Promise<void>(done => {
      release = done
    })
    const plugin: HarnessPlugin = {
      id: 'keys-model',
      name: 'Keys fixture',
      version: '1',
      description: 'Only local test responses.',
      activate(context) {
        context.registerProvider({
          id: 'keys-model',
          name: 'Keys fixture',
          model: 'fixture',
          async *stream() {
            modelCalls++
            yield { type: 'text', text: '运行中的会话，浮层盖在它上面。' }
            await held
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), plugins: [plugin] })
    const browser = await (engine === 'webkit' ? webkit.launch({ headless: true }) : chromium.launch(browserLaunchOptions()))
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt: '键位浮层的运行中会话',
          mode: 'agent',
          model: { providerId: 'keys-model', model: 'fixture' },
          requestId: randomUUID(),
        },
      })
      const running = created.sessionId
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + running)).summary.status, { timeout: 10_000 }).toBe('running')
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
        locale: 'zh-CN',
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      const submissions: string[] = []
      page.on('request', request => {
        const path = new URL(request.url()).pathname
        if (request.method() === 'POST' && /^\/link\/api\/(?:tasks(?:\/[^/]+\/(?:prompt|cancel))?|approvals\/[^/]+)$/u.test(path))
          submissions.push(path)
      })
      try {
        await enrollBrowser(page, host, { name: `键位 ${engine} ${String(width)}`, scopes: ['view', 'run'] })
        await choose(page, '键位浮层的运行中会话')
        await page.locator('.transcript').getByText('运行中的会话，浮层盖在它上面。').waitFor()
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        const draft = `键位草稿 ${engine} ${String(width)}`
        await input.fill(draft)
        const callsBefore = modelCalls
        const url = page.url()
        const overlay = page.getByRole('dialog', { name: '快捷键', exact: true })
        const search = overlay.getByRole('searchbox', { name: '搜索快捷键', exact: true })
        // Nothing a key does here leaves the page or opens another: none of them is the browser's own.
        const stayed = async () => {
          expect(page.url()).toBe(url)
          expect(context.pages()).toHaveLength(1)
          expect(await input.inputValue()).toBe(draft)
        }
        const shoot = async (name: string) => {
          await mkdir(SHOTS, { recursive: true })
          for (const scheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme: scheme })
            await page.screenshot({ path: join(SHOTS, `${name}--${String(width)}--${scheme}--${engine}.png`), animations: 'disabled' })
          }
          await page.emulateMedia({ colorScheme: theme })
        }

        if (width < 768) {
          // A phone has no keys: no overlay, and no control opens.
          await page.keyboard.press('Alt+/')
          await page.keyboard.press('Alt+Shift+1')
          await page.waitForTimeout(300)
          expect(await overlay.count()).toBe(0)
          expect(await page.locator('[data-composer-control] [aria-expanded="true"]').count()).toBe(0)
          await stayed()
          await shoot('phone-no-overlay')
        } else {
          await input.focus()
          await page.keyboard.press('Alt+/')
          await overlay.waitFor()
          await expect.poll(() => search.evaluate(element => element === document.activeElement)).toBe(true)
          // Over the session, which keeps running under it: no page in between, no settings.
          expect(await page.locator('.settings-page').count()).toBe(0)
          expect(await page.locator('.transcript').getByText('运行中的会话，浮层盖在它上面。').count()).toBe(1)
          expect(await overlay.locator('[data-keys="Alt 1 … Alt 9"] kbd').allTextContents()).toEqual(['Alt 1', 'Alt 9'])
          expect(await overlay.locator('[data-keys="Alt Shift 1 … Alt Shift 4"]').count()).toBe(1)
          expect(await overlay.locator('[data-keys="⌘1 … ⌘9"]').count()).toBe(0)
          expect(await overlay.locator('.shortcuts-overlay-row').count()).toBe(28)
          // The views are named as the switch names them, and the switch has its own key.
          const viewKey = overlay.locator('.shortcuts-overlay-row', { hasText: '切换对话、看板' })
          expect(await viewKey.locator('kbd').allTextContents()).toEqual(['Alt Shift L'])
          expect(await overlay.locator('.shortcuts-overlay-row', { hasText: '终端' }).count()).toBe(1)
          await noHorizontalOverflow(page, overlay.locator('.ui-dialog-surface'))
          await shoot('keys-overlay')
          await search.fill('会话')
          await overlay.getByText('跳到第 N 个会话 · 模型面板里选第 N 个模型', { exact: true }).waitFor()
          expect(await overlay.getByText('改动', { exact: true }).count()).toBe(0)
          await search.fill('没有这个键')
          await overlay.getByText('没有匹配的快捷键', { exact: true }).waitFor()
          await shoot('keys-overlay-none')
          await search.fill('')
          await page.keyboard.press('Escape')
          await overlay.waitFor({ state: 'hidden' })
          await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
          // ⌘/ (here Alt /) opens and closes it.
          await page.keyboard.press('Alt+/')
          await overlay.waitFor()
          await page.keyboard.press('Alt+/')
          await overlay.waitFor({ state: 'hidden' })
          await stayed()

          // Each control key opens its own menu, in the session and on the home's input; Escape puts it away. 思考 is set
          // in the model's one entry: its key opens that panel with focus on the levels. 权限 opens its own popover.
          const controls = ['harness', 'model', 'thinking', 'permission'] as const
          const part: Record<(typeof controls)[number], string | undefined> = {
            harness: undefined,
            model: '.ui-board-list',
            thinking: '.ui-board-levels',
            permission: '.permission-panel',
          }
          const opens = async (where: 'session' | 'draft') => {
            const opened: string[] = []
            for (const [index, control] of controls.entries()) {
              const trigger = page
                .locator(where === 'draft' ? '.workbench-home' : 'main.workspace')
                .locator(`.composer-stack [data-composer-control="${control === 'thinking' ? 'model' : control}"] button`)
                .first()
              if ((await trigger.count()) === 0) continue
              if ((await trigger.getAttribute('aria-disabled')) === 'true' || (await trigger.isDisabled())) continue
              await page.keyboard.press(`Alt+Shift+${String(index + 1)}`)
              await expect.poll(() => trigger.getAttribute('aria-expanded'), { message: `${where} ${control}` }).toBe('true')
              const inside = part[control]
              if (inside)
                await expect
                  .poll(() => page.evaluate(selector => !!document.activeElement?.closest(selector), inside), {
                    message: `${where} ${control} focus`,
                  })
                  .toBe(true)
              if (control !== 'harness') await shoot(`control-${where}-${control}`)
              await page.keyboard.press('Escape')
              await expect.poll(() => trigger.getAttribute('aria-expanded')).not.toBe('true')
              opened.push(control)
            }
            return opened
          }
          expect(await opens('session')).toEqual(controls)
          expect(await input.inputValue()).toBe(draft)
          await page.keyboard.press('Alt+n')
          // 新会话 is the home with its input focused, over the session, which stays open.
          const newInput = page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
          await newInput.waitFor()
          await expect.poll(() => newInput.evaluate(element => element === document.activeElement)).toBe(true)
          expect(await page.locator('main.workspace').getAttribute('inert')).toBe('')
          await newInput.fill('新会话草稿')
          expect(await opens('draft')).toEqual(controls)
          expect(await newInput.inputValue()).toBe('新会话草稿')
          await choose(page, '键位浮层的运行中会话')
          await stayed()
          if (width >= 1024) await shoot('sidebar-caps')
        }
        expect(submissions).toEqual([])
        expect(modelCalls).toBe(callsBefore)
      } finally {
        await context.close()
      }
    } finally {
      release()
      await browser.close()
      await host.close()
    }
  },
)
