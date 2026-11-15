import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings, noHorizontalOverflow, openSection, openSession, openSettings, reachable, settleShell } from './helpers/layout.ts'
import { switchLayout } from './helpers/workbench.ts'

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
const agentSource = (control: string, railExit: string) => `
import { readFileSync, writeFileSync } from 'node:fs'
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
turns.tail = async ({ sessionId, cwd, say, tool }) => {
  say('需要你允许一条命令。')
  const command = zsh('echo start' + '\\n'.repeat(41) + 'rm -rf ~')
  const toolCall = { toolCallId: 'tail_1', title: command, kind: 'execute', status: 'pending', rawInput: { command, cwd } }
  tool(toolCall)
  await request('session/request_permission', {
    sessionId,
    toolCall,
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  })
  tool({ toolCallId: 'tail_1', status: 'failed', content: [text('not run')] }, 'tool_call_update')
  say('\\n\\n没有运行。')
}
turns.reads = async ({ cwd, say, tool }) => {
  // The agent's own read and search tools, and one shell command between them.
  const run = (id, inner, quiet, output, status = 'completed') => {
    const call = quiet
      ? quiet.kind === 'read'
        ? { title: 'Read ' + quiet.path, kind: 'read', locations: [{ path: quiet.path }] }
        : { title: 'Search ' + quiet.query, kind: 'search', rawInput: { query: quiet.query } }
      : { title: zsh(inner), kind: 'execute', rawInput: { command: zsh(inner), cwd } }
    tool({ toolCallId: id, status: 'in_progress', ...call })
    if (status !== 'in_progress') tool({ toolCallId: id, status, content: [text(output)] }, 'tool_call_update')
  }
  say('先读几份说明。')
  run('act_1', 'cat ' + cwd + '/notes/SKILL.md', { kind: 'read', path: cwd + '/notes/SKILL.md' }, '# SKILL\\n\\n说明')
  run('act_2', '', { kind: 'search', query: 'docs' }, 'guide.md')
  run('act_3', '', { kind: 'search', query: 'AGENTS' }, './AGENTS.md:1:# AGENTS')
  run('act_4', 'sed -n 1,40p AGENTS.md', { kind: 'read', path: cwd + '/AGENTS.md' }, '# AGENTS')
  run('act_5', 'echo ok', undefined, 'ok')
  run('act_6', 'cat a.txt', { kind: 'read', path: cwd + '/a.txt' }, 'a')
  run('act_7', 'cat b.txt', { kind: 'read', path: cwd + '/b.txt' }, 'b')
  run('act_8', 'cat missing.txt', { kind: 'read', path: cwd + '/missing.txt' }, 'cat: missing.txt: No such file or directory', 'failed')
  run('act_9', 'cat c.txt', { kind: 'read', path: cwd + '/c.txt' }, 'c')
  run('act_10', 'cat d.txt', { kind: 'read', path: cwd + '/d.txt' }, 'd')
  run('act_11', 'cat e.txt', { kind: 'read', path: cwd + '/e.txt' }, 'e')
  run('act_12', 'cat slow.txt', { kind: 'read', path: cwd + '/slow.txt' }, '', 'in_progress')
  await reached(1)
  tool({ toolCallId: 'act_12', status: 'completed', content: [text('slow')] }, 'tool_call_update')
  await reached(2)
  say('\\n\\n读完了。')
}
turns.levels = async ({ sessionId, cwd, say, think, tool }) => {
  think('**Looking around**\\n\\nRead the notes first.', 'look')
  const quiet = (id, call, output) => {
    tool({ toolCallId: id, status: 'in_progress', ...call })
    tool({ toolCallId: id, status: 'completed', content: [text(output)] }, 'tool_call_update')
  }
  const run = (id, inner, output, status) => {
    const command = zsh(inner)
    tool({ toolCallId: id, title: command, kind: 'execute', status: 'in_progress', rawInput: { command, cwd } })
    tool({ toolCallId: id, status, content: [text(output)] }, 'tool_call_update')
  }
  quiet('lv_1', { title: 'Read a.txt', kind: 'read', locations: [{ path: cwd + '/a.txt' }] }, 'a')
  quiet('lv_2', { title: 'Search docs', kind: 'search', rawInput: { query: 'docs' } }, 'guide.md')
  quiet('lv_3', { title: 'Search x', kind: 'search', rawInput: { query: 'x' } }, './a.txt:1:x')
  run('lv_4', 'pnpm test', ' × one test failed', 'failed')
  run('lv_5', 'echo ok', 'ok', 'completed')
  say('需要你允许一条命令。', 'ask')
  const command = zsh('rm -rf build')
  const toolCall = { toolCallId: 'lv_6', title: command, kind: 'execute', status: 'pending', rawInput: { command, cwd } }
  tool(toolCall)
  await request('session/request_permission', {
    sessionId,
    toolCall,
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  })
  tool({ toolCallId: 'lv_6', status: 'failed', content: [text('not run')] }, 'tool_call_update')
  say('\\n\\n没有运行。', 'ask')
}
turns.thinking = async ({ say, think }) => {
  say(Array.from({ length: 14 }, (_, index) => '第 ' + (index + 1) + ' 段：先把要做的事说清楚，再开始动手。').join('\\n\\n'), 'intro')
  think('**Checking browser and environment**\\n\\nI look at \\x60AGENTS.md\\x60 first, then the **design** notes.\\n\\n', 'answer')
  think(Array.from({ length: 12 }, (_, index) => 'Step ' + (index + 1) + ': compare the layout with the reference and note what differs.').join('\\n') + '\\n\\n**Plann', 'answer')
  await reached(1)
  think('ing the page**\\n\\n- core concepts\\n- data types\\n- [docs](https://example.com/docs) and <b>bold</b>\\n\\nThen write it.', 'answer')
  await reached(2)
  say(Array.from({ length: 10 }, (_, index) => '结论 ' + (index + 1) + '：页面包含核心概念、数据类型和常用命令。').join('\\n\\n'), 'answer')
  await reached(3)
}
let locatedHistory = false
turns['定位'] = async ({ say }) => {
  locatedHistory = true
  say(Array.from({ length: 9 }, (_, index) => '第 ' + (index + 1) + ' 段：说明本地检查完成，输出已记录到会话。').join('\\n\\n'))
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
    const chunk = (sessionUpdate, value, messageId) => update(sessionId, { sessionUpdate, content: { type: 'text', text: value }, ...(messageId ? { messageId } : {}) })
    const say = (value, messageId) => chunk('agent_message_chunk', value, messageId)
    const think = (value, messageId) => chunk('agent_thought_chunk', value, messageId)
    const tool = (value, kind = 'tool_call') => update(sessionId, { sessionUpdate: kind, ...value })
    await turns[input.trim().split(/\\s+/u)[0]]?.({ sessionId, cwd: cwds.get(sessionId), say, think, tool })
    return reply({ stopReason: 'end_turn' })
  }
  send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
})
rl.on('close', () => process.exit(0))
process.on('exit', code => {
  if (code === 0 && locatedHistory) writeFileSync(${JSON.stringify(railExit)}, '')
})
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
  let railExit = ''
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
    railExit = join(scratch, 'rail-exit')
    await advance(0)
    const agent = join(scratch, 'render-agent.mjs')
    await writeFile(agent, agentSource(control, railExit))
    // A stand-in for the `codex` program: the test kit's app-server, which reports commands with Codex's own actions.
    const bin = join(scratch, 'bin')
    await mkdir(bin)
    const codex = join(bin, 'codex')
    await writeFile(
      codex,
      `#!/bin/sh\nexport FAKE_CODEX_STATE='${join(scratch, 'threads.json')}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
    )
    await chmod(codex, 0o755)
    host = await startTestHost({
      hostName: '验收电脑',
      commandDirectories: () => [bin],
      loginPrograms: name => (name === 'codex' ? codex : undefined),
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: codex } : { found: false }),
    })
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'render-agent', name: 'Render Agent', command: process.execPath, args: [agent] },
    })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} },
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

  it('locates history in both workbench layouts and with the side panel and find open', async ({ onTestFinished }) => {
    await rm(railExit, { force: true })
    const id = await start('定位 第 1 轮\n核对上次本地检查结果。\n确认内容后继续往下读。', '长会话回看')
    onTestFinished(async () => {
      await poll(async () => {
        const { status } = (await detail(id)).summary
        return status !== 'running' && status !== 'waiting-approval'
      }, 'the navigation turn to finish')
      await owner.json(`tasks/${id}`, { method: 'DELETE' })
      // ACP process cleanup continues after the Host replies to DELETE.
      await poll(
        () =>
          access(railExit).then(
            () => true,
            () => false,
          ),
        'the navigation agent to exit',
      )
    })
    await settled(id)
    for (let turn = 2; turn <= 8; turn++) {
      await owner.json(`tasks/${id}/prompt`, {
        method: 'POST',
        body: { prompt: `定位 第 ${turn} 轮\n复核输出里的文件记录。\n完成后查看下一条。`, requestId: randomUUID() },
      })
      await settled(id)
    }
    const userMessages = (await detail(id)).messages
      .filter(message => message.role === 'user' && !message.steered)
      .map(message => message.id)
    expect(userMessages).toHaveLength(8)
    const page = await open(1440, 900, 'dark', id)
    const rail = page.getByRole('navigation', { name: '会话定位', exact: true })
    const target = rail.getByRole('button').nth(1)
    const preview = page.locator('.conversation-rail-preview')
    await expect.poll(() => page.locator('.conversation-rail').count()).toBe(1)
    await expect.poll(() => rail.getByRole('button').count()).toBe(8)
    expect(await rail.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('value')))).toEqual(userMessages)
    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.focus()
    await target.hover()
    await preview.waitFor()
    await mkdir('test-results/conversation-rail', { recursive: true })
    await page.screenshot({ path: 'test-results/conversation-rail/app-before-palette-1440-dark.png', animations: 'disabled' })
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.waitFor()
    // A top layer may open before the browser tells the rail that the pointer left.
    await target.dispatchEvent('pointerover', { pointerType: 'mouse' })
    await preview.waitFor()
    const previousPreview = await preview.evaluateHandle(element => element)
    await page.keyboard.press('Escape')
    await palette.waitFor({ state: 'hidden' })
    await settleShell(page)
    expect(await previousPreview.evaluate(element => element.isConnected)).toBe(false)
    await preview.waitFor({ state: 'detached' })
    const anchor = (await target.boundingBox())!
    await page.mouse.move(anchor.x + anchor.width / 2 + 2, anchor.y + anchor.height / 2)
    await preview.waitFor()

    for (const layout of ['triage', 'overview'] as const) {
      await switchLayout(page, layout)
      const content = page.locator('.transcript')
      await target.hover()
      await expect.poll(() => preview.textContent()).toContain('复核输出里的文件记录。')
      await page.screenshot({ path: `test-results/conversation-rail/app-${layout}-1440-dark.png`, animations: 'disabled' })
      await target.click()
      await expect.poll(() => target.getAttribute('aria-current')).toBe('true')
      const row = content.locator('.message-user').filter({ hasText: '定位 第 2 轮' })
      await expect
        .poll(() =>
          row.evaluate(element => element.getBoundingClientRect().top - element.closest('.transcript')!.getBoundingClientRect().top),
        )
        .toBeCloseTo(24, 0)
      await preview.waitFor({ state: 'detached' })
    }

    await page.setViewportSize({ width: 1280, height: 900 })
    const panel = page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true })
    if ((await panel.getAttribute('aria-pressed')) !== 'true') await panel.click()
    await page.getByRole('tablist', { name: '会话面板', exact: true }).waitFor()
    await settleShell(page)
    await page.keyboard.press('Meta+f')
    const find = page.getByRole('search', { name: '会话内查找', exact: true })
    const query = find.getByRole('searchbox')
    const status = find.getByRole('status')
    const previous = find.getByRole('button', { name: '上一个匹配', exact: true })
    const next = find.getByRole('button', { name: '下一个匹配', exact: true })
    const closeFind = find.getByRole('button', { name: '关闭查找', exact: true })
    await query.fill('复核')
    await expect.poll(() => status.textContent()).toBe('1/7')
    await reachable(query)
    await reachable(previous)
    await reachable(next)
    await reachable(closeFind)
    await next.click()
    await expect.poll(() => status.textContent()).toBe('2/7')
    await previous.click()
    await expect.poll(() => status.textContent()).toBe('1/7')
    await query.fill('')
    await expect.poll(() => status.textContent()).toBe('')
    await query.fill('复核')
    await expect.poll(() => status.textContent()).toBe('1/7')
    await target.hover()
    await preview.waitFor()
    const previewBox = (await preview.boundingBox())!
    const paneBox = (await page.locator('.transcript-shell').boundingBox())!
    expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width)
    await noHorizontalOverflow(page, find)
    await page.screenshot({ path: 'test-results/conversation-rail/app-panel-find-1280-dark.png', animations: 'disabled' })
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'detached' })
    expect(await find.isVisible()).toBe(true)
    await closeFind.click()
    await panel.click()
  })

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
          // The wrapper and its quoting are gone; paths are written as reported.
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

  it('draws three or more finished reads and searches as one row that opens to them', async () => {
    const id = await start('reads', '读取的会话')
    await poll(async () => (await detail(id)).messages.some(message => message.id.endsWith('act_12')), 'the running read')
    for (const [width, height] of SIZES)
      for (const theme of THEMES) {
        const page = await open(width, height, theme, id)
        try {
          const row = (kind: string, words: string) => page.locator(`.tool-card[data-kind="${kind}"]`).filter({ hasText: words })
          const groups = page.locator('.reads-row')
          // Four finished quiet steps are one row that says what they were; two are still two rows.
          expect(await groups.locator('> .process-row').allInnerTexts()).toEqual(['读取 2 个文件，搜索 2 次', '读取 3 个文件'])
          expect(await row('read', 'a.txt').isVisible()).toBe(true)
          expect(await row('read', 'b.txt').isVisible()).toBe(true)
          // A command between them stays a command; a failed read and the one still running stay rows.
          expect(await page.locator('.tool-card.is-command').filter({ hasText: 'echo ok' }).count()).toBe(1)
          expect(await row('read', 'missing.txt').getAttribute('class')).toContain('tool-failed')
          expect(await row('read', 'slow.txt').isVisible()).toBe(true)
          expect(await row('read', 'SKILL.md').isVisible()).toBe(false)
          await noHorizontalOverflow(page)
          await shot(page, 'reads-grouped', width, theme)
          // Opened, the group lists its steps as the rows they were.
          await groups.first().locator('> .process-row').click()
          const skill = row('read', 'SKILL.md')
          await skill.waitFor()
          expect(await skill.locator('.process-verb').innerText()).toBe('读取')
          expect(await skill.locator('.process-folder').innerText()).toBe('notes/')
          expect(await row('search', 'docs').locator('.process-verb').innerText()).toBe('搜索')
          expect(await row('search', 'AGENTS').first().locator('.process-verb').innerText()).toBe('搜索')
          await noHorizontalOverflow(page)
          await shot(page, 'reads-opened', width, theme)
        } catch (error) {
          await page.screenshot({ path: `${OUTPUT}/failed-reads-${width}-${theme}.png` })
          throw error
        }
      }
    const page = await open(1440, 420, 'light', id)
    await page.locator('.reads-row').first().locator('> .process-row').click()
    // The reader looks at the first rows; the running read joining its group below must not move them.
    await page.locator('.transcript').hover()
    await page.mouse.wheel(0, -400)
    await expect.poll(() => page.locator('.jump-latest').count()).toBeGreaterThan(0)
    const anchor = page.locator('.tool-card[data-kind="read"]').filter({ hasText: 'a.txt' })
    const before = await anchor.evaluate(element => element.getBoundingClientRect().top)
    // On the other device the reader follows the latest output and stays at its end.
    const follower = await open(390, 844, 'light', id)
    await advance(1)
    await expect.poll(() => page.locator('.reads-row').last().locator('> .process-row').innerText()).toBe('读取 4 个文件')
    expect(Math.abs((await anchor.evaluate(element => element.getBoundingClientRect().top)) - before)).toBeLessThanOrEqual(1)
    await follower.locator('.reads-row').last().getByText('读取 4 个文件', { exact: true }).waitFor()
    const live = await follower
      .locator('main.workspace:not([inert]) .transcript')
      .evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
    expect(Math.abs(live)).toBeLessThanOrEqual(2)
    await advance(2)
    await settled(id)
    await follower.locator('.work-fold').first().waitFor()
    const gap = await follower
      .locator('main.workspace:not([inert]) .transcript')
      .evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
    expect(Math.abs(gap)).toBeLessThanOrEqual(2)
  })

  it('offers the way back to the latest output in a strip of its own, in words', async () => {
    const id = await start('thinking', '回到最新的会话')
    await poll(async () => ((await detail(id)).liveReasoning ?? '').endsWith('**Plann'), 'the first thought')
    for (const [width, height] of [
      [390, 640],
      [768, 640],
      [1440, 640],
    ] as const)
      for (const theme of THEMES) {
        const page = await open(width, height, theme, id)
        try {
          const scroller = page.locator('main.workspace:not([inert]) .transcript')
          await scroller.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true })))
          await scroller.evaluate(element => element.scrollBy(0, -300))
          const pill = page.locator('.jump-latest')
          await pill.waitFor()
          expect(await pill.innerText()).toBe('回到最新')
          // The pill stands within the last 40 of the conversation, and the words there are faded out under it.
          const place = await pill.evaluate(element => {
            const shell = element.closest('.transcript-shell')!.getBoundingClientRect()
            const own = element.getBoundingClientRect()
            const mask = getComputedStyle(element.closest('.transcript-shell')!.querySelector('.transcript')!).maskImage
            return {
              fromBottom: shell.bottom - own.top,
              centre: Math.abs((own.left + own.right) / 2 - (shell.left + shell.right) / 2),
              mask,
            }
          })
          expect(place.fromBottom).toBeLessThanOrEqual(40)
          expect(place.centre).toBeLessThanOrEqual(1)
          expect(place.mask).toContain('calc(100% - 56px)')
          await noHorizontalOverflow(page)
          await shot(page, 'jump-latest', width, theme)
        } catch (error) {
          await page.screenshot({ path: `${OUTPUT}/failed-jump-${width}-${theme}.png` })
          throw error
        }
      }
    await advance(3)
    await settled(id)
    // Blocks that arrive while the reader is away are counted in words; pressing it returns to the end.
    const busy = await start('commands', '新内容的会话')
    await poll(
      async () => (await detail(busy)).messages.some(message => message.id.endsWith('run_5') && !!message.tool?.output),
      'the running command',
    )
    const page = await open(1440, 420, 'light', busy)
    const scroller = page.locator('main.workspace:not([inert]) .transcript')
    await page.locator('.transcript').hover()
    await page.mouse.wheel(0, -300)
    const pill = page.locator('.jump-latest')
    await pill.waitFor()
    expect(await pill.innerText()).toBe('回到最新')
    await advance(1)
    await settled(busy)
    await expect.poll(() => pill.innerText()).toMatch(/^\d+ 条新内容$/u)
    await shot(page, 'jump-latest-new', 1440, 'light')
    await pill.click()
    await expect
      .poll(() => scroller.evaluate(element => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight)))
      .toBeLessThanOrEqual(2)
    await pill.waitFor({ state: 'hidden' })
  })

  it('draws a command as the read, listing or search Codex classified it as, and a piped or unclassified one as a command', async () => {
    const { sessionId: id } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'codex', prompt: 'look around', requestId: randomUUID() },
    })
    await owner.json(`tasks/${id}`, { method: 'PATCH', body: { title: 'Codex 分类的会话' } })
    await settled(id)
    for (const [width, height] of SIZES)
      for (const theme of THEMES) {
        const page = await open(width, height, theme, id)
        try {
          const fold = page.locator('.work-fold[aria-expanded="false"]')
          if ((await fold.count()) > 0) await fold.first().click()
          // Three plain commands Codex classified are quiet steps, so they are one row; opened, each says what it does.
          const group = page.locator('.reads-row')
          expect(await group.locator('> .process-row').allInnerTexts()).toEqual(['读取 1 个文件，列出 1 个文件夹，搜索 1 次'])
          await group.locator('> .process-row').click()
          const read = page.locator('.tool-card[data-kind="read"]').filter({ hasText: 'notes.txt' })
          await read.waitFor()
          expect(await read.locator('.process-verb').innerText()).toBe('读取')
          expect(await read.getAttribute('class')).not.toContain('is-command')
          // The reported command is one step away.
          expect(await read.locator('.tool-card-header').getAttribute('title')).toContain("/bin/zsh -lc 'cat notes.txt'")
          expect(
            await page.locator('.tool-card[data-kind="search"]').filter({ hasText: 'docs' }).locator('.process-verb').innerText(),
          ).toBe('列出')
          expect(
            await page.locator('.tool-card[data-kind="search"]').filter({ hasText: 'alpha' }).locator('.process-verb').innerText(),
          ).toBe('搜索')
          // Codex calls the pipeline one read; it pipes, so it is the command it is. So are the unclassified ones.
          const commands = page.locator('.tool-card.is-command[data-kind="execute"] .process-object')
          expect(await commands.allInnerTexts()).toEqual(['cat notes.txt | wc -l', 'echo ok', 'cat notes.txt && rm notes.txt'])
          await noHorizontalOverflow(page)
          await shot(page, 'codex-classified', width, theme)
        } catch (error) {
          await page.screenshot({ path: `${OUTPUT}/failed-codex-${width}-${theme}.png` })
          throw error
        }
      }
  })

  it('shows the current title while it thinks, folds with a height transition that keeps the place, and opens as restricted Markdown', async () => {
    const id = await start('thinking', '思考的会话')
    const reasoning = async () => (await detail(id)).liveReasoning ?? ''
    await poll(async () => (await reasoning()).endsWith('**Plann'), 'the first thought')
    const page = await open(1440, 700, 'light', id)
    try {
      const row = page.locator('.thinking').last()
      // The title that is still arriving is not shown: the line names the section the thought is in.
      await row.locator('.thinking-title').getByText('Checking browser and environment', { exact: true }).waitFor()
      expect(await row.locator('.thinking-toggle').innerText()).toContain('思考中')
      expect(await row.locator('.thinking-body').innerText()).not.toContain('**')
      await shot(page, 'thinking-live', 1440, 'light')
      await advance(1)
      await row.locator('.thinking-title').getByText('Planning the page', { exact: true }).waitFor()
      expect(await row.locator('.reasoning-heading').allInnerTexts()).toEqual(['Checking browser and environment', 'Planning the page'])
      for (const [width, height] of SIZES)
        for (const theme of THEMES) {
          const sized = await open(width, height, theme, id)
          await sized.locator('.thinking-title').last().getByText('Planning the page', { exact: true }).waitFor()
          await noHorizontalOverflow(sized)
          await shot(sized, 'thinking-live-titled', width, theme)
        }
      // The reader scrolls up to the words above; the thought folding away below must not move them.
      // A window short enough that the turn overflows it by more than the thought's own height.
      const reader = await open(1440, 780, 'light', id)
      await reader.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
      const body = reader.locator('.thinking').last().locator('.ui-collapse')
      await reader.locator('.thinking-title').last().waitFor()
      // Over the words at the top: the thought below scrolls in a box of its own and would take the wheel.
      const view = (await reader.locator('main.workspace:not([inert]) .transcript').boundingBox())!
      await reader.mouse.move(view.x + view.width / 2, view.y + 48)
      await reader.mouse.wheel(0, -430)
      await expect.poll(() => reader.locator('.jump-latest').count()).toBeGreaterThan(0)
      const open0 = await body.evaluate(element => element.getBoundingClientRect().height)
      expect(open0).toBeGreaterThan(100)
      // Far enough from the end that the thought folding away cannot pull the page's end above the reader.
      await expect
        .poll(() =>
          reader
            .locator('main.workspace:not([inert]) .transcript')
            .evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight),
        )
        .toBeGreaterThan(open0 + 40)
      // The first paragraph wholly in view is what the reader looks at.
      const anchorIndex = await reader.evaluate(() => {
        const view = document.querySelector('main.workspace:not([inert]) .transcript')!.getBoundingClientRect()
        return [...document.querySelectorAll('.message-assistant')[0]!.querySelectorAll('p')].findIndex(
          paragraph => paragraph.getBoundingClientRect().top >= view.top + 24,
        )
      })
      expect(anchorIndex).toBeGreaterThanOrEqual(0)
      const anchor = reader.locator('.message-assistant').first().locator('p').nth(anchorIndex)
      const before = await anchor.evaluate(element => element.getBoundingClientRect().top)
      // On the other device the reader follows the latest output: the fold must leave them at its end.
      const follower = await open(390, 844, 'light', id)
      await follower.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
      await follower.locator('.thinking-title').last().waitFor()
      // Sample the fold as it happens: heights between open and shut prove it is a transition, not a jump.
      const sample = (target: Page) =>
        target.evaluate(
          index =>
            new Promise<Array<{ height: number; top: number; gap: number; chars: number }>>(done => {
              const all = document.querySelectorAll('.thinking .ui-collapse')
              const collapse = all[all.length - 1]!
              const anchor = document.querySelectorAll('.message-assistant')[0]!.querySelectorAll('p')[index]!
              const scroller = document.querySelector('main.workspace:not([inert]) .transcript')!
              const seen: Array<{ height: number; top: number; gap: number; chars: number }> = []
              const started = performance.now()
              const frame = () => {
                seen.push({
                  height: collapse.getBoundingClientRect().height,
                  top: anchor.getBoundingClientRect().top,
                  gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
                  // The answer is the second block of prose; the first is the words above the thought.
                  chars: document.querySelectorAll('.message-assistant')[1]?.querySelector('.message-text')?.textContent?.length ?? 0,
                })
                if (performance.now() - started < 1500) requestAnimationFrame(frame)
                else done(seen)
              }
              requestAnimationFrame(frame)
            }),
          anchorIndex,
        )
      const reading = sample(reader)
      const following = sample(follower)
      await advance(2)
      const seen = await reading
      expect(seen.at(-1)!.height).toBeLessThan(2)
      expect(seen.some(frame => frame.height > 4 && frame.height < open0 - 4)).toBe(true)
      for (const frame of seen) expect(Math.abs(frame.top - before)).toBeLessThanOrEqual(1)
      // The answer came in one piece and is shown at an even pace: over several frames, only ever growing, and whole
      // within the reveal time and a little.
      const lengths = seen.map(frame => frame.chars)
      const arrived = lengths.findIndex(chars => chars > 0)
      const whole = lengths.indexOf(lengths.at(-1)!)
      expect(lengths.at(-1)).toBeGreaterThan(200)
      for (const [index, chars] of lengths.entries()) if (index > 0) expect(chars).toBeGreaterThanOrEqual(lengths[index - 1]!)
      expect(new Set(lengths.slice(arrived, whole + 1)).size).toBeGreaterThanOrEqual(4)
      expect(whole - arrived).toBeLessThanOrEqual(30)
      const followed = await following
      expect(followed.at(-1)!.height).toBeLessThan(2)
      expect(Math.abs(followed.at(-1)!.gap)).toBeLessThanOrEqual(2)
      await follower.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await reader.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      // Folded, it says how long it took; opened, it is Markdown with nothing that navigates or loads.
      const folded = reader.locator('.thinking').last()
      await expect.poll(() => folded.locator('.thinking-toggle').innerText()).toMatch(/^思考了 /u)
      expect(await folded.locator('.thinking-title').count()).toBe(0)
      await advance(3)
      await settled(id)
      for (const [width, height] of SIZES)
        for (const theme of THEMES) {
          const sized = await open(width, height, theme, id)
          const fold = sized.locator('.work-fold[aria-expanded="false"]')
          if ((await fold.count()) > 0) await fold.first().click()
          const thought = sized.locator('.thinking').last()
          await shot(sized, 'thinking-folded', width, theme)
          await thought.locator('.thinking-toggle').click()
          await thought.locator('.reasoning-content strong').getByText('design', { exact: true }).waitFor()
          expect(await thought.locator('.reasoning-content li').count()).toBe(3)
          expect(await thought.locator('a, img, b').count()).toBe(0)
          expect(await thought.locator('.reasoning-content').last().innerText()).toContain(
            '[docs](https://example.com/docs) and <b>bold</b>',
          )
          await noHorizontalOverflow(sized)
          await shot(sized, 'thinking-opened', width, theme)
        }
    } catch (error) {
      await page.screenshot({ path: `${OUTPUT}/failed-thinking.png` })
      throw error
    }
  })

  it('shows all of the work, only what went wrong, or the work folded, as the reader chose in settings', async () => {
    const id = await start('levels', '工作过程的会话')
    await poll(async () => (await detail(id)).approvals.length === 1, 'the approval')
    const choose = async (page: Page, label: string) => {
      const settings = await openSettings(page)
      await openSection(settings, '通用')
      const control = settings.getByRole('radiogroup', { name: '工作过程', exact: true })
      await control.scrollIntoViewIfNeeded()
      await reachable(control.getByRole('radio', { name: label, exact: true }))
      await control.getByRole('radio', { name: label, exact: true }).click()
      return settings
    }
    const rows = (page: Page) => ({
      group: page.locator('.reads-row:not(.steps-row)'),
      steps: page.locator('.steps-row'),
      thinking: page.locator('.thinking'),
      failed: page.locator('.tool-card.tool-failed').filter({ hasText: 'pnpm test' }),
      done: page.locator('.tool-card.is-command').filter({ hasText: 'echo ok' }),
      waiting: page.locator('.tool-card').filter({ hasText: 'rm -rf build' }),
      card: page.locator('.approval-panel'),
    })
    for (const [width, height] of SIZES)
      for (const theme of THEMES) {
        const page = await open(width, height, theme, id)
        try {
          // 全部显示, as every device starts.
          let settings = await choose(page, '全部显示')
          await shot(page, 'levels-setting', width, theme)
          await closeSettings(settings)
          await openSession(page, id)
          let seen = rows(page)
          await seen.failed.waitFor()
          expect([await seen.group.count(), await seen.thinking.count(), await seen.done.count(), await seen.steps.count()]).toEqual([
            1, 1, 1, 0,
          ])
          await shot(page, 'levels-all', width, theme)
          // 只留失败: the failed command, the call that waits and its card; nothing that went well.
          settings = await choose(page, '只留失败')
          await closeSettings(settings)
          await openSession(page, id)
          seen = rows(page)
          await seen.failed.waitFor()
          expect([await seen.group.count(), await seen.thinking.count(), await seen.done.count(), await seen.steps.count()]).toEqual([
            0, 0, 0, 0,
          ])
          expect(await seen.waiting.count()).toBe(1)
          expect(await seen.card.count()).toBe(1)
          await page.getByText('需要你允许一条命令。', { exact: true }).waitFor()
          await noHorizontalOverflow(page)
          await shot(page, 'levels-failures', width, theme)
          // 收起: the same rows stay, and the rest is one row between them that opens to what it holds.
          settings = await choose(page, '收起')
          await closeSettings(settings)
          await openSession(page, id)
          seen = rows(page)
          await seen.failed.waitFor()
          expect(await seen.steps.locator('> .process-row').allInnerTexts()).toEqual(['工作过程 · 3 步', '工作过程 · 1 步'])
          expect([await seen.waiting.count(), await seen.card.count()]).toEqual([1, 1])
          expect(await seen.done.isVisible()).toBe(false)
          await noHorizontalOverflow(page)
          await shot(page, 'levels-folded', width, theme)
          await seen.steps.first().locator('> .process-row').click()
          await seen.thinking.waitFor()
          await seen.group.waitFor()
          await shot(page, 'levels-folded-opened', width, theme)
        } catch (error) {
          await page.screenshot({ path: `${OUTPUT}/failed-levels-${width}-${theme}.png` })
          throw error
        }
      }
    // The choice is this device's and stays across a reload; every device ends on the default again.
    const page = await open(1440, 900, 'light', id)
    expect(await rows(page).steps.count()).toBe(2)
    for (const device of [wide, phone]) await closeSettings(await choose(device, '全部显示'))
    const approval = (await detail(id)).approvals[0]!
    await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject', requestId: randomUUID() } })
    await settled(id)
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
          expect(await card.locator('.approval-shell').innerText()).toBe('经 /bin/zsh -lc')
          // Scrolled to its end nothing lies below, so nothing says there is more.
          await card.locator('.approval-more-lines').waitFor({ state: 'hidden' })
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
    // A command whose last line is far below what the box shows: the card says how many lines are still to read.
    const tailed = await start('tail', '藏着尾巴的会话')
    await poll(async () => (await detail(tailed)).approvals.length === 1, 'the approval')
    for (const [width, height] of SIZES) {
      const page = await open(width, height, 'light', tailed)
      const card = page.locator('.approval-panel').first()
      const box = card.locator('.approval-object.is-command')
      const more = card.locator('.approval-more-lines')
      await more.waitFor()
      const hidden = await box.evaluate(element =>
        Math.round((element.scrollHeight - element.clientHeight) / parseFloat(getComputedStyle(element).lineHeight)),
      )
      expect(hidden).toBeGreaterThan(10)
      expect(await more.innerText()).toBe(`还有 ${hidden} 行`)
      expect(await box.evaluate(element => getComputedStyle(element).maskImage)).toContain('linear-gradient')
      await shot(page, 'approval-tail', width, 'light')
      await box.evaluate(element => element.scrollTo(0, element.scrollHeight))
      await more.waitFor({ state: 'hidden' })
      expect(await box.innerText()).toContain('rm -rf ~')
    }
    const last = (await detail(tailed)).approvals[0]!
    await owner.json(`approvals/${last.id}`, { method: 'POST', body: { decision: 'reject', requestId: randomUUID() } })
    await settled(tailed)
  })
})
