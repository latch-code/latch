import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ExtensionsResponse, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, FAKE_PI_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const time = new Date('2026-11-17T06:00:00.000Z')
const OUTPUT = 'test-results/harness-extensions'
const LONG_PLUGIN = `review-tools-${'extended-'.repeat(12)}commands`

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
  const programs = new Map([
    ['codex', FAKE_CODEX_APP_SERVER],
    ['pi', FAKE_PI_AGENT],
    ['claude-agent-acp', FAKE_ACP_AGENT],
  ])
  await mkdir(bin)
  for (const [name, fake] of programs) {
    const path = join(bin, name)
    await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`)
    await chmod(path, 0o755)
  }
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
  const piCommands = join(root, 'pi-commands.json')
  const writePiCommands = (entries: ReadonlyArray<{ name: string; directory: string }>) =>
    writeFile(
      piCommands,
      JSON.stringify(
        entries.map(({ name, directory }) => ({
          name,
          source: 'extension',
          sourceInfo: {
            origin: 'top-level',
            source: 'auto',
            scope: 'project',
            baseDir: join(project, '.pi'),
            path: join(project, '.pi', 'extensions', directory, 'index.ts'),
          },
        })),
      ),
    )
  await writePiCommands([
    { name: 'review-changes', directory: LONG_PLUGIN },
    { name: 'review-project', directory: LONG_PLUGIN },
    { name: 'preview-page', directory: 'page-preview' },
  ])
  const host = await startTestHost({
    demo: false,
    plugins: [developer],
    now: () => time.getTime(),
    commandDirectories: () => [bin],
    loginPrograms: name => (programs.has(name) ? join(bin, name) : undefined),
    detectPreset: preset => (programs.has(preset.command) ? { found: true, path: join(bin, preset.command) } : { found: false }),
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
    await owner.confirmedJson('agents', {
      body: { id: 'pi', name: 'pi', presetId: 'pi', command: 'pi', args: [], env: { FAKE_PI_COMMANDS_FILE: piCommands, FAKE_PI_LOG: log } },
    })
    await owner.confirmedJson('agents', {
      body: { id: 'claude-agent', name: 'Claude Code', presetId: 'claude-agent', command: 'claude-agent-acp', args: [], env: {} },
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })

    const capture = async (states: ReadonlyArray<{ harness: string; id: string; state: string; shown: string }>) => {
      await mkdir(OUTPUT, { recursive: true })
      for (const width of [390, 768, 1440]) {
        for (const theme of ['light', 'dark'] as const) {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 },
            locale: 'zh-CN',
            colorScheme: theme,
            reducedMotion: 'reduce',
            isMobile: width < 1000,
            hasTouch: width < 1000,
          })
          await context.clock.setFixedTime(time)
          await stillMotion(context)
          try {
            const view = await context.newPage()
            await enrollBrowser(view, host, { scopes: ['view', 'run', 'admin'] })
            for (const { harness, id, state, shown } of states) {
              const settings = await openExtensions(view, harness)
              const group = settings.locator(`[data-extensions-harness="${id}"]`).getByRole('region', { name: '插件', exact: true })
              await group.getByText(shown, { exact: true }).filter({ visible: true }).waitFor()
              await group.scrollIntoViewIfNeeded()
              await noHorizontalOverflow(view, group)
              await view.evaluate(async () => {
                await document.fonts.ready
                await new Promise<void>(resolve => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
                })
              })
              await view.screenshot({ path: `${OUTPUT}/${state}--${width}-${theme}.png`, animations: 'disabled' })
            }
          } finally {
            await context.close()
          }
        }
      }
    }

    // ---- Before any session: a kind this Harness reports waits for one ----
    let settings = await openExtensions(page, 'Codex')
    const codex = settings.locator('[data-extensions-harness="codex"]')
    const group = (name: string) => codex.getByRole('region', { name, exact: true })
    await group('技能').getByText('还没有会话报告', { exact: true }).hover()
    await page
      .getByRole('tooltip')
      .getByText(/新建普通会话并发送消息/u)
      .waitFor()
    await page.mouse.move(0, 0)
    const pending = group('插件').getByText('尚未实现', { exact: true })
    await pending.hover()
    await page
      .getByRole('tooltip')
      .getByText(/下载或更新账号里已安装的插件包/u)
      .waitFor()
    await page.mouse.move(0, 0)
    expect(await group('插件').locator('.extension-command code').allInnerTexts()).toEqual(['codex plugin add', 'codex plugin remove'])
    expect(await group('技能').getByText('没有安装命令', { exact: true }).count()).toBe(1)
    // This browser is not this Mac's desktop: copy only, nothing is typed into a terminal from here.
    expect(await settings.getByRole('button', { name: '在终端里打开' }).count()).toBe(0)

    await capture([
      { harness: 'Codex', id: 'codex', state: 'codex-before-session', shown: '尚未实现' },
      { harness: 'pi', id: 'pi', state: 'pi-before-session', shown: '还没有会话报告' },
    ])

    // ---- The page lists what each session reported ----
    const startSession = async (harnessId: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId, workspaceId: workspace.id, prompt: 'plan', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'), {
        timeout: 20_000,
      })
      return sessionId
    }
    for (const harnessId of ['codex', 'pi', 'fake']) await startSession(harnessId)
    await vi.waitFor(async () => {
      const extension = (await owner.json<ExtensionsResponse>('extensions')).harnesses.find(item => item.harnessId === 'pi')
      expect(extension?.report?.plugins?.names).toEqual([LONG_PLUGIN, 'page-preview'])
    })
    const skill = group('技能').locator('[data-extension="skill:$review"]')
    await skill.getByText('review', { exact: true }).waitFor()
    expect(await group('技能').getByRole('heading', { name: 'Harness 自带', exact: true }).count()).toBe(1)
    expect(await group('技能').getByRole('heading', { name: 'Latch 提供', exact: true }).count()).toBe(1)
    expect(await skill.getByText('Harness 自带', { exact: true }).count()).toBe(0)
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
    expect(await group('MCP').getByRole('heading', { name: 'Harness 自带', exact: true }).count()).toBe(1)
    expect(await mcp.getByText('Harness 自带', { exact: true }).count()).toBe(0)
    await mcp.getByRole('button', { name: '复制卸载 files 的命令' }).waitFor()
    expect(await group('MCP').locator('.extension-command code').allInnerTexts()).toEqual(['codex mcp add', 'codex mcp remove'])
    await noHorizontalOverflow(page)

    settings = await openExtensions(page, 'pi')
    const pi = settings.locator('[data-extensions-harness="pi"]').getByRole('region', { name: '插件', exact: true })
    const long = pi.locator('.extension-plugin-name').filter({ hasText: LONG_PLUGIN })
    await long.hover()
    expect(await long.evaluate(label => label.scrollWidth > label.clientWidth)).toBe(true)
    await page.getByRole('tooltip').getByText(LONG_PLUGIN, { exact: true }).waitFor()
    await page.mouse.move(0, 0)
    expect(await pi.locator('[data-extension^="plugin:"]').count()).toBe(2)
    expect(await pi.getByRole('heading', { name: 'Harness 自带', exact: true }).count()).toBe(1)
    expect(await pi.innerText()).not.toMatch(/(?:latch-permission|index\.ts|\.pi\/extensions)/u)
    await capture([
      { harness: 'Codex', id: 'codex', state: 'codex-after-session', shown: '尚未实现' },
      { harness: 'pi', id: 'pi', state: 'pi-extensions', shown: LONG_PLUGIN },
      { harness: 'Claude Code', id: 'claude-agent', state: 'claude-no-report', shown: '这个 Harness 没有报告' },
    ])

    // ---- A Harness without a preset: its commands as reported; no command Latch could claim is the vendor's ----
    settings = await openExtensions(page, '测试 Agent')
    const fake = settings.locator('[data-extensions-harness="fake"]')
    const plan = fake.locator('[data-extension="command:public-plan"]')
    await plan.getByText('/public-plan', { exact: true }).waitFor()
    expect(await plan.getByText('Harness 自带', { exact: true }).count()).toBe(0)
    expect(
      await fake.getByRole('region', { name: '命令', exact: true }).getByRole('heading', { name: 'Harness 自带', exact: true }).count(),
    ).toBe(1)
    await fake.getByRole('region', { name: '技能', exact: true }).getByText('这个 Harness 没有报告', { exact: true }).waitFor()
    await fake.getByRole('region', { name: 'MCP', exact: true }).getByText('这个 Harness 没有报告', { exact: true }).waitFor()
    expect(await fake.locator('.extension-command').count()).toBe(0)

    // These Host changes update the already-open settings page.
    settings = await openExtensions(page, 'pi')
    await writePiCommands([{ name: 'inspect-page', directory: 'replacement-tools' }])
    const source = await startSession('pi')
    const startsBefore = (await readFile(log, 'utf8')).split('\n').filter(line => line.includes('"start"')).length
    const previewRow = pi.locator('[data-extension="plugin:page-preview"]')
    const replacementRow = pi.locator('[data-extension="plugin:replacement-tools"]')
    await replacementRow.waitFor()
    await previewRow.waitFor({ state: 'hidden' })
    expect((await owner.request(`tasks/${source}`, { method: 'DELETE' })).status).toBe(200)
    await previewRow.waitFor()
    await replacementRow.waitFor({ state: 'hidden' })
    await owner.confirmedJson('agents/pi', {
      method: 'PUT',
      body: { env: { FAKE_PI_COMMANDS_FILE: join(root, 'different-commands.json') } },
    })
    await pi.getByText('还没有会话报告', { exact: true }).waitFor()
    await previewRow.waitFor({ state: 'hidden' })
    await owner.confirmedJson('agents/pi', { method: 'PUT', body: { env: { FAKE_PI_COMMANDS_FILE: piCommands } } })
    await previewRow.waitFor()
    expect((await owner.request(`workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(200)
    await pi.getByText('还没有会话报告', { exact: true }).waitFor()
    await previewRow.waitFor({ state: 'hidden' })

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
