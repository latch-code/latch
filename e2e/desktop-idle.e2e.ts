import { _electron, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { startTestHost } from './helpers/host.ts'

const enabled = process.platform === 'darwin' && process.env.LATCH_DESKTOP_IDLE_BENCH === '1'
const sampleMs = Number(process.env.LATCH_DESKTOP_IDLE_SAMPLE_MS ?? 30_000)
const phaseMs = (process.env.LATCH_DESKTOP_IDLE_PHASE_MS ?? '1200000,900000,600000').split(',').map(Number)
const totalMs = phaseMs.reduce((total, ms) => total + ms, 0)
const outputDir = 'test-results/desktop-idle'

it.skipIf(!enabled)(
  'samples an idle full-screen Electron workbench without user interaction',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-idle-'))
    const host = await startTestHost()
    let app: ElectronApplication | undefined
    try {
      if (phaseMs.length !== 3 || ![sampleMs, ...phaseMs].every(ms => Number.isSafeInteger(ms) && ms > 0))
        throw new Error('Choose one positive sample interval and three positive phase durations in milliseconds.')
      const label = process.env.LATCH_DESKTOP_IDLE_LABEL ?? 'local'
      if (!/^[a-z0-9-]{1,48}$/u.test(label)) throw new Error('Invalid benchmark label.')
      await mkdir(outputDir, { recursive: true })
      const output = join(outputDir, `${label}.jsonl`)
      await writeFile(output, '')
      const owner = await host.enroll({ listener: 'unix' })
      const marker = '全屏空闲后仍可见的长会话'
      const prompt = (turn: number) => `${marker}（${turn}）\n\n${'这是离线夹具里的一行内容。\n'.repeat(100)}`
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: prompt(1), mode: 'chat' },
      })
      const settled = async () =>
        expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 30_000 }).toBe('idle')
      await settled()
      for (let turn = 2; turn <= 10; turn++) {
        await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt: prompt(turn) } })
        await settled()
      }
      await writeHostState(host.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.host.hostId,
        instanceId: host.host.instanceId,
        socketPath: host.host.socketPath,
        loopbackOrigin: host.host.loopbackOrigin,
        tlsOrigin: null,
        startedAt: new Date().toISOString(),
        dataDir: host.dataDir,
      })
      app = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(host.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
          '-AppleLanguages',
          '(zh-CN)',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      const page = await app.firstWindow()
      page.setDefaultTimeout(15_000)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      const shell = page.locator('.app-shell[data-connection="connected"]')
      await shell.waitFor()
      await page.locator(`#session-navigation [data-task-id="${sessionId}"]`).click()
      const transcript = page.locator('.transcript-shell').getByText(`${marker}（10）`, { exact: false }).first()
      await transcript.waitFor()
      const window = await app.browserWindow(page)
      await window.evaluate(workbench => workbench.setFullScreen(true))
      await expect.poll(() => window.evaluate(workbench => workbench.isFullScreen())).toBe(true)
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('crash', () => errors.push('renderer-crashed'))
      const activity: Record<string, number> = {}
      page.on('request', request => {
        const route = new URL(request.url()).pathname
        activity[route] = (activity[route] ?? 0) + 1
      })
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.debugger.attach('1.3')
      })
      const started = performance.now()
      const initial = {
        pid: await window.evaluate(workbench => workbench.webContents.getOSProcessId()),
        timeOrigin: await page.evaluate(() => performance.timeOrigin),
      }
      const record = async (phase: string, collect = false) => {
        const values = await app!.evaluate(async ({ app, BrowserWindow }, collect) => {
          const workbench = BrowserWindow.getAllWindows()[0]!
          const contents = workbench.webContents
          const pid = contents.getOSProcessId()
          const before = await contents.debugger.sendCommand('Runtime.getHeapUsage')
          const dom = await contents.debugger.sendCommand('Memory.getDOMCounters')
          const metrics = app
            .getAppMetrics()
            .filter(metric => ['Browser', 'GPU'].includes(metric.type) || metric.pid === pid)
            .map(metric => ({
              type: metric.type,
              pid: metric.pid,
              rssKB: metric.memory.workingSetSize,
              cpuPercent: metric.cpu.percentCPUUsage,
            }))
          const state = { visible: workbench.isVisible(), focused: workbench.isFocused(), fullScreen: workbench.isFullScreen() }
          if (!collect) return { pid, before, dom, metrics, state }
          await contents.debugger.sendCommand('HeapProfiler.collectGarbage')
          const after = await contents.debugger.sendCommand('Runtime.getHeapUsage')
          return { pid, before, after, dom, metrics, state }
        }, collect)
        const web = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, visibility: document.visibilityState }))
        expect({ pid: values.pid, timeOrigin: web.timeOrigin }).toEqual(initial)
        expect(errors).toEqual([])
        await appendFile(
          output,
          JSON.stringify({
            seconds: Math.round((performance.now() - started) / 1000),
            phase,
            pid: values.pid,
            ...web,
            usedBefore: values.before.usedSize,
            ...(values.after ? { usedAfter: values.after.usedSize } : {}),
            native: values.state,
            dom: values.dom,
            metrics: values.metrics,
            activity,
          }) + '\n',
        )
      }
      await record('initial')
      for (const [index, phase] of ['visible', 'hidden', 'shown'].entries()) {
        if (phase === 'hidden') {
          await window.evaluate(workbench => workbench.hide())
          await expect.poll(() => window.evaluate(workbench => workbench.isVisible())).toBe(false)
        } else if (phase === 'shown') {
          await window.evaluate(workbench => workbench.show())
          await expect.poll(() => window.evaluate(workbench => workbench.isVisible())).toBe(true)
        }
        const end = performance.now() + phaseMs[index]!
        while (performance.now() < end) {
          await wait(Math.max(1, Math.min(sampleMs, end - performance.now())))
          await record(phase)
        }
      }
      await expect.poll(() => shell.isVisible()).toBe(true)
      await expect.poll(() => transcript.isVisible()).toBe(true)
      const panel = page.getByRole('button', { name: '侧边面板', exact: true })
      const openBefore = await panel.getAttribute('aria-pressed')
      await panel.click()
      await expect.poll(() => panel.getAttribute('aria-pressed')).not.toBe(openBefore)
      await record('responded', true)
    } finally {
      await app?.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  totalMs + 240_000,
)
