import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const time = new Date('2026-11-17T06:00:00.000Z')
const OUTPUT = 'test-results/harness-extensions'

/** Opens 设置 › 扩展 and, when named, that Harness's page. */
async function openExtensions(page: Page, harness?: string) {
  const settings = await openSettings(page)
  await openSection(settings, '扩展')
  if (harness) await settings.getByRole('button', { name: new RegExp(`^${harness}`, 'u') }).click()
  return settings
}

it('lists per Harness what it reports, says plainly what it does not, and offers the vendor’s own commands without running them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-e2e-extensions-'))
  const bin = join(root, 'bin')
  const program = join(bin, 'codex')
  await mkdir(bin)
  await writeFile(program, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(program, 0o755)
  const log = join(root, 'agent.jsonl')
  const project = join(root, 'project')
  await mkdir(project)
  const skills = join(root, 'skills.json')
  await writeFile(
    skills,
    // Fourteen: more than the page shows before 全部.
    JSON.stringify([
      { name: 'review', description: '按清单审查改动', path: join(root, 'skills', 'SKILL.md'), scope: 'repo', enabled: true },
      ...Array.from({ length: 13 }, (_, index) => ({
        name: `user-skill-${index + 1}`,
        path: join(root, 'skills', `${index}`, 'SKILL.md'),
        scope: 'user',
        enabled: true,
      })),
    ]),
  )
  // A developer's plugin with code: listed only under 本机开发者.
  const developer: HarnessPlugin = {
    id: 'dev-tool',
    name: '开发中的工具',
    version: '0.1.0',
    description: '只在测试中使用。',
    activate(context) {
      context.registerTool({
        name: 'dev_echo',
        description: 'Echo.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        requiresApproval: false,
        async execute() {
          return { text: 'ok' }
        },
      })
    },
  }
  const commands = join(root, 'commands.json')
  await writeFile(commands, JSON.stringify([{ name: 'public-plan', description: '检查计划' }]))
  const host = await startTestHost({
    demo: false,
    plugins: [developer],
    now: () => time.getTime(),
    commandDirectories: () => [bin],
    loginPrograms: name => (name === 'codex' ? program : undefined),
    detectPreset: preset => (preset.id === 'codex' ? { found: true, path: program } : { found: false }),
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const workspace = ((await (await owner.addFolders({ paths: [project], name: '扩展项目' })).json()) as { workspace: WorkspaceInfo })
      .workspace
    await owner.confirmedJson('agents', {
      body: {
        id: 'codex',
        name: 'Codex',
        presetId: 'codex',
        command: 'codex',
        args: [],
        env: {
          FAKE_ACP_LOG: log,
          FAKE_CODEX_SKILLS_FILE: skills,
          FAKE_CODEX_STATE: join(root, 'threads.json'),
          FAKE_CODEX_MCP: JSON.stringify([{ name: 'files', runtimeStatus: 'connected', tools: { read: {} }, authStatus: 'unsupported' }]),
        },
      },
    })
    await owner.confirmedJson('agents', {
      body: {
        id: 'fake',
        name: '测试 Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_LOG: log, FAKE_ACP_STATE: join(root, 'state.json'), FAKE_ACP_COMMANDS_FILE: commands },
      },
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })

    // ---- Before any session: a kind the Harness reports waits for one; one it does not report says so ----
    let settings = await openExtensions(page, 'Codex')
    const codex = settings.locator('[data-extensions-harness="codex"]')
    const group = (name: string) => codex.getByRole('region', { name, exact: true })
    await group('技能').getByText('还没有会话报告', { exact: true }).waitFor()
    await group('插件').getByText('尚未实现', { exact: true }).waitFor()
    expect(await group('插件').locator('.extension-command code').allInnerTexts()).toEqual(['codex plugin add', 'codex plugin remove'])
    expect(await group('技能').getByText('没有安装命令', { exact: true }).count()).toBe(1)
    // This browser is not this Mac's desktop: copy only, nothing is typed into a terminal from here.
    expect(await settings.getByRole('button', { name: '在终端里打开' }).count()).toBe(0)

    // ---- Each Harness runs one session; the page then lists what each reported ----
    for (const harnessId of ['codex', 'fake']) {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId, workspaceId: workspace.id, prompt: 'plan', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'), {
        timeout: 20_000,
      })
    }
    const startsBefore = (await readFile(log, 'utf8')).split('\n').filter(line => line.includes('"start"')).length
    await page.reload()
    settings = await openExtensions(page, 'Codex')
    const skill = group('技能').locator('[data-extension="skill:$review"]')
    await skill.getByText('review', { exact: true }).waitFor()
    await skill.getByText('Harness 自带', { exact: true }).waitFor()
    await skill.getByText('项目', { exact: true }).waitFor()
    await group('技能')
      .getByText(/会话报告于 .* · 扩展项目/u)
      .waitFor()
    await group('技能').getByText('还有 2 个', { exact: true }).waitFor()
    expect(await group('技能').locator('[data-extension^="skill:"]').count()).toBe(12)
    await group('技能').getByRole('button', { name: '全部', exact: true }).click()
    expect(await group('技能').locator('[data-extension^="skill:"]').count()).toBe(14)
    const mcp = group('MCP').locator('[data-harness-mcp="files"]')
    await mcp.getByText('可用 · 1 个工具', { exact: true }).waitFor()
    await mcp.getByText('Harness 自带', { exact: true }).waitFor()
    await mcp.getByRole('button', { name: '复制卸载 files 的命令' }).waitFor()
    expect(await group('MCP').locator('.extension-command code').allInnerTexts()).toEqual(['codex mcp add', 'codex mcp remove'])
    await noHorizontalOverflow(page)

    await mkdir(OUTPUT, { recursive: true })
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [820, 'light'],
      [390, 'light'],
      [390, 'dark'],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height: 1100 },
        locale: 'zh-CN',
        colorScheme: theme,
        reducedMotion: 'reduce',
      })
      await context.clock.setFixedTime(time)
      try {
        const view = await context.newPage()
        await enrollBrowser(view, host, { scopes: ['view', 'run', 'admin'] })
        const list = await openExtensions(view)
        await list.getByRole('button', { name: /^测试 Agent/u }).waitFor()
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUTPUT}/list--${width}-${theme}.png`, animations: 'disabled', fullPage: true })
        await list.getByRole('button', { name: /^Codex/u }).click()
        await list.locator('[data-extension="skill:$review"]').waitFor()
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUTPUT}/codex--${width}-${theme}.png`, animations: 'disabled', fullPage: true })
      } finally {
        await context.close()
      }
    }

    // ---- A Harness without a preset: its commands as reported; no command Latch could claim is the vendor's ----
    settings = await openExtensions(page, '测试 Agent')
    const fake = settings.locator('[data-extensions-harness="fake"]')
    await fake.locator('[data-extension="command:public-plan"]').getByText('Harness 自带', { exact: true }).waitFor()
    await fake.getByRole('region', { name: '技能', exact: true }).getByText('这个 Harness 没有报告', { exact: true }).waitFor()
    await fake.getByRole('region', { name: 'MCP', exact: true }).getByText('这个 Harness 没有报告', { exact: true }).waitFor()
    expect(await fake.locator('.extension-command').count()).toBe(0)

    // ---- Latch's own: built-ins are not listed; a developer's code plugin only under 本机开发者 ----
    await openSection(settings, '扩展')
    await settings.getByRole('button', { name: /^本机开发者/u }).click()
    await settings.locator('[data-latch-code="dev-tool"]').getByText('可信的本机代码', { exact: true }).waitFor()
    expect(await settings.locator('[data-latch-code]').count()).toBe(1)
    await page.screenshot({ path: `${OUTPUT}/developer--1440-light.png`, animations: 'disabled', fullPage: true })

    // ---- One place: 设置 › MCP and the Harness's own page link here ----
    await openSection(settings, 'MCP')
    await settings.getByRole('button', { name: /^Harness 自己的 MCP/u }).click()
    await settings.getByRole('button', { name: /^Codex/u }).waitFor()
    await openSection(settings, 'Harness')
    await settings.getByRole('button', { name: '编辑 Codex', exact: true }).click()
    await settings.getByRole('button', { name: /^技能、命令、MCP 与插件/u }).click()
    await settings.locator('[data-extensions-harness="codex"]').waitFor()
    // Leaving and coming back shows the list again.
    await openSection(settings, 'MCP')
    await openSection(settings, '扩展')
    await settings.getByRole('button', { name: /^测试 Agent/u }).waitFor()

    // Reading the page started no program.
    expect((await readFile(log, 'utf8')).split('\n').filter(line => line.includes('"start"')).length).toBe(startsBefore)
  } finally {
    await browser.close()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
