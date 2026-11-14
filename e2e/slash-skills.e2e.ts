import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, webkit } from '@playwright/test'
import { expect, it } from 'vitest'
import type { HarnessCommandCatalogue, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession } from './helpers/layout.ts'

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

it.each(['chromium', 'webkit'] as const)('inserts native skills without sending and refreshes their current source on %s', async engine => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-slash-skills-')))
  let host: Awaited<ReturnType<typeof startTestHost>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const command = join(root, 'codex'),
      log = join(root, 'native.jsonl'),
      skillFile = join(root, 'skills.json')
    const rows = Array.from({ length: 205 }, (_, index) => ({
      name: `check-${String(index).padStart(3, '0')}`,
      description: index === 0 ? '检查改动' : `检查步骤 ${index}`,
      path: `/private/native-skill/${index}/SKILL.md`,
      scope: index % 2 ? 'user' : 'repo',
      enabled: true,
    }))
    await writeFile(skillFile, JSON.stringify(rows))
    await writeFile(
      command,
      `#!/bin/sh\nexport FAKE_ACP_LOG=${quoted(log)} FAKE_CODEX_SKILLS_FILE=${quoted(skillFile)} FAKE_CODEX_STATE=${quoted(join(root, 'threads.json'))}\nexec ${quoted(process.execPath)} ${quoted(FAKE_CODEX_APP_SERVER)} "$@"\n`,
    )
    await chmod(command, 0o755)
    const project = join(root, 'project')
    await mkdir(project)
    host = await startTestHost({
      commandDirectories: () => [dirname(command)],
      loginPrograms: name => (name === 'codex' ? command : undefined),
    })
    const owner = await host.enroll({ listener: 'unix' })
    const { workspace } = (await (await owner.addFolders({ paths: [project], name: '技能项目' })).json()) as { workspace: WorkspaceInfo }
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'codex', workspaceId: workspace.id, mode: 'agent', prompt: 'Hello', requestId: randomUUID() },
    })
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    await owner.json('preferences', {
      method: 'PUT',
      body: { defaults: { harnessId: 'codex', workspaceId: workspace.id, mode: 'agent', pinned: true } },
    })
    const catalogue = () =>
      owner.json<{ catalogue: HarnessCommandCatalogue | null }>('agents/codex/commands', {
        method: 'POST',
        body: { workspaceId: workspace.id, mode: 'agent' },
      })
    await expect.poll(async () => (await catalogue()).catalogue?.skills?.length).toBe(200)
    browser = await (engine === 'webkit' ? webkit.launch() : chromium.launch(browserLaunchOptions()))
    const output = `test-results/slash-skills/${engine}`
    await mkdir(output, { recursive: true })
    for (const width of [1440, 768, 390])
      for (const theme of ['light', 'dark'] as const) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
        const page = await context.newPage()
        try {
          await enrollBrowser(page, host)
          await connected(page)
          await openSession(page, sessionId)
          const input = page.getByRole('textbox', { name: '继续对话', exact: true })
          const list = page.getByRole('listbox', { name: '命令与提示模板', exact: true })
          const before = (await detail()).messages.length
          await input.fill('/')
          await list.waitFor()
          expect(await list.getByRole('option', { selected: true }).count()).toBe(0)
          const skills = list.getByRole('group', { name: '技能', exact: true })
          expect(await skills.getByRole('option').count()).toBe(200)
          await list.getByText('仅列出部分技能', { exact: true }).waitFor()
          await input.fill('/compact')
          await list.getByText('仅列出部分技能', { exact: true }).waitFor()
          await input.fill('/')
          const last = skills.getByRole('option').last()
          await last.click()
          expect(await input.inputValue()).toBe('$check-199 ')
          expect((await detail()).messages.length).toBe(before)
          await input.fill('/check-000')
          await input.press('Enter')
          expect(await input.inputValue()).toBe('$check-000 ')
          expect((await detail()).messages.length).toBe(before)
          await input.fill('请 /check-001')
          await input.press('Tab')
          expect(await input.inputValue()).toBe('请 $check-001 ')
          expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
          expect((await detail()).messages.length).toBe(before)
          await input.fill('/check')
          await list.waitFor()
          expect(await list.getByRole('option').count()).toBe(200)
          expect(await list.getByRole('option').first().innerText()).toContain('技能 · 项目')
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${output}/menu-${width}-${theme}.png`, animations: 'disabled' })
        } catch (error) {
          await page.screenshot({ path: `${output}/failure-${width}-${theme}.png`, animations: 'disabled' })
          throw error
        } finally {
          await context.close()
        }
      }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await enrollBrowser(page, host)
    await connected(page)
    const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await draft.fill('/check-000')
    const list = page.getByRole('listbox', { name: '命令与提示模板', exact: true })
    await list.getByRole('option').first().waitFor()
    expect(await list.getByRole('option').first().innerText()).toContain('技能（上次会话）')
    await draft.press('Enter')
    expect(await draft.inputValue()).toBe('$check-000 ')
    const nativeLog = () => readFile(log, 'utf8')
    const promptsBefore = (await nativeLog()).split('\n').filter(line => line.includes('"method":"turn/start"')).length
    await openSession(page, sessionId)
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('/check-000')
    await input.press('Tab')
    await input.press('End')
    await input.press('Control+Enter')
    await expect
      .poll(async () => (await detail()).messages.filter(message => message.role === 'user' && message.text === '$check-000').length)
      .toBe(1)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    const calls = (await nativeLog())
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { method?: string; params?: { input?: unknown[] } })
    const prompts = calls.filter(call => call.method === 'turn/start')
    expect(prompts.length).toBe(promptsBefore + 1)
    expect(prompts.at(-1)?.params?.input).toContainEqual({ type: 'skill', name: 'check-000', path: rows[0]!.path })
    await writeFile(skillFile, JSON.stringify([{ ...rows[0], name: 'fresh-check' }]))
    await input.fill('skills-changed')
    await input.press('Control+Enter')
    await expect.poll(async () => (await detail()).skills?.map(skill => skill.name)).toEqual(['fresh-check'])
    await input.fill('/')
    await list.waitFor()
    const currentSkills = list.getByRole('group', { name: '技能', exact: true })
    await expect.poll(() => currentSkills.getByRole('option').count()).toBe(1)
    expect(await currentSkills.innerText()).toContain('$fresh-check')
    expect(await list.getByText('仅列出部分技能', { exact: true }).count()).toBe(0)
    expect(await list.getByRole('group', { name: '最近', exact: true }).count()).toBe(0)
    expect(await page.locator('body').innerText()).not.toContain('/private/native-skill/')
    await page.screenshot({ path: `${output}/refreshed.png`, animations: 'disabled' })
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await host?.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
