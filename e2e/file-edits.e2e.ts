import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { splitChangeNote, type ChangeList } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeActiveFile, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/file-edits'

/** What the model was sent as the person's last message, turn by turn. */
const prompts: string[] = []

/** A model that names the file to edit, and records what each turn's last user message said. */
const fixture: HarnessPlugin = {
  id: 'file-edits-fixture',
  name: 'Fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'files',
      name: 'Fixture',
      model: 'fixture',
      async *stream({ messages }) {
        prompts.push(messages.findLast(message => message.role === 'user')?.content ?? '')
        yield { type: 'text', text: '文件：[notes.txt](notes.txt)' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

async function choose(page: Page, sessionId: string) {
  await page.locator('.app-shell').waitFor()
  await settleShell(page)
  const row = page.locator(`[data-task-id="${sessionId}"]`).first()
  if (await page.locator('.workspace.has-task').count()) return
  if (!(await row.isVisible())) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
  await row.click()
  await settleShell(page)
}

describe('editing a file from its preview', () => {
  let host: TestHost, browser: Browser, sessionId: string
  const notes = () => join(host.workspaceRoot, 'notes.txt')

  beforeAll(async () => {
    host = await startTestHost({ demo: false, plugins: [fixture] })
    await writeFile(notes(), 'alpha\nbeta\n')
    ;({ sessionId } = await host.host.bridge.createTask({
      prompt: '看一下 notes',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'files', model: 'fixture' },
    }))
    for (let attempts = 0; (await host.host.bridge.detail(sessionId)).summary.status !== 'idle'; attempts++) {
      if (attempts > 200) throw new Error('The session did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  async function open(width: number, height: number, theme: 'light' | 'dark' = 'light') {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: 'zh-CN' })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const name = `Edit ${randomUUID()}`
    await enrollBrowser(page, host, { name, scopes: ['admin'] })
    const owner = await host.enroll({ listener: 'unix' })
    const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
    const id = devices.devices.find(item => item.name === name)!.id
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await choose(page, sessionId)
    await page.locator('.transcript').getByRole('button', { name: '预览文件：notes.txt', exact: true }).first().click()
    const preview = page.getByRole('region', { name: '文件预览', exact: true })
    await preview.getByText('beta', { exact: true }).waitFor()
    return { context, page, preview, owner }
  }

  it('saves an edit, keeps both versions on a conflict, overwrites only after a confirmation, and tells the next turn', async () => {
    const { context, page, preview, owner } = await open(1440, 900)
    try {
      await preview.getByRole('button', { name: '编辑', exact: true }).click()
      const editor = page.getByRole('region', { name: '编辑 notes.txt', exact: true })
      const area = editor.getByLabel('notes.txt 的内容', { exact: true })
      expect(await area.inputValue()).toBe('alpha\nbeta\n')
      await area.fill('alpha\nbeta\ngamma')
      await editor.getByText('未保存', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUT}/editing-1440-light.png`, animations: 'disabled' })
      await editor.getByRole('button', { name: '保存', exact: true }).click()
      await preview.getByText('gamma', { exact: true }).waitFor()
      await preview.getByRole('status').filter({ hasText: '已保存' }).waitFor()
      // The file's final newline stays.
      expect(await readFile(notes(), 'utf8')).toBe('alpha\nbeta\ngamma\n')

      // Someone else writes while the editor is open: both versions stay, nothing is lost.
      await preview.getByRole('button', { name: '编辑', exact: true }).click()
      await area.fill('mine\n')
      await writeFile(notes(), 'theirs\n')
      await editor.getByRole('button', { name: '保存', exact: true }).click()
      await editor.getByText('文件现在的内容', { exact: true }).waitFor()
      await editor.locator('.file-editor-version-text', { hasText: 'theirs' }).waitFor()
      await editor.locator('.file-editor-version-text', { hasText: 'mine' }).waitFor()
      expect(await readFile(notes(), 'utf8')).toBe('theirs\n')
      await editor.getByRole('button', { name: '复制我的', exact: true }).click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('mine\n')
      await page.screenshot({ path: `${OUT}/conflict-1440-light.png`, animations: 'disabled' })
      // Another tab and back: the conflict and the person's text are still there.
      await page.getByRole('tab', { name: '文件', exact: true }).click()
      await editor.waitFor({ state: 'detached' })
      await page.getByRole('tab', { name: /notes\.txt/u }).click()
      await editor.locator('.file-editor-version-text', { hasText: 'mine' }).waitFor()
      await editor.locator('.file-editor-version-text', { hasText: 'theirs' }).waitFor()
      await editor.getByRole('button', { name: '用我的覆盖', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '用你的修改覆盖？', exact: true })
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      expect(await readFile(notes(), 'utf8')).toBe('theirs\n')
      await editor.getByRole('button', { name: '用我的覆盖', exact: true }).click()
      await confirm.getByRole('button', { name: '覆盖', exact: true }).click()
      await preview.getByText('mine', { exact: true }).waitFor()
      expect(await readFile(notes(), 'utf8')).toBe('mine\n')

      // Closing the tab with unsaved text asks first; 取消 keeps the text, 放弃 closes the tab and forgets it.
      await preview.getByRole('button', { name: '编辑', exact: true }).click()
      await area.fill('mine\nunsaved\n')
      await closeActiveFile(page)
      const discard = page.getByRole('dialog', { name: '放弃你的修改？', exact: true })
      await discard.getByRole('button', { name: '取消', exact: true }).click()
      expect(await area.inputValue()).toBe('mine\nunsaved\n')
      await closeActiveFile(page)
      await discard.getByRole('button', { name: '放弃', exact: true }).click()
      await page.getByRole('tab', { name: /notes\.txt/u }).waitFor({ state: 'detached' })
      expect(await readFile(notes(), 'utf8')).toBe('mine\n')
      // Nothing is left behind to ask about later.
      await page.locator('.transcript').getByRole('button', { name: '预览文件：notes.txt', exact: true }).first().click()
      await preview.getByText('mine', { exact: true }).waitFor()
      expect(await page.getByRole('region', { name: '编辑 notes.txt', exact: true }).count()).toBe(0)

      // 改动 calls it the person's own change.
      const session = await owner.json<ChangeList>(`tasks/${sessionId}/changes?scope=session`)
      expect(session.files.find(file => file.path === 'notes.txt')).toMatchObject({ byPerson: true })

      // The Agent's next turn reads that the person edited the file.
      prompts.length = 0
      await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '继续', requestId: randomUUID() } })
      await expect.poll(() => prompts.at(-1) ?? '', { timeout: 15_000 }).toContain('用户编辑了 notes.txt')
      expect(splitChangeNote(prompts.at(-1)!).text).toBe('继续')
      await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
    } finally {
      await context.close()
    }
  })

  for (const [width, theme] of [
    [390, 'light'],
    [320, 'dark'],
    [768, 'dark'],
  ] as const) {
    it(`edits at ${width}px (${theme}); a phone gets a full-screen page with the bar above the keyboard`, async () => {
      await writeFile(notes(), 'alpha\nbeta\n')
      const { context, page, preview } = await open(width, 700, theme)
      try {
        await preview.getByText('alpha', { exact: true }).waitFor()
        await preview.getByRole('button', { name: '编辑', exact: true }).click()
        const editor = page.getByRole('region', { name: '编辑 notes.txt', exact: true })
        const box = (await editor.boundingBox())!
        if (width < 768) expect([box.x, box.y, box.width]).toEqual([0, 0, width])
        const area = editor.getByLabel('notes.txt 的内容', { exact: true })
        await area.fill(`alpha\nbeta\n${width}\n`)
        const save = editor.getByRole('button', { name: '保存', exact: true })
        const bar = (await save.boundingBox())!
        if (width < 768) {
          expect(bar.y).toBeLessThan(80)
          expect(bar.height).toBeGreaterThanOrEqual(44)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await page.screenshot({ path: `${OUT}/editing-${width}-${theme}.png`, animations: 'disabled' })
        // 取消 with unsaved text asks first and keeps the text.
        await editor.getByRole('button', { name: '取消', exact: true }).click()
        await page.getByRole('button', { name: '放弃', exact: true }).waitFor()
        await page.screenshot({ path: `${OUT}/discard-${width}-${theme}.png`, animations: 'disabled' })
        await page.getByRole('button', { name: '取消', exact: true }).last().click()
        expect(await area.inputValue()).toBe(`alpha\nbeta\n${width}\n`)
        await save.click()
        await preview.getByText(String(width), { exact: true }).waitFor()
        expect(await readFile(notes(), 'utf8')).toBe(`alpha\nbeta\n${width}\n`)
        if (width === 390) {
          // The two versions stack on a phone, with both choices in reach.
          await preview.getByRole('button', { name: '编辑', exact: true }).click()
          await area.fill('mine on the phone\n')
          await writeFile(notes(), 'theirs\n')
          await save.click()
          await editor.locator('.file-editor-version-text', { hasText: 'theirs' }).waitFor()
          await editor.getByRole('button', { name: '用我的覆盖', exact: true }).waitFor()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
          await page.screenshot({ path: `${OUT}/conflict-${width}-${theme}.png`, animations: 'disabled' })
          await editor.getByRole('button', { name: '放弃我的', exact: true }).click()
          await page.getByRole('button', { name: '放弃', exact: true }).click()
          await preview.getByText('theirs', { exact: true }).waitFor()
          expect(await readFile(notes(), 'utf8')).toBe('theirs\n')
        }
      } finally {
        await context.close()
      }
    })
  }
})
