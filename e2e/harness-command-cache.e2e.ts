import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page, type Route } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, HarnessCommandCatalogue, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

it('offers previous-session commands in a normal new draft after recovery without starting a CLI or sending the selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-command-cache-ui-'))
  let host: TestHost | undefined
  let browser: Browser | undefined
  let currentPage: Page | undefined
  const output = 'test-results/harness-command-cache'
  try {
    await mkdir(output, { recursive: true })
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const otherPath = join(root, 'other')
    await mkdir(otherPath)
    const log = join(root, 'agent.jsonl')
    const commandsFile = join(root, 'commands.json')
    await writeFile(commandsFile, JSON.stringify([{ name: 'public-plan', description: '检查当前计划' }]))
    const options = {
      dataDir: join(root, 'data'),
      workspaceRoot: join(root, 'default'),
      uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
    }
    host = await startTestHost(options)
    let owner = await host.enroll({ listener: 'unix' })
    const project = ((await (await owner.addFolders({ paths: [projectPath], name: '命令项目' })).json()) as { workspace: WorkspaceInfo })
      .workspace
    const other = ((await (await owner.addFolders({ paths: [otherPath], name: '另一个项目' })).json()) as { workspace: WorkspaceInfo })
      .workspace
    await owner.confirmedJson('agents', {
      body: {
        id: 'cached-agent',
        name: '菜单 Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: {
          FAKE_ACP_LOG: log,
          FAKE_ACP_STATE: join(root, 'agent-state.json'),
          FAKE_ACP_CAPS: 'load',
          FAKE_ACP_CONFIG: 'options',
          FAKE_ACP_COMMANDS_FILE: commandsFile,
        },
      },
    })
    await owner.json('preferences', {
      method: 'PUT',
      body: { defaults: { harnessId: 'cached-agent', workspaceId: project.id, mode: 'agent', pinned: true } },
    })
    const starts = async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { event: string })
        .filter(line => line.event === 'start').length
    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    currentPage = await context.newPage()
    await enrollBrowser(currentPage, host)
    const first = currentPage.getByRole('textbox', { name: '新会话消息', exact: true })
    await first.fill('plan')
    await first.press('Meta+Enter')
    await currentPage.locator('.transcript').getByText('planned', { exact: true }).waitFor()
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks
    expect(tasks).toHaveLength(1)
    const id = tasks[0]!.id
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')
    await expect
      .poll(
        async () =>
          (
            await owner.json<{ catalogue: HarnessCommandCatalogue | null }>('agents/cached-agent/commands', {
              method: 'POST',
              body: { workspaceId: project.id },
            })
          ).catalogue?.commands[0]?.name,
      )
      .toBe('public-plan')
    const before = await starts()
    expect(before).toBe(1)
    await context.close()
    currentPage = undefined
    await host.close()
    host = await startTestHost(options)
    owner = await host.enroll({ listener: 'unix' })
    for (const width of [1440, 768, 390])
      for (const colorScheme of ['light', 'dark'] as const) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, reducedMotion: 'reduce' })
        currentPage = await context.newPage()
        try {
          let submissions = 0
          currentPage.on('request', request => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === '/link/api/tasks') submissions++
          })
          await enrollBrowser(currentPage, host)
          const input = currentPage.getByRole('textbox', { name: '新会话消息', exact: true })
          await input.fill('/')
          const list = currentPage.getByRole('listbox', { name: '命令与提示模板', exact: true })
          const group = list.getByRole('group', { name: '菜单 Agent（上次会话）', exact: true })
          await group
            .getByRole('option')
            .filter({ has: currentPage.getByText('/public-plan', { exact: true }) })
            .waitFor()
          await noHorizontalOverflow(currentPage)
          await currentPage.screenshot({ path: `${output}/previous-${width}-${colorScheme}.png`, animations: 'disabled' })
          await input.press('ArrowDown')
          await input.press('Enter')
          await expect.poll(() => input.inputValue()).toBe('/public-plan ')
          await currentPage.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
          expect(submissions).toBe(0)
          expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(1)
          expect(await starts()).toBe(before)
          if (width === 1440 && colorScheme === 'light') {
            const page = currentPage
            const selectProject = async (name: string, id: string, wait = true) => {
              const text = await input.inputValue()
              const reply = wait
                ? page.waitForResponse(
                    response =>
                      response.request().method() === 'POST'
                      && new URL(response.url()).pathname === '/link/api/agents/cached-agent/commands'
                      && response.request().postDataJSON()?.workspaceId === id,
                  )
                : undefined
              void reply?.catch(() => {})
              await page.getByRole('button', { name: /^项目：/u }).click()
              await page
                .getByRole('menuitemradio')
                .filter({ has: page.getByText(name, { exact: true }) })
                .click()
              expect(await input.inputValue()).toBe(text)
              if (reply) expect((await reply).ok()).toBe(true)
            }
            await selectProject('另一个项目', other.id)
            await input.fill('/')
            await list.getByText('开始会话后列出', { exact: true }).waitFor()
            expect(await list.getByText('/public-plan', { exact: true }).count()).toBe(0)
            let enter!: () => void
            let release!: () => void
            let fail!: () => void
            const entered = new Promise<void>((done, reject) => {
              enter = done
              fail = () => reject(new Error('Held catalogue failed'))
            })
            void entered.catch(() => {})
            const held = new Promise<void>(done => {
              release = done
            })
            const pending = new Set<Promise<void>>()
            let claimed = false
            const handler = (route: Route) => {
              if (claimed || route.request().postDataJSON()?.workspaceId !== project.id) return route.continue()
              claimed = true
              const job = (async () => {
                const response = await route.fetch()
                expect(response.ok()).toBe(true)
                expect((await response.json()).catalogue?.commands[0]?.name).toBe('public-plan')
                enter()
                await held
                // A changed draft aborts its request; a browser may refuse fulfillment of that already-aborted route.
                await route.fulfill({ response }).catch(() => {})
              })()
                .catch(() => {
                  fail()
                })
                .finally(() => pending.delete(job))
              pending.add(job)
              return job
            }
            const pattern = '**/link/api/agents/cached-agent/commands'
            await page.route(pattern, handler)
            try {
              await selectProject('命令项目', project.id, false)
              await entered
              await selectProject('另一个项目', other.id)
              release()
              await Promise.allSettled(pending)
              await input.fill('/')
              await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
              await list.getByText('开始会话后列出', { exact: true }).waitFor()
              expect(await list.getByText('/public-plan', { exact: true }).count()).toBe(0)
              await page.screenshot({ path: `${output}/project-switch-late-1440-light.png`, animations: 'disabled' })
            } finally {
              release()
              await Promise.allSettled(pending)
              await page.unroute(pattern, handler)
            }
            await selectProject('命令项目', project.id)
            await input.fill('/')
            await group.getByText('/public-plan', { exact: true }).waitFor()
            await page.getByRole('button', { name: /^Harness：/u }).click()
            const standard = (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(harness => harness.id === 'standard')!
            await page
              .getByRole('menu', { name: /^Harness/u })
              .getByRole('menuitemradio', { name: standard.capabilities.display.label, exact: true })
              .click()
            await input.fill('/')
            await list.getByText(`${standard.capabilities.display.label} 还没报告命令`, { exact: true }).waitFor()
            expect(await list.getByText('/public-plan', { exact: true }).count()).toBe(0)
            expect(await starts()).toBe(before)
            expect(submissions).toBe(0)
            await page.getByRole('button', { name: /^Harness：/u }).click()
            await page
              .getByRole('menu', { name: /^Harness/u })
              .getByRole('menuitemradio', { name: '菜单 Agent', exact: true })
              .click()
            // 新建会话 is this same home input, focused, with what it holds: typed afresh, the list opens again.
            await page.getByRole('button', { name: '新建会话', exact: true }).click()
            await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
            await input.fill('')
            await input.fill('/')
            await group.getByText('/public-plan', { exact: true }).waitFor()
            await page.screenshot({ path: `${output}/new-page-1440-light.png`, animations: 'disabled' })
            await input.press('ArrowDown')
            await input.press('Tab')
            expect(await input.inputValue()).toBe('/public-plan ')
            expect(submissions).toBe(0)
            expect(await starts()).toBe(before)
          }
          if (width === 390 && colorScheme === 'dark') {
            // A phone's new session is the home's input.
            const sheetInput = currentPage.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
            await sheetInput.fill('/')
            await group.getByText('/public-plan', { exact: true }).waitFor()
            await currentPage.screenshot({ path: `${output}/phone-home-390-dark.png`, animations: 'disabled' })
            await group
              .getByRole('option')
              .filter({ has: currentPage.getByText('/public-plan', { exact: true }) })
              .click()
            expect(await sheetInput.inputValue()).toBe('/public-plan ')
            expect(submissions).toBe(0)
            expect(await starts()).toBe(before)
            await sheetInput.fill('')
            await currentPage.setViewportSize({ width: 390, height: 360 })
            await input.fill('/')
            const cdp = await context.newCDPSession(currentPage)
            try {
              await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 })
              await currentPage.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
              const box = await currentPage.evaluate(() => {
                const visual = window.visualViewport!
                const panel = document.querySelector('.ui-suggest:popover-open')!.getBoundingClientRect()
                return {
                  x: panel.left,
                  y: panel.top,
                  right: panel.right,
                  bottom: panel.bottom,
                  left: visual.offsetLeft,
                  top: visual.offsetTop,
                  width: visual.width,
                  height: visual.height,
                  scale: visual.scale,
                }
              })
              expect(box.scale).toBe(1.5)
              expect(box.x).toBeGreaterThanOrEqual(box.left + 7)
              expect(box.y).toBeGreaterThanOrEqual(box.top + 7)
              expect(box.right).toBeLessThanOrEqual(box.left + box.width - 7)
              expect(box.bottom).toBeLessThanOrEqual(box.top + box.height - 7)
              await currentPage.screenshot({ path: `${output}/zoom-short-390-dark.png`, animations: 'disabled' })
              await group
                .getByRole('option')
                .filter({ has: currentPage.getByText('/public-plan', { exact: true }) })
                .click()
              expect(await input.inputValue()).toBe('/public-plan ')
              expect(submissions).toBe(0)
            } finally {
              await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
              await cdp.detach()
            }
          }
        } catch (error) {
          const calls = (await readFile(log, 'utf8').catch(() => ''))
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as { pid: number; event: string; method?: string })
            .map(({ pid, event, method }) => ({ pid, event, ...(method ? { method } : {}) }))
          await writeFile(`${output}/diagnostic-${width}-${colorScheme}.json`, JSON.stringify({ width, colorScheme, calls }, null, 2))
          await currentPage.screenshot({ path: `${output}/failure-${width}-${colorScheme}.png`, animations: 'disabled' })
          throw error
        } finally {
          await context.close()
          currentPage = undefined
        }
      }
    const liveContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    const liveEvidence: Array<{ event: string; elapsedMs: number; reads: number; starts: number }> = []
    try {
      currentPage = await liveContext.newPage()
      await currentPage.clock.install()
      await enrollBrowser(currentPage, host)
      let reads = 0
      currentPage.on('request', request => {
        if (new URL(request.url()).pathname === '/link/api/agents/cached-agent/commands') reads++
      })
      const input = currentPage.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('/')
      const list = currentPage.getByRole('listbox', { name: '命令与提示模板', exact: true })
      await list.getByText('/public-plan', { exact: true }).waitFor()
      let changedAt = performance.now()
      await writeFile(commandsFile, JSON.stringify([{ name: 'updated-plan', description: '更新后的计划' }]))
      await owner.json(`tasks/${id}/prompt`, { method: 'POST', body: { prompt: 'plan', requestId: randomUUID() } })
      await list.getByText('/updated-plan', { exact: true }).waitFor({ timeout: 5_000 })
      liveEvidence.push({ event: 'report', elapsedMs: performance.now() - changedAt, reads, starts: await starts() })
      expect(await list.getByText('/public-plan', { exact: true }).count()).toBe(0)
      await currentPage.screenshot({ path: `${output}/source-updated-1440-light.png`, animations: 'disabled' })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')
      const afterResume = await starts()
      expect(afterResume).toBe(before + 1) // This explicitly continued source resumes its CLI; reading the draft did not.
      const afterReportReads = reads
      await owner.json(`tasks/${id}/prompt`, { method: 'POST', body: { prompt: 'hello', requestId: randomUUID() } })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')
      await currentPage.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      expect(reads).toBe(afterReportReads)
      await input.fill('/updated')
      const active = await input.getAttribute('aria-activedescendant')
      expect(active).toBeTruthy()
      const nextRead = currentPage.waitForResponse(
        response => new URL(response.url()).pathname === '/link/api/agents/cached-agent/commands',
      )
      void nextRead.catch(() => {})
      await currentPage.clock.fastForward(30_000)
      expect((await nextRead).ok()).toBe(true)
      expect(await input.inputValue()).toBe('/updated')
      expect(await input.getAttribute('aria-activedescendant')).toBe(active)
      expect(await starts()).toBe(afterResume)
      // Headless Chrome has no OS app-background action: exercise the browser visibility event with a temporary
      // document-state fixture, keeping the real mounted UI, timers, requests and Host authorization intact.
      const visibleReads = reads
      try {
        await currentPage.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true })
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
          document.dispatchEvent(new Event('visibilitychange'))
        })
        await currentPage.clock.fastForward(30_000)
        expect(reads).toBe(visibleReads)
      } finally {
        await currentPage.evaluate(() => {
          Reflect.deleteProperty(document, 'hidden')
          Reflect.deleteProperty(document, 'visibilityState')
          document.dispatchEvent(new Event('visibilitychange'))
        })
      }
      await expect.poll(() => reads).toBeGreaterThan(visibleReads)
      await list.getByText('/updated-plan', { exact: true }).waitFor({ timeout: 5_000 })
      expect(await input.inputValue()).toBe('/updated')
      expect(await input.getAttribute('aria-activedescendant')).toBe(active)
      expect(await starts()).toBe(afterResume)
      await input.fill('/')
      // The trusted Host supplies private context; this exercises its actual visibility transition without editing stored files.
      changedAt = performance.now()
      await host.host.bridge.prompt(id, 'Continue', randomUUID(), {
        agentContext: { instructions: 'PRIVATE SOURCE CONTEXT', revision: 'a'.repeat(64) },
      })
      // Private activity deliberately sends no hint to a work-scoped device. An unrelated normal settings refresh
      // delivers a new snapshot without changing this draft's selection; membership must then invalidate immediately.
      await owner.json('preferences', {
        method: 'PUT',
        body: { defaults: { harnessId: 'cached-agent', workspaceId: project.id, mode: 'agent', pinned: true } },
      })
      await list.getByText('开始会话后列出', { exact: true }).waitFor({ timeout: 5_000 })
      liveEvidence.push({ event: 'private-after-snapshot', elapsedMs: performance.now() - changedAt, reads, starts: await starts() })
      expect(await list.getByText('/updated-plan', { exact: true }).count()).toBe(0)
      expect(await input.inputValue()).toBe('/')
      expect(await starts()).toBe(afterResume)
      await currentPage.screenshot({ path: `${output}/source-private-1440-light.png`, animations: 'disabled' })
      const fresh = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'cached-agent', workspaceId: project.id, prompt: 'plan', requestId: randomUUID() },
      })
      await list.getByText('/updated-plan', { exact: true }).waitFor({ timeout: 5_000 })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${fresh.sessionId}`)).summary.status).toBe('idle')
      const afterCreate = await starts()
      expect(afterCreate).toBe(afterResume + 1)
      await host.host.bridge.prompt(fresh.sessionId, 'Continue', randomUUID(), {
        agentContext: { instructions: 'PRIVATE SOURCE CONTEXT', revision: 'a'.repeat(64) },
      })
      // With no public invalidation, the existing hint can be stale for at most the visible-page refresh interval.
      // This advances browser timers only: HTTP still reaches the real temporary Host and rechecks source privacy.
      changedAt = performance.now()
      await currentPage.clock.fastForward(30_000)
      await list.getByText('开始会话后列出', { exact: true }).waitFor({ timeout: 5_000 })
      liveEvidence.push({
        event: 'private-after-30s-browser-timers',
        elapsedMs: performance.now() - changedAt,
        reads,
        starts: await starts(),
      })
      expect(await starts()).toBe(afterCreate)
      const removable = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'cached-agent', workspaceId: project.id, prompt: 'plan', requestId: randomUUID() },
      })
      await list.getByText('/updated-plan', { exact: true }).waitFor({ timeout: 5_000 })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${removable.sessionId}`)).summary.status).toBe('idle')
      expect(await starts()).toBe(afterCreate + 1)
      changedAt = performance.now()
      await owner.json(`tasks/${removable.sessionId}`, { method: 'DELETE' })
      await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(2)
      await list.getByText('开始会话后列出', { exact: true }).waitFor({ timeout: 5_000 })
      liveEvidence.push({ event: 'delete', elapsedMs: performance.now() - changedAt, reads, starts: await starts() })
      expect(await list.getByText('/updated-plan', { exact: true }).count()).toBe(0)
      expect(await input.inputValue()).toBe('/')
      expect(await starts()).toBe(afterCreate + 1)
      await currentPage.screenshot({ path: `${output}/source-deleted-1440-light.png`, animations: 'disabled' })
    } finally {
      await writeFile(`${output}/live-invalidation.json`, JSON.stringify(liveEvidence, null, 2))
      await liveContext.close()
      currentPage = undefined
    }
  } catch (error) {
    if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: `${output}/failure.png`, animations: 'disabled' })
    throw error
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
