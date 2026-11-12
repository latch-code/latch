import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/transcript-rows'
const RUNNING = 'pnpm exec vitest run tests/settings.test.ts'
const FAILING = 'pnpm exec vitest run tests/settings.test.ts --reporter=dot'
const LONG = 'apps/web/src/components/conversation/rows/with/a/folder/path/long/enough/to/be/cut/on/a/phone/ToolRowLayout.tsx'

/**
 * A local ACP agent for this file only: one turn that reads, edits, runs a command the harness reports failed with its
 * output, and then runs a command whose output arrives one line at a time as the test writes how many lines it may print
 * into `lines`; `done` there ends it. It speaks only the few ACP methods a turn needs and sends nothing anywhere else.
 */
const agentSource = (control: string) => `
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const control = ${JSON.stringify(control)}
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
const text = value => ({ type: 'content', content: { type: 'text', text: value } })
const wait = ms => new Promise(done => setTimeout(done, ms))
const allowed = () => { try { return readFileSync(control, 'utf8').trim() } catch { return '0' } }
const cancelled = new Set()
const cwds = new Map()
async function turn(sessionId) {
  const cwd = cwds.get(sessionId)
  const say = value => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
  const tool = (value, kind = 'tool_call') => update(sessionId, { sessionUpdate: kind, ...value })
  say('先看保存逻辑和现有的测试。')
  tool({ toolCallId: 'read_1', title: 'Read store.ts', kind: 'read', status: 'completed', locations: [{ path: cwd + '/src/settings/store.ts' }] })
  tool({ toolCallId: 'read_2', title: 'Read a long path', kind: 'read', status: 'completed', locations: [{ path: cwd + '/${LONG}' }] })
  await wait(20)
  say('\\n\\n保存时把省略的密钥字段当成了空字符串。')
  tool({ toolCallId: 'edit_1', title: 'Edit store.ts', kind: 'edit', status: 'in_progress', locations: [{ path: cwd + '/src/settings/store.ts' }] })
  tool({ toolCallId: 'edit_1', status: 'completed', content: [{ type: 'diff', path: cwd + '/src/settings/store.ts', oldText: 'a\\nb\\nc\\n', newText: 'a\\nB\\nC\\nD\\n' }] }, 'tool_call_update')
  tool({ toolCallId: 'run_1', title: ${JSON.stringify(FAILING)}, kind: 'execute', status: 'in_progress', rawInput: { command: ${JSON.stringify(FAILING)} } })
  tool({ toolCallId: 'run_1', status: 'failed', content: [text(' ✓ keeps the key when the field is omitted\\n × clears the key when the field is an empty string\\n   AssertionError: expected kept to equal empty\\n\\n Test Files  1 failed (1)\\n      Tests  1 failed | 11 passed (12)')] }, 'tool_call_update')
  await wait(20)
  say('\\n\\n显式传空字符串时应该清空。补上这个分支，再跑一次。')
  tool({ toolCallId: 'run_2', title: ${JSON.stringify(RUNNING)}, kind: 'execute', status: 'in_progress', rawInput: { command: ${JSON.stringify(RUNNING)} } })
  const lines = []
  for (;;) {
    if (cancelled.has(sessionId)) return { stopReason: 'cancelled' }
    const may = allowed()
    if (may === 'done') break
    while (lines.length < Number(may)) {
      lines.push(' ✓ case ' + (lines.length + 1) + ' of the settings tests')
      tool({ toolCallId: 'run_2', status: 'in_progress', content: [text(lines.join('\\n'))] }, 'tool_call_update')
    }
    await wait(30)
  }
  tool({ toolCallId: 'run_2', status: 'completed', content: [text(lines.join('\\n') + '\\n\\n Tests  12 passed (12)')] }, 'tool_call_update')
  say('\\n\\n测试都通过了。')
  return { stopReason: 'end_turn' }
}
const rl = createInterface({ input: process.stdin })
rl.on('line', async line => {
  const message = JSON.parse(line)
  if (message.method === 'session/cancel') return void cancelled.add(message.params.sessionId)
  if (message.id === undefined || message.method === undefined) return
  const reply = result => send({ id: message.id, result })
  if (message.method === 'initialize')
    return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [], agentInfo: { name: 'Rows agent', version: '1.0.0' } })
  if (message.method === 'session/new') {
    const sessionId = 'rows-' + Math.random().toString(36).slice(2)
    cwds.set(sessionId, message.params.cwd)
    return reply({ sessionId })
  }
  if (message.method === 'session/prompt') return reply(await turn(message.params.sessionId))
  send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
})
rl.on('close', () => process.exit(0))
`

/**
 * Tool rows on the turn's rail and commands as blocks, at phone, tablet and desktop width in light and dark: what the
 * protocol carries (the command once, its duration, the output the tool reported, the call's own failed state) and
 * nothing it does not (no exit code); a block's output arriving does not move what the reader is looking at; subagent
 * rows sit on the same rail.
 */
describe('tool rows and command blocks', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let scratch = ''
  let control = ''
  let commands = ''
  let subagents = ''
  let phone: Page
  let wide: Page

  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  const allow = (lines: number | 'done') => writeFile(control, String(lines))
  const runningOutput = async (id: string) =>
    (await detail(id)).messages.find(message => message.id.endsWith('run_2'))?.tool?.output?.split('\n').length ?? 0
  async function poll(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let tries = 0; !(await check()); tries++) {
      if (tries > 400) throw new Error(`timed out waiting for ${what}`)
      await new Promise(done => setTimeout(done, 50))
    }
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'latch-rows-'))
    control = join(scratch, 'lines')
    await allow(2)
    const agent = join(scratch, 'rows-agent.mjs')
    await writeFile(agent, agentSource(control))
    host = await startTestHost()
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'rows-agent', name: 'Rows Agent', command: process.execPath, args: [agent] },
    })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'fake-agent', name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT] },
    })
    // Browsers connect before any external Harness runs: while one runs or waits, the Host confirms no new device.
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
    phone = await enrolled(true)
    wide = await enrolled(false)
    commands = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'rows-agent', prompt: '修复设置页密钥丢失', requestId: randomUUID() },
      })
    ).sessionId
    await owner.json(`tasks/${commands}`, { method: 'PATCH', body: { title: '命令块的会话' } })
    await poll(async () => (await runningOutput(commands)) === 2, 'the first two lines')
    subagents = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'fake-agent', prompt: 'delegate stop', requestId: randomUUID() },
      })
    ).sessionId
    await owner.json(`tasks/${subagents}`, { method: 'PATCH', body: { title: '子 Agent 的会话' } })
    await poll(async () => (await detail(subagents)).messages.some(message => message.subagent?.stoppable), 'a stoppable subagent')
  })
  afterAll(async () => {
    await allow('done').catch(() => {})
    await phone?.context().close()
    await wide?.context().close()
    await browser?.close()
    await host?.close()
    if (scratch) await rm(scratch, { recursive: true, force: true })
  })

  /** One connected page per kind of device: a touch phone, and a pointer device that is resized to tablet and desktop. */
  async function enrolled(touch: boolean): Promise<Page> {
    const context = await browser.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: touch,
      hasTouch: touch,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: touch ? '工具行 手机' : '工具行 电脑' })
    await connected(page)
    return page
  }
  async function open(width: number, height: number, theme: 'light' | 'dark', title: string): Promise<Page> {
    const page = width < 768 ? phone : wide
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: theme })
    await page.reload()
    await connected(page)
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.getByRole('searchbox').fill(title)
    await palette.getByRole('option', { name: title, exact: true }).click()
    await page.locator('.transcript .turn').first().waitFor()
    return page
  }
  const block = (page: Page, command: string) => page.locator('.tool-card.is-command').filter({ hasText: command })

  it('draws the rail, mono paths and command blocks from what the protocol carries, at every width', async () => {
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1440, 900],
    ] as const)
      for (const theme of ['light', 'dark'] as const) {
        const page = await open(width, height, theme, '命令块的会话')
        try {
          const running = block(page, RUNNING).filter({ hasNotText: '--reporter' })
          const failed = block(page, FAILING)
          await running.locator('.command-tail').getByText('case 2 of', { exact: false }).waitFor()
          // The command once, with the prompt glyph; the caret only on the one still running; no exit code anywhere.
          expect(await running.locator('.process-object').innerText()).toBe(RUNNING)
          expect(await running.locator('.command-prompt').innerText()).toBe('$')
          expect(await running.locator('.command-caret').count()).toBe(1)
          expect(await failed.locator('.command-caret').count()).toBe(0)
          expect(await page.locator('.transcript').innerText()).not.toMatch(/退出码|exit code/iu)
          // A failure is the call's own failed state: a red rail on the left, and its reason under it.
          expect(await failed.getAttribute('class')).toContain('tool-failed')
          const rail = await failed.evaluate(element => {
            const style = getComputedStyle(element, '::before')
            return { width: style.width, colour: style.backgroundColor }
          })
          expect(rail.width).toBe('2px')
          expect(rail.colour).not.toBe('rgba(0, 0, 0, 0)')
          expect(await failed.locator('.command-tail').innerText()).toContain('Tests  1 failed')
          // Paths: mono, the folder quieter than the name, written from the project; a long folder gives way, the name never.
          const store = page.locator('.tool-card[data-kind="read"]').filter({ hasText: 'store.ts' }).first()
          expect(await store.locator('.process-folder').innerText()).toBe('src/settings/')
          expect(await store.locator('.process-name').innerText()).toBe('store.ts')
          const long = page.locator('.tool-card').filter({ hasText: 'ToolRowLayout.tsx' })
          const name = long.locator('.process-name')
          expect(await name.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
          expect(await long.locator('.tool-card-header').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
          const edit = page.locator('.tool-card[data-kind="edit"]').first()
          expect(await edit.locator('.process-stat').innerText()).toBe('+3 −2')
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${OUTPUT}/a-running--${width}--${theme}.png`, animations: 'disabled' })
        } catch (error) {
          await page.screenshot({ path: `${OUTPUT}/failed-${width}-${theme}.png` })
          throw error
        }
      }
  })

  it('keeps what the reader looks at in place while a command prints, and opens to the whole output on request', async () => {
    const page = await open(1440, 640, 'light', '命令块的会话')
    try {
      const running = block(page, RUNNING).filter({ hasNotText: '--reporter' })
      await running.locator('.command-tail').getByText('case 2 of', { exact: false }).waitFor()
      // The reader scrolls up to the failed command; new lines below must not move it.
      const failed = block(page, FAILING)
      await page.locator('.transcript').hover()
      await page.mouse.wheel(0, -260)
      await expect.poll(() => page.locator('.jump-latest').count()).toBeGreaterThan(0)
      const before = await failed.evaluate(element => element.getBoundingClientRect().top)
      for (const lines of [3, 4, 6, 9]) {
        await allow(lines)
        await running.locator('.command-tail').getByText(`case ${lines} of`, { exact: false }).waitFor()
        expect(await failed.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(before, 0)
      }
      // Folded, the block keeps only its last five lines.
      const tail = await running.locator('.command-tail').innerText()
      expect(tail).toContain('case 9 of')
      expect(tail).toContain('case 5 of')
      expect(tail).not.toContain('case 4 of')
      await running.locator('.tool-card-header').click()
      await running.locator('.tool-output').getByText('case 1 of', { exact: false }).waitFor()
      expect(await running.locator('.command-tail').count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/opened-command--1440--light.png`, animations: 'disabled' })
    } catch (error) {
      await page.screenshot({ path: `${OUTPUT}/failed-reading.png` })
      throw error
    }
    await allow('done')
    await poll(async () => (await detail(commands)).summary.status === 'idle', 'the turn to settle')
    for (const theme of ['light', 'dark'] as const) {
      const settled = await open(1440, 900, theme, '命令块的会话')
      // A settled turn folds its work into 「已工作 …」; the blocks are under it.
      await settled.locator('.work-fold[aria-expanded="false"]').click()
      const done = block(settled, RUNNING).filter({ hasNotText: '--reporter' })
      await expect.poll(() => done.locator('.command-tail').innerText()).toContain('12 passed (12)')
      expect(await done.locator('.command-caret').count()).toBe(0)
      await settled.screenshot({ path: `${OUTPUT}/settled--1440--${theme}.png`, animations: 'disabled' })
    }
  })

  it('hangs subagent rows on the same rail, with 停止 in its own column', async () => {
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1440, 900],
    ] as const)
      for (const theme of ['light', 'dark'] as const) {
        const page = await open(width, height, theme, '子 Agent 的会话')
        try {
          const row = page.locator('.subagent-row').first()
          await row.getByText('Test runner', { exact: true }).waitFor()
          await row.getByRole('button', { name: '停止子 Agent Test runner', exact: true }).waitFor()
          await row.locator('.subagent-toggle').click()
          await row.locator('.subagent-steps .tool-card').first().waitFor()
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${OUTPUT}/b0-subagent--${width}--${theme}.png`, animations: 'disabled' })
        } catch (error) {
          await page.screenshot({ path: `${OUTPUT}/failed-${width}-${theme}.png` })
          throw error
        }
      }
  })
})
