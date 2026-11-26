import { chromium, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, phoneStartScreen } from './helpers/layout.ts'

const output = 'test-results/harness-launch-options'
const viewports = [
  { width: 820, theme: 'dark' },
  { width: 1440, theme: 'light' },
  { width: 390, theme: 'dark' },
] as const
const cases = [
  { id: 'cursor', choice: 'Agent --force', value: 'agent-force', flag: '--force', ordinary: 'Agent', mode: 'agent' },
  { id: 'antigravity', choice: '不再询问', value: 'turbo', flag: '--dangerously-skip-permissions', ordinary: '默认', mode: 'default' },
].flatMap(harness => viewports.map(viewport => ({ ...harness, ...viewport })))
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const row = (page: Page, name: string | RegExp) =>
  page
    .getByRole('menuitemradio', { name, exact: true })
    .or(page.getByRole('radio', { name, exact: true }))
    .or(page.getByRole('option', { name, exact: true }))
    .filter({ visible: true })

it.each(cases)('$id launch settings keep their provenance in a $width $theme menu', async scenario => {
  const { id, choice, value, flag, ordinary, mode, width, theme } = scenario
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
    FAKE_ACP_MODES: id === 'cursor' ? 'ask,plan,agent' : 'default,accept-edits,auto,plan',
    FAKE_ACP_INITIAL_MODE: mode,
    ...(id === 'cursor' ? { FAKE_CURSOR_STARTUP: '1' } : {}),
  }
  const command = join(bin, preset.command)
  // agy's version probe expects plain semver; its quota command runs alongside the session.
  const probes = id === 'antigravity' ? ['if [ "$1" = --version ]; then echo 1.5.17; exit 0; fi', 'if [ "$1" = -p ]; then exit 0; fi'] : []
  await writeFile(
    command,
    [
      '#!/bin/sh',
      ...probes,
      ...Object.entries(env).map(([key, val]) => `export ${key}=${quote(val)}`),
      `exec ${quote(process.execPath)} ${quote(FAKE_ACP_AGENT)} "$@"`,
      '',
    ].join('\n'),
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
    // A phone opens on its list (cae787a4): the draft's chips are on the start screen 新建会话 pushes.
    await phoneStartScreen(page)
    await chip('模型').click()
    const refresh = page
      .getByRole('menuitem', { name: '刷新模型列表', exact: true })
      .or(page.getByRole('button', { name: '刷新模型列表', exact: true }))
    await refresh.waitFor()
    if (id === 'antigravity') await refresh.click()
    await page.keyboard.press('Escape')
    await expect.poll(() => chip('模型').getAttribute('aria-expanded')).toBe('false')
    const control = '权限'
    await chip(control).click()
    await row(page, choice).click()
    // The permission's popover stays open on a choice (4bb97f33); on a phone it is a sheet over the input. Close it.
    await page.keyboard.press('Escape')
    await expect.poll(() => chip(control).getAttribute('aria-expanded')).toBe('false')
    const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
    const submit = () =>
      width < 600 ? page.locator('.workbench-home').getByRole('button', { name: '发送', exact: true }).click() : input.press('Meta+Enter')
    await input.fill('echo first')
    await submit()
    const elsewhere = row(page, /^不选项目/u)
    if (
      await elsewhere.waitFor({ timeout: 2_000 }).then(
        () => true,
        () => false,
      )
    ) {
      await elsewhere.click()
      await submit()
    }
    await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(1)
    const sessionId = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!.id
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await expect.poll(async () => (await detail()).summary.status, { timeout: 15_000 }).toBe('idle')
    const configId = 'mode'
    expect((await detail()).config?.find(option => option.id === configId)).toMatchObject({
      currentValue: value,
      source: 'launch',
    })
    // Where the mode comes from is the chip's fine print, on hover and read with it (753f8ab4), not a row of the menu.
    await expect
      .poll(() =>
        chip(control).evaluate(element =>
          (element.getAttribute('aria-describedby') ?? '')
            .split(' ')
            .map(id => document.getElementById(id)?.textContent ?? '')
            .join(''),
        ),
      )
      .toContain('启动设置 · 未独立读回')
    await chip(control).click()
    await row(page, ordinary).waitFor()
    if (id === 'antigravity') await row(page, '由模型判断').waitFor()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${output}/${id}-${width}-${theme}.png`, animations: 'disabled' })
    await row(page, ordinary).click()
    await expect
      .poll(async () => (await detail()).config?.find(option => option.id === configId)?.currentValue, { timeout: 15_000 })
      .toBe(mode)
    const records = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; argv?: string[] })
    const starts = records.filter(item => item.event === 'start')
    expect(starts.length).toBeGreaterThanOrEqual(3) // catalogue, first turn, idle restart
    expect(starts.some(item => item.argv?.includes(flag))).toBe(true)
    expect(starts.at(-1)!.argv).not.toContain(flag)
    expect((await detail()).config?.find(option => option.id === 'mode')?.source).toBeUndefined()
  } catch (error) {
    await page.screenshot({ path: `${output}/${id}-${width}-${theme}-failed.png`, animations: 'disabled' })
    throw error
  } finally {
    await browser.close()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
