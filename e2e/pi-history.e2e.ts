import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import { FAKE_PI_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/pi-history'

/** pi's directory name for a folder (pi 1.5.0 `getDefaultSessionDirPath`). */
const folderName = (cwd: string) => `--${cwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`
const line = (value: unknown) => `${JSON.stringify(value)}\n`

/** One session file as pi writes it, its entries chained by `parentId`. */
async function piSession(directory: string, cwd: string, entries: Array<Record<string, unknown>>): Promise<string> {
  const id = randomUUID()
  const path = join(directory, `2026-11-19T10-00-00-000Z_${id}.jsonl`)
  let parentId: string | null = null
  const body = entries.map((entry, index) => {
    const item = { id: `e${index}`, parentId, timestamp: `2026-11-19T10:00:0${index}.000Z`, ...entry }
    parentId = item.id
    return line(item)
  })
  await writeFile(path, line({ type: 'session', version: 3, id, timestamp: '2026-11-19T10:00:00.000Z', cwd }) + body.join(''))
  return path
}

/** pi with its session store in a temporary home that the test Host may read (`cliStore`): import, trust, delete. */
describe('pi sessions brought in from its own files', () => {
  let root: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let store: string
  let earlier: string
  let log: string

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'latch-e2e-pi-history-')))
    const home = join(root, 'home')
    const agent = join(home, '.pi', 'agent')
    const workspaceRoot = join(root, 'workspace')
    const main = join(workspaceRoot, 'app')
    await mkdir(join(main, '.pi'), { recursive: true })
    store = join(agent, 'sessions', folderName(main))
    await mkdir(store, { recursive: true })
    await writeFile(join(agent, 'trust.json'), JSON.stringify({ [main]: true }))
    log = join(root, 'pi.log')
    earlier = await piSession(store, main, [
      { type: 'message', message: { role: 'user', content: 'Why does the build fail?' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the config.' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'vite.config.ts' } },
          ],
        },
      },
      { type: 'message', message: { role: 'toolResult', toolCallId: 't1', toolName: 'read', isError: false, content: [] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'The alias points nowhere.' }] } },
      { type: 'thinking_level_change', thinkingLevel: 'medium' },
      { type: 'session_info', name: 'Build failure' },
    ])
    await piSession(store, join(root, 'elsewhere'), [{ type: 'message', message: { role: 'user', content: 'Not this project' } }])
    host = await startTestHost({ workspaceRoot, cliStore: { home } })
    owner = await host.enroll({ listener: 'unix' })
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'pi',
        name: 'pi',
        presetId: 'pi',
        command: process.execPath,
        args: [FAKE_PI_AGENT],
        env: { PI_CODING_AGENT_DIR: agent, FAKE_PI_SESSIONS: store, FAKE_PI_LOG: log },
      },
    })
    expect(saved.status).toBe(201)
    const added = await owner.addFolders({ name: 'App', paths: [main] })
    expect(added.status).toBe(201)
    const projectId = ((await added.json()) as { workspace: { id: string } }).workspace.id
    await owner.json('preferences', { method: 'PUT', body: { defaults: { workspaceId: projectId, harnessId: 'pi' } } })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })

  const open = async (width: number, theme: 'light' | 'dark'): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width, height: width < 768 ? 844 : 900 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    const name = `pi ${randomUUID()}`
    await enrollBrowser(page, host, { name, scopes: ['admin'] })
    const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
    const id = devices.devices.find(item => item.name === name)!.id
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
    if (width >= 768) await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).click()
    else await page.locator('.phone-list').getByRole('button', { name: '新建会话', exact: true }).click()
    return page
  }
  const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
  const trace = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const tasks = async () => (await owner.json<AppSnapshot>('snapshot')).tasks

  it('lists and previews pi’s sessions without starting pi, imports one and continues it there', async () => {
    const page = await open(1440, 'light')
    await page.getByRole('button', { name: '接入已有会话', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '接入已有会话', exact: true })
    await dialog.locator('.history-row').first().waitFor()
    expect(await dialog.locator('.history-row-title').allTextContents()).toEqual(['Build failure'])
    expect(await dialog.textContent()).not.toContain('Not this project')
    await shot(page, 'list-1440-light')
    await dialog.getByRole('button', { name: /Build failure/u }).click()
    await dialog.locator('.history-message[data-role="user"]').first().waitFor()
    const text = (await dialog.locator('.history-messages').textContent()) ?? ''
    expect(text).toContain('Why does the build fail?')
    expect(text).toContain('The alias points nowhere.')
    await shot(page, 'preview-1440-light')
    expect(await trace()).toEqual([])
    const before = await readFile(earlier, 'utf8')
    await dialog.getByRole('button', { name: '接入', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.topbar-imported', { hasText: '已接入' }).waitFor()
    expect(await readFile(earlier, 'utf8')).toBe(before)
    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.fill('go on')
    await composer.press('Enter')
    await page.locator('.transcript').getByText('echo: go on', { exact: true }).waitFor()
    expect((await trace()).some(entry => entry.includes('"type":"switch_session"') && entry.includes(earlier))).toBe(true)
    // What pi's own settings decide beside the mode: its trust in this project's .pi.
    await page.locator('.composer-permission').click()
    await page.locator('.permission-in-effect').getByText('.pi 已信任：会加载', { exact: true }).waitFor()
    await shot(page, 'permission-1440-light')
    await page.context().close()
  })

  it('shows the list and the permission panel at phone width in dark', async () => {
    const page = await open(390, 'dark')
    await page.getByRole('button', { name: '接入已有会话', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '接入已有会话', exact: true })
    await dialog.locator('.history-row[data-imported]').getByText('已接入', { exact: true }).waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'list-390-dark')
    // The row of a session brought in opens it.
    await dialog.locator('.history-row[data-imported]').click()
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.composer-permission').click()
    await page.locator('.permission-in-effect').getByText('.pi 已信任：会加载', { exact: true }).waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'permission-390-dark')
    expect(existsSync(earlier)).toBe(true)
    expect((await tasks()).filter(task => task.imported)).toHaveLength(1)
    await page.context().close()
  })

  it('shows the same in desktop dark and phone light', async () => {
    for (const [width, theme] of [
      [1440, 'dark'],
      [390, 'light'],
    ] as const) {
      const page = await open(width, theme)
      await page.getByRole('button', { name: '接入已有会话', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '接入已有会话', exact: true })
      await dialog.locator('.history-row[data-imported]').getByText('已接入', { exact: true }).waitFor()
      await noHorizontalOverflow(page)
      await shot(page, `list-${width}-${theme}`)
      await dialog.locator('.history-row[data-imported]').click()
      await dialog.waitFor({ state: 'detached' })
      await page.locator('.composer-permission').click()
      await page.locator('.permission-in-effect').getByText('.pi 已信任：会加载', { exact: true }).waitFor()
      await noHorizontalOverflow(page)
      await shot(page, `permission-${width}-${theme}`)
      await page.context().close()
    }
  })
})
