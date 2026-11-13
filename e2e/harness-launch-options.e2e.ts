import { chromium, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const output = 'test-results/harness-launch-options'
const cases = [
  { id: 'gemini', width: 820, theme: 'dark' },
  { id: 'gemini', width: 390, theme: 'light' },
  { id: 'cursor', width: 1440, theme: 'light' },
  { id: 'cursor', width: 390, theme: 'dark' },
] as const
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const row = (page: Page, name: string) =>
  page
    .getByRole('menuitemradio', { name, exact: true })
    .or(page.getByRole('radio', { name, exact: true }))
    .or(page.getByRole('option', { name, exact: true }))
    .first()

it.each(cases)('$id launch settings keep their provenance in a $width $theme menu', async ({ id, width, theme }) => {
  const root = await mkdtemp(join(tmpdir(), 'latch-launch-options-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  await mkdir(output, { recursive: true })
  const preset = AGENT_PRESETS.find(item => item.id === id)!
  const log = join(root, 'agent.log')
  const env: Record<string, string> = {
    FAKE_ACP_LOG: log,
    FAKE_ACP_STATE: join(root, 'state.json'),
    FAKE_ACP_CONFIG: 'options',
    FAKE_ACP_CAPS: 'resume',
    ...(id === 'gemini'
      ? {
          FAKE_ACP_MODES: 'plan,default,autoEdit,yolo',
          FAKE_ACP_INITIAL_MODE: 'default',
          FAKE_ACP_MODELS: 'gemini-3.1-pro-preview',
          FAKE_ACP_NO_THINKING: '1',
        }
      : { FAKE_ACP_MODES: 'ask,plan,agent', FAKE_ACP_INITIAL_MODE: 'agent', FAKE_CURSOR_STARTUP: '1' }),
  }
  const command = join(bin, preset.command)
  await writeFile(
    command,
    `#!/bin/sh\n${Object.entries(env)
      .map(([key, value]) => `export ${key}=${quote(value)}`)
      .join('\n')}\nexec ${quote(process.execPath)} ${quote(FAKE_ACP_AGENT)} "$@"\n`,
  )
  await chmod(command, 0o755)
  const host = await startTestHost({
    demo: false,
    sessionFolders: true,
    commandDirectories: () => [bin],
    detectPreset: item => (item.id === id ? { found: true, path: command } : { found: false }),
  })
  const owner = await host.enroll({ listener: 'unix' })
  const browser = await chromium.launch(browserLaunchOptions())
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, locale: 'zh-CN', reducedMotion: 'reduce' })
  page.setDefaultTimeout(20_000)
  const chip = (name: string) =>
    page
      .getByRole('button', { name: new RegExp(`^${name}：`, 'u') })
      .filter({ visible: true })
      .first()
  try {
    expect(
      (
        await owner.confirmed('agents', {
          method: 'POST',
          body: { id, name: preset.name, presetId: id, command: preset.command, args: preset.args, env: {} },
        })
      ).status,
    ).toBe(201)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await connected(page)
    if (width < 600) await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
    await chip('模型').click()
    await page.getByText('刷新模型列表', { exact: true }).first().waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => chip('模型').getAttribute('aria-expanded')).toBe('false')
    const control = id === 'gemini' ? '思考' : '权限'
    const choice = id === 'gemini' ? '低' : 'Agent --force'
    await chip(control).click()
    await row(page, choice).click()
    const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await input.fill('echo first')
    await input.press('Meta+Enter')
    const elsewhere = page.getByText(/ 在一个新的空文件夹里开始$/u)
    if (
      await elsewhere.waitFor({ timeout: 2_000 }).then(
        () => true,
        () => false,
      )
    ) {
      await elsewhere.click()
      await input.press('Meta+Enter')
    }
    await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(1)
    const sessionId = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!.id
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await expect.poll(async () => (await detail()).summary.status, { timeout: 15_000 }).toBe('idle')
    const configId = id === 'gemini' ? '~gemini-thinking' : 'mode'
    expect((await detail()).config?.find(option => option.id === configId)).toMatchObject({
      currentValue: id === 'gemini' ? 'low' : 'agent-force',
      source: 'launch',
    })
    await chip(control).click()
    await page.getByText('启动设置 · 未独立读回', { exact: true }).waitFor()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${output}/${id}-${width}-${theme}.png`, animations: 'disabled' })
    await row(page, id === 'gemini' ? '高' : 'Agent').click()
    await expect
      .poll(async () => (await detail()).config?.find(option => option.id === configId)?.currentValue, { timeout: 15_000 })
      .toBe(id === 'gemini' ? 'high' : 'agent')
    const records = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; argv?: string[] })
    const starts = records.filter(item => item.event === 'start')
    expect(starts.length).toBeGreaterThanOrEqual(3) // catalogue, first turn, idle restart
    if (id === 'cursor') {
      expect(starts.some(item => item.argv?.includes('--force'))).toBe(true)
      expect(starts.at(-1)?.argv).not.toContain('--force')
      expect((await detail()).config?.find(option => option.id === 'mode')?.source).toBeUndefined()
    }
  } catch (error) {
    await page.screenshot({ path: `${output}/${id}-${width}-${theme}-failed.png`, animations: 'disabled' })
    throw error
  } finally {
    await browser.close()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
