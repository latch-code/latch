import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, reachable } from './helpers/layout.ts'

const OUTPUT = 'test-results/stream-render'
const SIZES = [
  [390, 844],
  [768, 1024],
  [1440, 900],
] as const
const THEMES = ['light', 'dark'] as const

/**
 * A local ACP agent for this file only. The first word of the prompt picks the turn; a turn that waits reads the number
 * the test wrote into its control file and goes on when it grows. It speaks the few ACP methods a turn needs and sends
 * nothing anywhere else.
 */
const agentSource = (control: string) => `
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const control = ${JSON.stringify(control)}
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
const text = value => ({ type: 'content', content: { type: 'text', text: value } })
const wait = ms => new Promise(done => setTimeout(done, ms))
const step = () => { try { return Number(readFileSync(control, 'utf8').trim()) || 0 } catch { return 0 } }
const reached = async value => { while (step() < value) await wait(25) }
const cwds = new Map()
const pending = new Map()
let nextId = 1
const request = (method, params) => new Promise(done => { const id = 'agent-' + nextId++; pending.set(id, done); send({ id, method, params }) })
const zsh = inner => "/bin/zsh -lc '" + inner.replaceAll("'", "'\\"'\\"'") + "'"
const turns = {
  async commands({ sessionId, cwd, say, tool }) {
    say('先看一下项目里有什么。')
    const list = zsh("pwd; rg --files -g 'AGENTS.md' -g '!node_modules' " + cwd)
    tool({ toolCallId: 'run_1', title: list, kind: 'execute', status: 'in_progress', rawInput: { command: list, cwd } })
    tool({ toolCallId: 'run_1', status: 'completed', content: [text(cwd + '\\n' + cwd + '/AGENTS.md')] }, 'tool_call_update')
    const cat = zsh('cat ' + cwd + '/notes/SKILL.md')
    tool({ toolCallId: 'run_2', title: cat, kind: 'execute', status: 'in_progress', rawInput: { command: cat, cwd } })
    tool({ toolCallId: 'run_2', status: 'completed', content: [text(('这是一段很长的说明，' + 'frontend-design '.repeat(8)).repeat(14) + '\\n第二行\\n第三行')] }, 'tool_call_update')
    const failing = 'bash -lc "pnpm exec vitest run tests/settings.test.ts"'
    tool({ toolCallId: 'run_3', title: failing, kind: 'execute', status: 'in_progress', rawInput: { command: failing, cwd } })
    tool({ toolCallId: 'run_3', status: 'failed', content: [text(' × clears the key when the field is an empty string ' + 'AssertionError: expected kept to equal empty '.repeat(40) + '\\n\\n Test Files  1 failed (1)\\n      Tests  1 failed | 11 passed (12)')] }, 'tool_call_update')
    say('\\n\\n再看桌面和工作目录。')
    const odd = 'bash -lc "echo $HOME"'
    tool({ toolCallId: 'run_4', title: odd, kind: 'execute', status: 'in_progress', rawInput: { command: odd, cwd } })
    tool({ toolCallId: 'run_4', status: 'completed', content: [text(cwd)] }, 'tool_call_update')
    const live = zsh('ls -ld ' + cwd + '; sleep 3; echo ok')
    tool({ toolCallId: 'run_5', title: live, kind: 'execute', status: 'in_progress', rawInput: { command: live, cwd } })
    const lines = []
    for (let index = 1; index <= 8; index++) lines.push('drwx------@ 2 dev staff 64 Nov 13 16:04 entry-' + index + ' ' + 'x'.repeat(index === 8 ? 900 : 4))
    tool({ toolCallId: 'run_5', status: 'in_progress', content: [text(lines.join('\\n'))] }, 'tool_call_update')
    await reached(1)
    tool({ toolCallId: 'run_5', status: 'completed', content: [text(lines.join('\\n') + '\\nok')] }, 'tool_call_update')
    say('\\n\\n都看过了。')
  },
  async approval({ sessionId, cwd, say, tool }) {
    say('需要你允许一条命令。')
    const inner = 'set -e\\n' + Array.from({ length: 30 }, (_, index) => 'echo step-' + index + ' ' + cwd).join('; ')
    const command = zsh(inner)
    const toolCall = { toolCallId: 'ask_1', title: command, kind: 'execute', status: 'pending', rawInput: { command, cwd } }
    tool(toolCall)
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const allowed = answer.result?.outcome?.optionId === 'allow'
    tool({ toolCallId: 'ask_1', status: allowed ? 'completed' : 'failed', content: [text(allowed ? 'done' : 'not run')] }, 'tool_call_update')
    say('\\n\\n' + (allowed ? '已运行。' : '没有运行。'))
  },
}
const rl = createInterface({ input: process.stdin })
rl.on('line', async line => {
  const message = JSON.parse(line)
  if (message.method === undefined && pending.has(message.id)) return void pending.get(message.id)(message)
  if (message.id === undefined || message.method === undefined) return
  const reply = result => send({ id: message.id, result })
  if (message.method === 'initialize')
    return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [], agentInfo: { name: 'Render agent', version: '1.0.0' } })
  if (message.method === 'session/new') {
    const sessionId = 'render-' + Math.random().toString(36).slice(2)
    cwds.set(sessionId, message.params.cwd)
    return reply({ sessionId })
  }
  if (message.method === 'session/prompt') {
    const sessionId = message.params.sessionId
    const input = message.params.prompt.map(part => part.text ?? '').join('')
    const say = value => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
    const think = value => update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value } })
    const tool = (value, kind = 'tool_call') => update(sessionId, { sessionUpdate: kind, ...value })
    await turns[input.trim().split(/\\s+/u)[0]]?.({ sessionId, cwd: cwds.get(sessionId), say, think, tool })
    return reply({ stopReason: 'end_turn' })
  }
  send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
})
rl.on('close', () => process.exit(0))
`

/**
 * How one turn's work is drawn (docs/STREAMING.md「工作过程的行」), at phone, tablet and desktop width in light and dark,
 * with a scripted local agent: commands without their shell wrapper, settled commands as rows, the folded tail, and the
 * whole command on an approval card.
 */
describe('how a turn of work is drawn', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let scratch = ''
  let control = ''
  let phone: Page
  let wide: Page

  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  const advance = (value: number) => writeFile(control, String(value))
  async function poll(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let tries = 0; !(await check()); tries++) {
      if (tries > 400) throw new Error(`timed out waiting for ${what}`)
      await new Promise(done => setTimeout(done, 50))
    }
  }
  async function start(prompt: string, title: string): Promise<string> {
    await advance(0)
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'render-agent', prompt, requestId: randomUUID() },
    })
    await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title } })
    return sessionId
  }
  const settled = (id: string) => poll(async () => (await detail(id)).summary.status === 'idle', 'the turn to settle')

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'latch-render-'))
    control = join(scratch, 'step')
    await advance(0)
    const agent = join(scratch, 'render-agent.mjs')
    await writeFile(agent, agentSource(control))
    host = await startTestHost()
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'render-agent', name: 'Render Agent', command: process.execPath, args: [agent] },
    })
    // Browsers connect before any external Harness runs: while one runs or waits, the Host confirms no new device.
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
    phone = await enrolled(true)
    wide = await enrolled(false)
  })
  afterAll(async () => {
    await advance(99).catch(() => {})
    await phone?.context().close()
    await wide?.context().close()
    await browser?.close()
    await host?.close()
    if (scratch) await rm(scratch, { recursive: true, force: true })
  })

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
    await enrollBrowser(page, host, { name: touch ? '工作过程 手机' : '工作过程 电脑' })
    await connected(page)
    return page
  }
  async function open(width: number, height: number, theme: 'light' | 'dark', sessionId: string): Promise<Page> {
    const page = width < 768 ? phone : wide
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.reload()
    await connected(page)
    await openSession(page, sessionId)
    await page.locator('.transcript .turn').first().waitFor()
    return page
  }
  const shot = (page: Page, name: string, width: number, theme: string) =>
    page.screenshot({ path: `${OUTPUT}/${name}--${width}--${theme}.png`, animations: 'disabled' })
  const command = (page: Page, words: string) => page.locator('.tool-card.is-command').filter({ hasText: words })

  it('shows commands without their shell wrapper: a row once settled, a block with a five-line tail while running or failed', async () => {
    const id = await start('commands', '命令行的会话')
    await poll(
      async () => (await detail(id)).messages.some(message => message.id.endsWith('run_5') && !!message.tool?.output),
      'the running command',
    )
    for (const [width, height] of SIZES)
      for (const theme of THEMES) {
        const page = await open(width, height, theme, id)
        try {
          const listed = command(page, 'rg --files')
          const object = await listed.locator('.process-object').innerText()
          // The wrapper and its quoting are gone (the home directory as ~ is a unit case: a temp folder is under none).
          expect(object.startsWith("pwd; rg --files -g 'AGENTS.md' -g '!node_modules' /")).toBe(true)
          expect(object).not.toContain('zsh')
          // The reported line is one step away: in the tooltip, and in the opened row's arguments.
          expect(await listed.locator('.tool-card-header').getAttribute('title')).toContain('/bin/zsh -lc ')
          // Settled commands are rows with no output under them.
          for (const row of [listed, command(page, 'SKILL.md')]) {
            expect(await row.getAttribute('class')).not.toContain('is-block')
            expect(await row.locator('.command-tail').count()).toBe(0)
            expect((await row.boundingBox())!.height).toBeLessThanOrEqual(30)
          }
          // A shape Latch does not recognise stays as reported.
          expect(await command(page, 'echo $HOME').locator('.process-object').innerText()).toBe('bash -lc "echo $HOME"')
          // Failed and running commands are blocks; their tails are at most five screen lines, unwrapped.
          const failed = command(page, 'vitest run')
          const running = command(page, 'sleep 3')
          expect(await failed.locator('.process-object').innerText()).toBe('pnpm exec vitest run tests/settings.test.ts')
          for (const block of [failed, running]) {
            expect(await block.getAttribute('class')).toContain('is-block')
            const tail = await block.locator('.command-tail').evaluate(element => {
              const style = getComputedStyle(element)
              return {
                lines:
                  (element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight),
                wraps: style.whiteSpace,
                clipped: element.scrollWidth > element.clientWidth,
              }
            })
            expect(tail.lines).toBeLessThanOrEqual(5.01)
            expect(tail.wraps).toBe('pre')
            expect(tail.clipped).toBe(true)
          }
          expect(await running.locator('.command-caret').count()).toBe(1)
          await noHorizontalOverflow(page)
          await shot(page, 'commands-running', width, theme)
        } catch (error) {
          await page.screenshot({ path: `${OUTPUT}/failed-commands-${width}-${theme}.png` })
          throw error
        }
      }
    // Opening a settled row shows the reported command whole and its output; the reader stays where they were.
    const page = await open(1440, 900, 'light', id)
    const listed = command(page, 'rg --files')
    await listed.locator('.tool-card-header').click()
    await listed.locator('.argument-list').getByText('/bin/zsh -lc', { exact: false }).waitFor()
    await listed.locator('.tool-output').getByText('AGENTS.md', { exact: false }).waitFor()
    await shot(page, 'command-opened', 1440, 'light')
    await listed.locator('.tool-card-header').click()
    // Following the latest output, the running block turning into a row keeps the page at its end.
    const running = command(page, 'sleep 3')
    await advance(1)
    await settled(id)
    await page.locator('.work-fold').first().waitFor()
    const distance = await page.locator('.transcript').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
    expect(Math.abs(distance)).toBeLessThanOrEqual(2)
    await page.locator('.work-fold[aria-expanded="false"]').first().click()
    await expect.poll(async () => (await running.getAttribute('class')) ?? '').not.toContain('is-block')
    expect(await running.locator('.command-tail').count()).toBe(0)
    for (const theme of THEMES) {
      const again = await open(1440, 900, theme, id)
      await again.locator('.work-fold[aria-expanded="false"]').first().click()
      await command(again, 'sleep 3').waitFor()
      await shot(again, 'commands-settled', 1440, theme)
    }
  })

  it('puts the whole wrapped command on the approval card and names the wrapper', async () => {
    const id = await start('approval', '审批的会话')
    await poll(async () => (await detail(id)).approvals.length === 1, 'the approval')
    for (const [width, height] of SIZES)
      for (const theme of THEMES) {
        const page = await open(width, height, theme, id)
        try {
          const card = page.locator('.approval-panel').first()
          const shown = await card.locator('.approval-object').innerText()
          expect(shown.startsWith('set -e\n')).toBe(true)
          expect(shown).toContain('echo step-29 ')
          expect(shown).not.toContain('zsh')
          // Decided as written: nothing is cut.
          expect(await card.locator('.approval-object').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
          // A long command scrolls in its own box: its last line can be brought into view and the choices stay in reach.
          await card.locator('.approval-object').evaluate(element => element.scrollTo(0, element.scrollHeight))
          // (The card arms after a moment, so the buttons may still be held.)
          await reachable(card.getByRole('button', { name: '允许', exact: true }), { allowDisabled: true })
          await reachable(card.getByRole('button', { name: '拒绝', exact: true }), { allowDisabled: true })
          expect(await card.locator('.approval-shell').innerText()).toBe('经 zsh -lc')
          await noHorizontalOverflow(page)
          await shot(page, 'approval-command', width, theme)
        } catch (error) {
          await page.screenshot({ path: `${OUTPUT}/failed-approval-${width}-${theme}.png` })
          throw error
        }
      }
    const approval = (await detail(id)).approvals[0]!
    await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject', requestId: randomUUID() } })
    await settled(id)
  })
})
