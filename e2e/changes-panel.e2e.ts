import { chromium, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ChangedFile, ChangeList, ChangeReceipt, FileChangeDetail, TurnChanges } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openSession, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/changes-panel'

/** Closed, the model below waits before it answers, and the session runs for as long as a case needs. */
let modelGate: Promise<void> = Promise.resolve()

/** A model that edits one file through the agent's own tool, then answers. */
const writer: HarnessPlugin = {
  id: 'changes-fixture',
  name: 'Fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'writer',
      name: 'Fixture',
      model: 'fixture',
      async *stream({ messages }) {
        await modelGate
        const done = messages.some(message => message.role === 'tool')
        if (done) {
          yield { type: 'text', text: '改好了。' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield {
          type: 'tool-call',
          call: { id: 'write', name: 'write_file', arguments: { path: 'report.txt', content: 'first\nsecond\nchanged\n' } },
        }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    })
  },
}

async function session(host: TestHost): Promise<string> {
  const { sessionId } = await host.host.bridge.createTask({
    prompt: '改一下报告',
    requestId: randomUUID(),
    mode: 'agent',
    model: { providerId: 'writer', model: 'fixture' },
  })
  await expect.poll(() => host.host.bridge.approvals().length).toBe(1)
  expect(await host.host.bridge.decide(host.host.bridge.approvals()[0]!.id, 'allow')).toBe(true)
  await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
  return sessionId
}

function repository(root: string) {
  return (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, stdio: 'pipe' })
}

/** The session, after a reload: narrow windows keep their list in a drawer, and a reload keeps the session it had. */
async function choose(page: Page, sessionId: string) {
  await page.locator('.app-shell').waitFor()
  await settleShell(page)
  if (await page.locator('.workspace.has-task').count()) return
  await openSession(page, sessionId)
}

async function reopen(page: Page, sessionId: string) {
  await page.reload()
  await choose(page, sessionId)
}

/** The browser device with everything the routes ask for: run, and the data scope of a session's folders. */
async function openBrowser(page: Page, host: TestHost, sessionId: string, dataScope: 'all' | 'work' = 'all') {
  const name = `Review ${randomUUID()}`
  await enrollBrowser(page, host, { name, scopes: ['admin'] })
  const owner = await host.enroll({ listener: 'unix' })
  const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
  const id = devices.devices.find(item => item.name === name)!.id
  if (dataScope === 'all')
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await reopen(page, sessionId)
}

it('reviews a turn, undoes and restores it with a receipt, and names what Git is in the middle of', async () => {
  const host = await startTestHost({ demo: false, plugins: [writer] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const git = repository(host.workspaceRoot)
    git('init', '-q', '-b', 'main')
    await writeFile(join(host.workspaceRoot, 'report.txt'), 'first\nsecond\nold\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    const sessionId = await session(host)

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await openBrowser(page, host, sessionId)

    // The header's toggle opens the tab: scope, stat, undo, and the first file already open.
    await page.getByRole('button', { name: '改动', exact: true }).click()
    const panel = page.locator('.changes-panel')
    await panel.getByText('report.txt', { exact: true }).waitFor()
    await expect.poll(() => panel.locator('.changes-scope-button').innerText()).toBe('本轮')
    await panel.locator('.diff-add', { hasText: 'changed' }).waitFor()
    expect(await panel.locator('.changes-stat-total').innerText()).toMatch(/\+1\s*−1/u)

    // A line's feedback goes into the pending set on the Host, not into the composer (e2e/review-notes.e2e.ts goes on).
    await panel.locator('.diff-add', { hasText: 'changed' }).hover()
    await panel.locator('.diff-add').getByRole('button', { name: '反馈第 3 行', exact: true }).click()
    await panel.getByRole('textbox', { name: '反馈' }).fill('这里写得不对')
    await panel.getByRole('button', { name: '加入待发', exact: true }).click()
    await panel.getByText('待发反馈 1 条').waitFor()
    expect(await page.locator('.composer textarea').inputValue()).toBe('')
    await panel.getByRole('button', { name: '删除反馈', exact: true }).click()
    await expect.poll(() => panel.getByText('待发反馈 1 条').count()).toBe(0)

    // Undo: nothing to warn about, so it runs at once and the receipt says what it did.
    await panel.getByRole('button', { name: '撤销本轮', exact: true }).click()
    await panel.getByRole('status').getByText('已撤销本轮改动').waitFor()
    await panel.getByRole('status').getByText('写回 1 个文件。', { exact: false }).waitFor()
    expect(await readFile(join(host.workspaceRoot, 'report.txt'), 'utf8')).toBe('first\nsecond\nold\n')
    await panel.getByRole('button', { name: '恢复', exact: true }).click()
    await panel.getByRole('status').getByText('已恢复本轮改动').waitFor()
    expect(await readFile(join(host.workspaceRoot, 'report.txt'), 'utf8')).toBe('first\nsecond\nchanged\n')

    // The file's own undo sits on its head, and the receipt says what it did.
    await panel.locator('.changes-file-head').first().hover()
    await panel.getByRole('button', { name: '撤销此文件', exact: true }).click()
    // It has no 恢复, so it asks first and writes nothing until it has an answer.
    await page.getByRole('dialog').getByText('这一步不能恢复', { exact: false }).waitFor()
    expect(await readFile(join(host.workspaceRoot, 'report.txt'), 'utf8')).toBe('first\nsecond\nchanged\n')
    await page.getByRole('dialog').getByRole('button', { name: '撤销此文件', exact: true }).click()
    await panel.getByRole('status').getByText('已撤销 report.txt').waitFor()
    expect(await readFile(join(host.workspaceRoot, 'report.txt'), 'utf8')).toBe('first\nsecond\nold\n')
    await panel.locator('.changes-file-head').getByText('已撤销', { exact: true }).waitFor()
    await panel.locator('.changes-file-head').first().hover()
    expect(await panel.getByRole('button', { name: '撤销此文件', exact: true }).count()).toBe(0)

    // A file changed since: the same place says why.
    await writeFile(join(host.workspaceRoot, 'report.txt'), 'later\n')
    await reopen(page, sessionId)
    await page.getByRole('button', { name: '改动', exact: true }).click()
    await panel.getByText('之后又改过这些文件，不能撤销').waitFor()
    await writeFile(join(host.workspaceRoot, 'report.txt'), 'first\nsecond\nchanged\n')

    // The turn's card opens this turn: 打开改动 is the one way in from the conversation.
    await page.locator('.changed-files').last().getByRole('button', { name: '打开改动', exact: true }).click()
    await expect.poll(() => panel.locator('.changes-scope-button').innerText()).toBe('第 1 轮')

    // A picked turn with no answer says so, without claiming it aged out while the record still holds it.
    await page.route(/\/changes\?scope=turn&turn=/u, route =>
      route.fulfill({ status: 404, json: { error: 'change-turn-missing', message: '没有这一轮的改动记录。' } }),
    )
    await panel.locator('.changes-scope-button').click()
    await page.getByRole('menuitemradio', { name: /这个会话/u }).click()
    await panel.getByText('只读', { exact: true }).waitFor()
    await page.locator('.changed-files').last().getByRole('button', { name: '打开改动', exact: true }).click()
    await panel.getByText('这一轮没有记录到改动').waitFor()
    await page.unroute(/\/changes\?scope=turn&turn=/u)

    // 这个会话 reads only; between-turn work carries its note there once a later turn records it.
    await panel.locator('.changes-scope-button').click()
    await page.getByRole('menuitemradio', { name: /这个会话/u }).click()
    await panel.getByText('只读', { exact: true }).waitFor()

    await writeFile(join(host.workspaceRoot, 'between.txt'), 'by a person\n')
    // 未提交 from this browser, which is not this computer: the Host's rule, in words.
    await panel.locator('.changes-scope-button').click()
    await page.getByRole('menuitemradio', { name: /未提交/u }).click()
    await panel.getByText('只能在 Mac 的 Latch 中撤销').waitFor()
    await panel.getByText('between.txt', { exact: true }).waitFor()

    // A merge stops: a line, the file marked and the action gone.
    git('add', 'report.txt')
    git('commit', '-q', '-m', 'turn')
    git('checkout', '-q', '-b', 'side', 'HEAD~1')
    await writeFile(join(host.workspaceRoot, 'report.txt'), 'side\n')
    git('commit', '-q', '-am', 'side')
    git('checkout', '-q', 'main')
    expect(() => git('merge', 'side')).toThrow()
    await reopen(page, sessionId)
    await page.getByRole('button', { name: '改动', exact: true }).click()
    await panel.locator('.changes-scope-button').click()
    await page.getByRole('menuitemradio', { name: /未提交/u }).click()
    await panel.getByText('仓库正在合并 · 1 个文件有冲突').waitFor()
    await panel.getByText('合并中不能撤销').waitFor()
    await panel.getByText('有冲突', { exact: true }).first().waitFor()
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})

it('tells a device outside the data scope why it sees nothing, and the Host agrees', async () => {
  const host = await startTestHost({ demo: false, plugins: [writer] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const sessionId = await session(host)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await openBrowser(page, host, sessionId, 'work')
    await page.getByRole('button', { name: '改动', exact: true }).click()
    await page.locator('.changes-panel').getByText('这台设备看不到会话文件夹里的文件').waitFor()
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})

// ---- every state, drawn from the Host's answers, for review at three widths in both themes ------------------------

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  root: 'default',
  path,
  status: 'M',
  add: 1,
  del: 1,
  ...extra,
})
const FILES: ChangedFile[] = [
  file('apps/desktop/assets/dmg-background.tiff', { notRetained: true, add: undefined, del: undefined }),
  file('apps/desktop/src/main.cjs', { add: 6, del: 2 }),
  file('apps/desktop/src/preload.cjs', { add: 2, del: 1 }),
  file('apps/desktop/test/window-size.test.ts', { status: 'A', add: 12, del: 0 }),
  file('apps/desktop/.env.electron', { secret: true, add: undefined, del: undefined }),
  file('apps/desktop/package.json'),
  file('package.json'),
  file('pnpm-lock.yaml', { add: 62, del: 24, byCommand: true }),
]
const TOTALS = { files: 8, add: 84, del: 29 }
const TURN = 'run-14'
const turnList = (extra: Partial<ChangeList> = {}): ChangeList => ({
  scope: 'turn',
  turnId: TURN,
  files: FILES,
  totals: TOTALS,
  undo: { available: true },
  redo: { available: false, reason: 'not-undone' },
  ...extra,
})
const settled = (extra: Partial<TurnChanges> = {}): TurnChanges => ({
  turnId: TURN,
  startedAt: '2026-11-01T08:20:00.000Z',
  settledAt: '2026-11-01T08:23:00.000Z',
  state: 'settled',
  files: 8,
  ...extra,
})
const DETAIL = (changed: ChangedFile): FileChangeDetail => ({
  scope: 'turn',
  file: changed,
  hunks: [
    {
      oldStart: 1,
      oldLines: 12,
      newStart: 1,
      newLines: 12,
      lines: [
        ...Array.from({ length: 6 }, (_, at) => ({
          kind: 'context' as const,
          text: `// line ${at + 1}`,
          oldLine: at + 1,
          newLine: at + 1,
        })),
        {
          kind: 'remove' as const,
          text: "  const win = new BrowserWindow({ width: 1440, height: 900, titleBarStyle: 'hidden' })",
          oldLine: 7,
        },
        { kind: 'add' as const, text: '  const win = new BrowserWindow({', newLine: 7 },
        { kind: 'add' as const, text: '    width: 1440, height: 900,', newLine: 8 },
        {
          kind: 'add' as const,
          text: "    titleBarStyle: 'hidden', // Electron 44.9 changed the default height of a hidden title bar, so it is fixed",
          newLine: 9,
        },
        { kind: 'add' as const, text: '  })', newLine: 10 },
        ...Array.from({ length: 4 }, (_, at) => ({
          kind: 'context' as const,
          text: `// line ${at + 8}`,
          oldLine: at + 8,
          newLine: at + 11,
        })),
      ],
    },
  ],
})
const RECEIPT: ChangeReceipt = {
  sessionId: 's',
  turnId: TURN,
  requestId: 'request-1234',
  action: 'undo',
  restored: 5,
  removed: 1,
  skipped: 2,
  notRestored: [
    { root: 'default', path: 'apps/desktop/assets/dmg-background.tiff', reason: 'not-retained' },
    { root: 'default', path: 'apps/desktop/.env.electron', reason: 'secret' },
  ],
  notCovered: ['~/Library/Caches/electron/settings.json'],
  noteNextTurn: true,
  at: '2026-11-01T08:24:00.000Z',
}

interface Frame {
  name: string
  list: ChangeList
  turns?: TurnChanges[]
  /** Press this after the panel shows, for frames that need a press. */
  press?: string
}
const uncommitted = (extra: Partial<ChangeList> = {}): ChangeList => ({
  scope: 'uncommitted',
  files: FILES.slice(1, 4),
  totals: { files: 3, add: 20, del: 3 },
  ...extra,
})
const FRAMES: Frame[] = [
  { name: 'list', list: turnList() },
  { name: 'partial', list: turnList({ partial: true }) },
  {
    name: 'running',
    list: turnList({ running: true, undo: { available: false, reason: 'running' } }),
    turns: [settled({ state: 'running', files: undefined })],
  },
  {
    name: 'interrupted',
    list: turnList({ running: true, undo: { available: false, reason: 'not-settled' } }),
    turns: [settled({ state: 'interrupted', files: undefined })],
  },
  { name: 'changed-since', list: turnList({ undo: { available: false, reason: 'changed-since' } }) },
  {
    name: 'undone',
    list: turnList({
      undone: true,
      undo: { available: false, reason: 'undone' },
      redo: { available: true },
      notCovered: RECEIPT.notCovered,
    }),
    turns: [settled({ undone: true, notePending: true })],
  },
  {
    name: 'redo-blocked',
    list: turnList({ undone: true, undo: { available: false, reason: 'undone' }, redo: { available: false, reason: 'changed-since' } }),
    turns: [settled({ undone: true })],
  },
  { name: 'other-session', list: turnList({ otherSessions: ['other'] }) },
  {
    name: 'conflict',
    list: uncommitted({
      conflict: { operation: 'merge', files: 2 },
      files: FILES.slice(1, 3).map(item => ({ ...item, conflicted: true as const })),
    }),
  },
  { name: 'uncommitted', list: uncommitted() },
  { name: 'not-git', list: { scope: 'uncommitted', files: [], totals: { files: 0, add: 0, del: 0 }, unavailable: 'not-git' } },
  { name: 'git-failed', list: { scope: 'uncommitted', files: [], totals: { files: 0, add: 0, del: 0 }, unavailable: 'git-failed' } },
  {
    name: 'no-changes',
    list: { ...turnList(), files: [], totals: { files: 0, add: 0, del: 0 }, undo: { available: false, reason: 'no-changes' } },
  },
  { name: 'no-turns', list: { scope: 'turn', files: [], totals: { files: 0, add: 0, del: 0 }, unavailable: 'no-turns' }, turns: [] },
  { name: 'receipt', list: turnList(), press: 'receipt' },
  { name: 'undo-warning', list: turnList(), press: 'warning' },
  { name: 'scope-menu', list: turnList(), press: 'scope' },
  { name: 'maximised', list: turnList(), press: 'maximise' },
  { name: 'tree', list: turnList(), press: 'tree' },
]

it('tells the truth at both ends of a turn, whatever the turn record has reached', async () => {
  const host = await startTestHost({ demo: false, plugins: [writer] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const sessionId = await session(host)
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })).newPage()
    page.setDefaultTimeout(15_000)
    let realTurns: TurnChanges[] = [],
      realList: ChangeList | undefined,
      heldTurns: TurnChanges[] | undefined,
      heldList: ChangeList | undefined
    await page.route(/\/changes\/turns(\?|$)/u, async route => {
      if (heldTurns) return route.fulfill({ json: { turns: heldTurns } })
      const response = await route.fetch()
      realTurns = ((await response.json()) as { turns: TurnChanges[] }).turns
      return route.fulfill({ response })
    })
    await page.route(/\/changes\?/u, async route => {
      if (heldList) return route.fulfill({ json: heldList })
      const response = await route.fetch()
      realList = (await response.json()) as ChangeList
      return route.fulfill({ response })
    })
    await openBrowser(page, host, sessionId)
    await page.getByRole('button', { name: '改动', exact: true }).click()
    const panel = page.locator('.changes-panel')
    const undoTurn = panel.getByRole('button', { name: '撤销本轮', exact: true })
    await undoTurn.waitFor()
    const runningLine = panel.getByText('运行中 · 点按刷新')

    // The status moves first: the record still shows the last turn settled, and the panel goes by the status.
    let openModel = () => {}
    modelGate = new Promise(resolve => {
      openModel = resolve
    })
    heldTurns = realTurns
    heldList = realList
    await host.host.bridge.prompt(sessionId, '再来一次', randomUUID())
    await panel.getByText('运行中不能撤销', { exact: true }).waitFor()
    await runningLine.waitFor()
    expect(await undoTurn.count()).toBe(0)

    // The record catches up by itself.
    heldTurns = undefined
    await expect.poll(() => realTurns.at(-1)?.state, { timeout: 15_000 }).toBe('running')

    // The status moves first at the end as well, and the record's walk takes as long as the folder is big.
    heldTurns = realTurns
    heldList = { ...realList!, running: true, undo: { available: false, reason: 'running' } }
    openModel()
    await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')
    await page.waitForTimeout(800)
    await runningLine.waitFor()
    heldTurns = undefined
    heldList = undefined
    await panel.getByText('这一轮没有改动文件', { exact: true }).waitFor()
    expect(await runningLine.count()).toBe(0)
    expect(await panel.getByText('运行中不能撤销', { exact: true }).count()).toBe(0)
  } finally {
    modelGate = Promise.resolve()
    await browser.close()
    await host.close()
  }
})

it('goes from the conversation to the turn and file, and a turn taken back in one place reads so in the other', async () => {
  const host = await startTestHost({ demo: false, plugins: [writer] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const sessionId = await session(host)
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })).newPage()
    page.setDefaultTimeout(15_000)
    await openBrowser(page, host, sessionId)
    const card = page.getByRole('region', { name: '这一轮改动的文件', exact: true })
    await card.getByRole('button', { name: '打开改动', exact: true }).click()
    const panel = page.locator('.changes-panel')
    await panel.locator('.changes-file[data-selected]', { hasText: 'report.txt' }).waitFor()
    await expect.poll(() => panel.locator('.changes-scope-button').innerText()).toMatch(/第 1 轮|本轮/u)

    // The tab's undo reaches the card.
    await panel.getByRole('button', { name: '撤销本轮', exact: true }).click()
    await panel.getByRole('status').getByText('已撤销本轮改动').waitFor()
    const record = page.getByRole('region', { name: '已撤销本轮改动', exact: true })
    await record.waitFor()
    expect(await card.count()).toBe(0)

    // The card's 恢复 reaches the tab.
    await record.getByRole('button', { name: '恢复', exact: true }).click()
    await card.getByRole('button', { name: '撤销本轮', exact: true }).waitFor()
    await panel.getByRole('button', { name: '撤销本轮', exact: true }).waitFor()
    expect(await panel.getByRole('button', { name: '恢复', exact: true }).count()).toBe(0)
  } finally {
    await browser.close()
    await host.close()
  }
})

it('shows nothing of the last scope under the next label, keeps a list a failed refresh could not replace, and settles a doubt', async () => {
  const host = await startTestHost({ demo: false, plugins: [writer] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const sessionId = await session(host)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await openBrowser(page, host, sessionId)
    await page.getByRole('button', { name: '改动', exact: true }).click()
    const panel = page.locator('.changes-panel')
    const undoTurn = panel.getByRole('button', { name: '撤销本轮', exact: true })
    await undoTurn.waitFor()

    // A slow answer: the label moved, so the old rows and their action are gone at once.
    let answer = () => {}
    const answered = new Promise<void>(resolve => {
      answer = resolve
    })
    await page.route(/\/changes\?scope=uncommitted/u, async route => {
      await answered
      await route.continue()
    })
    await panel.locator('.changes-scope-button').click()
    await page.getByRole('menuitemradio', { name: /未提交/u }).click()
    await panel.getByText('正在读取…').waitFor()
    await expect.poll(() => panel.locator('.changes-scope-button').innerText()).toBe('未提交')
    expect(await undoTurn.count()).toBe(0)
    expect(await panel.locator('.changes-file').count()).toBe(0)
    answer()
    await panel.getByText('这个文件夹不是 Git 仓库的顶层').waitFor()
    await page.unroute(/\/changes\?scope=uncommitted/u)
    await panel.locator('.changes-scope-button').click()
    await page.getByRole('menuitemradio', { name: /第 1 轮|这一轮/u }).click()
    await undoTurn.waitFor()

    // A refresh that fails leaves the list it was refreshing, and says so.
    await page.route(/\/changes\?scope=turn/u, route => route.abort('failed'))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const noRefresh = panel.getByText('没有刷新成功 · 这是上次的列表')
    await noRefresh.waitFor()
    expect(await panel.locator('.changes-file').count()).toBe(1)
    await page.unroute(/\/changes\?scope=turn/u)
    await noRefresh.click()
    await expect.poll(() => noRefresh.count()).toBe(0)

    // Offline nothing can be written, and the row says so instead of failing on a press.
    await context.setOffline(true)
    await panel.getByText('离线时不能撤销', { exact: true }).waitFor()
    await context.setOffline(false)
    await undoTurn.waitFor()

    // The undo took and its answer was lost: once the list shows that, the doubt and its advice to press again go.
    await page.route(/\/turns\/[^/]+\/undo$/u, async route => {
      await route.fetch()
      await route.abort('failed')
    })
    await undoTurn.click()
    await panel.getByRole('button', { name: '恢复', exact: true }).waitFor()
    await panel.getByText('已撤销本轮改动').first().waitFor()
    expect(await panel.getByText('不确定有没有完成', { exact: false }).count()).toBe(0)
  } finally {
    await browser.close()
    await host.close()
  }
})

it('keeps a very long list quick: a window of tree rows, a page of file rows, each diff read on demand', async () => {
  const host = await startTestHost({ demo: false, plugins: [writer] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const sessionId = await session(host)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    let count = 0,
      detailReads = 0
    await page.route(/\/link\/api\/tasks\/[^/]+\/changes(\/(file|turns))?(\?|$)/u, route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/turns')) return route.fulfill({ json: { turns: [settled()] } })
      if (url.pathname.endsWith('/file')) {
        detailReads++
        return route.fulfill({ json: DETAIL(FILES[1]!) })
      }
      const files = Array.from({ length: count }, (_, at) => file(`src/group-${Math.floor(at / 50)}/file-${at}.ts`))
      return route.fulfill({ json: turnList({ files, totals: { files: count, add: count, del: count } }) })
    })
    await openBrowser(page, host, sessionId)
    for (const size of [400, 1000, 5000, 20000]) {
      count = size
      detailReads = 0
      await reopen(page, sessionId)
      const started = Date.now()
      await page.getByRole('button', { name: '改动', exact: true }).click()
      await page.locator('.changes-file').first().waitFor()
      const ready = Date.now() - started
      const panel = page.locator('.changes-panel')
      const treeShown = await panel.getByRole('button', { name: '文件树', exact: true }).getAttribute('aria-pressed')
      if (treeShown !== 'true') await panel.getByRole('button', { name: '文件树', exact: true }).click()
      await panel.locator('.changes-tree').waitFor()
      const treeRows = await panel.locator('.changes-tree-row').count()
      expect(ready, `panel with ${size} files`).toBeLessThan(5000)
      expect(await panel.locator('.changes-file').count()).toBeLessThanOrEqual(150)
      expect(treeRows).toBeLessThanOrEqual(400)
      expect(detailReads).toBeLessThanOrEqual(1)
      if (size >= 1000) expect(detailReads).toBe(0)
      await panel.getByRole('button', { name: '文件树', exact: true }).click()
    }
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})

it('draws every state at three widths in both themes', async () => {
  const host = await startTestHost({ demo: false, plugins: [writer] })
  const browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUT, { recursive: true })
  try {
    const sessionId = await session(host)
    for (const [viewport, width, height, theme] of [
      ['phone', 390, 844, 'light'],
      ['tablet', 768, 1024, 'dark'],
      ['desktop', 1440, 900, 'light'],
      ['desktop', 1440, 900, 'dark'],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: 'zh-CN', hasTouch: width < 768 })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      let frame = FRAMES[0]!
      await page.route(/\/link\/api\/tasks\/[^/]+\/changes(\/(file|turns))?(\?|$)/u, route => {
        const url = new URL(route.request().url())
        if (url.pathname.endsWith('/turns')) return route.fulfill({ json: { turns: frame.turns ?? [settled()] } })
        if (url.pathname.endsWith('/file')) {
          const changed = frame.list.files.find(item => item.path === url.searchParams.get('path')) ?? FILES[1]!
          return route.fulfill({ json: DETAIL(changed) })
        }
        return route.fulfill({ json: frame.list })
      })
      await page.route(/\/link\/api\/tasks\/[^/]+\/turns\/[^/]+\/undo$/u, route => {
        // The list the Host answers after an undo: the row then offers 恢复, and the receipt stands above it.
        frame = {
          ...frame,
          list: turnList({ undone: true, undo: { available: false, reason: 'undone' }, redo: { available: true } }),
          turns: [settled({ undone: true })],
        }
        return route.fulfill({ json: RECEIPT })
      })
      await openBrowser(page, host, sessionId)
      for (const next of FRAMES) {
        frame = next
        await reopen(page, sessionId)
        await page.getByRole('button', { name: '改动', exact: true }).click()
        const panel = page.locator('.changes-panel')
        await panel.locator('.changes-scope-row').waitFor()
        if (next.list.scope === 'uncommitted') {
          await panel.locator('.changes-scope-button').click()
          await page.getByRole('menuitemradio', { name: /未提交/u }).click()
        }
        if (next.press === 'receipt' || next.press === 'warning') await panel.getByRole('button', { name: '撤销本轮', exact: true }).click()
        if (next.press === 'receipt') await page.getByRole('button', { name: '撤销本轮', exact: true }).last().click()
        if (next.press === 'scope') await panel.locator('.changes-scope-button').click()
        if (next.press === 'maximise' && width >= 768) await page.getByRole('button', { name: '铺满', exact: true }).click()
        if (next.press === 'tree' && width >= 768) await panel.getByRole('button', { name: '文件树', exact: true }).click()
        await page.waitForTimeout(350)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(overflow, `${next.name} at ${width}`).toBeLessThanOrEqual(0)
        // A path gives up folders only when it really does not fit.
        const needlesslyCut = await panel.locator('.changes-path[title]').evaluateAll(paths =>
          paths.flatMap(path => {
            const shown = path.textContent
            if (!shown.startsWith('…')) return []
            path.textContent = path.getAttribute('title')
            const fits = path.scrollWidth <= path.clientWidth + 1
            path.textContent = shown
            return fits ? [shown] : []
          }),
        )
        expect(needlesslyCut, `${next.name} at ${width}`).toEqual([])
        await page.screenshot({ path: join(OUT, `${next.name}--${viewport}--${theme}.png`) })
      }
      await context.close()
    }
    expect(existsSync(join(OUT, 'list--desktop--light.png'))).toBe(true)
  } finally {
    await browser.close()
    await host.close()
  }
})
