import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Message, TaskDetail } from '@latch/protocol'
import { browserLaunchOptions } from './helpers/browser.ts'
import { recordClipboardWrites } from './helpers/clipboard.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

/**
 * The transcript under a long session and a stream, on the real worker and the real reading position, with no Host: a
 * frame is `window.showDetail`. Budgets are counts (renders, spans, coloured blocks), which load does not change.
 */

const FN = (index: number) =>
  `export function value${index}(input: string): string {\n  const answer = "text ${index}" // note\n  return answer + input\n}`
const block = (index: number) => `\`\`\`ts\n${FN(index)}\n\`\`\``
const SESSION = 'session-fixture'

function history(turns: number, blocksPerTurn = 2): Message[] {
  const messages: Message[] = []
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ id: `user-${turn}`, role: 'user', text: `问题 ${turn}` })
    messages.push({
      id: `reply-${turn}`,
      role: 'assistant',
      model: 'fixture',
      text: Array.from(
        { length: blocksPerTurn },
        (_, index) => `第 ${turn} 轮说明 ${index}\n\n${block(turn * blocksPerTurn + index)}`,
      ).join('\n\n'),
    })
  }
  return messages
}
/** Replies of plain paragraphs, as tall as `paragraphs` makes them: no code, so nothing colours and moves them later. */
function prose(turns: number, paragraphs: number, prefix = ''): Message[] {
  const messages: Message[] = []
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ id: `${prefix}user-${turn}`, role: 'user', text: `问题 ${turn}` })
    messages.push({
      id: `${prefix}reply-${turn}`,
      role: 'assistant',
      model: 'fixture',
      text: Array.from({ length: paragraphs }, (_, index) => `第 ${turn} 轮第 ${index} 段 word${turn}x${index} 说明文字。`).join('\n\n'),
    })
  }
  return messages
}
function detail(
  messages: Message[],
  options: { liveText?: string; running?: boolean; cursor?: number; liveId?: string; id?: string } = {},
): TaskDetail {
  return {
    summary: {
      id: options.id ?? SESSION,
      title: '夹具',
      status: options.running ? 'running' : 'idle',
      updatedAt: '2026-10-31T00:00:00.000Z',
    },
    messages,
    liveText: options.liveText ?? '',
    ...(options.liveId ? { liveMessageId: options.liveId } : {}),
    cursor: options.cursor ?? 1,
  } as unknown as TaskDetail
}

// React calls this hook on every commit. A fiber that rendered this commit has the PerformedWork flag; a subtree a memo
// bailed out of keeps its old child pointer and is not walked. The test also asserts the live turn counted, so a React
// that stopped reporting this would fail rather than pass with zero.
const COUNT_RENDERS = () => {
  const renders: Record<string, number> = {}
  const walk = (fiber: FiberNode | null) => {
    for (let node = fiber; node; node = node.sibling) {
      const label = node.type?.name
      if (label && node.flags & 1) renders[label] = (renders[label] ?? 0) + 1
      if (!node.alternate || node.child !== node.alternate.child) walk(node.child)
    }
  }
  interface FiberNode {
    type?: { name?: string }
    flags: number
    sibling: FiberNode | null
    child: FiberNode | null
    alternate: FiberNode | null
  }
  Object.assign(window, {
    renders,
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      isDisabled: false,
      inject: () => 1,
      onCommitFiberUnmount: () => {},
      onCommitFiberRoot: (_id: number, root: { current: FiberNode }) => {
        walk(root.current.child)
      },
      checkDCE: () => {},
    },
  })
}
declare global {
  interface Window {
    renders: Record<string, number>
    transcriptActions: string[]
    transcriptEdits: Array<{ messageId: string; before: string | undefined }>
    placedTurnKeys: string[]
  }
}

describe('streaming render', () => {
  let server: ViteDevServer, browser: Browser, page: Page

  const open = async (width = 1000, height = 900, options?: Pick<BrowserContextOptions, 'isMobile' | 'hasTouch' | 'colorScheme'>) => {
    await page?.close()
    page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', ...options })
    page.setDefaultTimeout(30_000)
    await page.addInitScript(COUNT_RENDERS)
    await page.goto(`${server.resolvedUrls!.local[0]!}test/transcript-harness.html`)
    await page.waitForFunction(() => typeof window.showDetail === 'function')
  }
  const show = (value: TaskDetail) => page.evaluate(next => window.showDetail(next), value)
  const scrollTop = (top: number) =>
    page.evaluate(value => {
      document.querySelector('.transcript')!.scrollTop = value
    }, top)

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
      // Its own: the other Vite fixtures prebundle other sets, and would make each other's runs cold.
      cacheDir: resolve('node_modules/.vite-streaming-render'),
      optimizeDeps: {
        entries: ['test/transcript-harness.tsx'],
        include: [
          '@shikijs/core',
          '@shikijs/engine-javascript',
          ...new Set((await readFile(resolve('apps/web/src/preview/highlight.worker.ts'), 'utf8')).match(/@shikijs\/langs\/[a-z]+/gu)),
        ],
      },
    })
    await server.listen()
    browser = await chromium.launch(browserLaunchOptions())
    // On a cold cache Vite finds dependencies as they load and reloads the page, which would lose a fixture mid-test.
    await open()
    for (let tries = 0; tries < 90; tries++) {
      await show(detail(history(2))).catch(() => {})
      if (
        (await page
          .locator('.syn-keyword')
          .count()
          .catch(() => 0)) > 0
      )
        return
      await new Promise(done => setTimeout(done, 1000))
    }
    throw new Error('The harness never coloured a block')
  })
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await server?.close()
  })

  it('colours the newest block of a 600-block session, only what is near the view, and the rest as they come', async () => {
    await open()
    const viewport = await page.evaluateHandle(() => {
      const counts = { lookups: 0, observed: 0, wrongRoot: 0 }
      const scrollport = document.querySelector('.transcript')
      const computedStyle = window.getComputedStyle.bind(window)
      const observe = IntersectionObserver.prototype.observe
      window.getComputedStyle = (element, pseudo) => {
        if (new Error().stack?.includes('/preview/viewportGate.ts')) counts.lookups++
        return computedStyle(element, pseudo)
      }
      IntersectionObserver.prototype.observe = function (this: IntersectionObserver, element) {
        if (element.matches('.message-code > pre')) {
          counts.observed++
          if (this.root !== scrollport) counts.wrongRoot++
        }
        return observe.call(this, element)
      }
      return counts
    })
    await show(detail(history(300)))
    const last = page.locator('.message-code').last()
    await last.locator('.syn-keyword').first().waitFor()
    const coloured = () => page.locator('.message-code:has(.syn-keyword)').count()
    // A screen and the margin around it, out of 600 blocks.
    await expect.poll(coloured).toBeGreaterThan(0)
    const near = await coloured()
    expect(near).toBeLessThan(40)
    expect(await page.locator('[class^="syn-"]').count()).toBeLessThan(40 * 60)
    for (const top of [0, 60_000, 30_000]) {
      await scrollTop(top)
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const view = document.querySelector('.transcript')!.getBoundingClientRect()
              const visible = [...document.querySelectorAll('.message-code')].filter(code => {
                const rect = code.getBoundingClientRect()
                return rect.bottom > view.top && rect.top < view.bottom
              })
              return visible.length > 0 && visible.every(code => code.querySelector('.syn-keyword'))
            }),
          { timeout: 45_000 },
        )
        .toBe(true)
    }
    expect(await coloured()).toBeLessThan(600)
    const counts = await viewport.jsonValue()
    expect(counts.observed).toBe(600)
    expect(counts.wrongRoot).toBe(0)
    expect(counts.lookups).toBe(0)
    await viewport.dispose()
  })

  it('keeps settled turns from rendering during a stream, and spans bounded as a block grows', async () => {
    await open()
    const past = history(30)
    await show(detail(past, { running: true, cursor: 0 }))
    await page.locator('.message-code').last().locator('.syn-keyword').first().waitFor()
    await page.evaluate(() => {
      for (const key of Object.keys(window.renders)) delete window.renders[key]
    })
    const frames = 40
    const stream = Array.from({ length: frames * 5 }, (_, index) => `const line${index} = ${index} // comment`)
    const liveId = 'reply-live'
    const spans: number[] = []
    for (let frame = 1; frame <= frames; frame++) {
      const liveText = `说明\n\n\`\`\`ts\n${stream.slice(0, frame * 5).join('\n')}\nconst par`
      await show(detail([...past, { id: 'user-live', role: 'user', text: '继续' }], { running: true, liveText, liveId, cursor: frame }))
      if (frame % 10 === 0) spans.push(await page.locator('.message-code.is-open [class^="syn-"]').count())
    }
    const live = page.locator('[data-message-id="reply-live"]')
    await live.locator('.message-code .syn-keyword').first().waitFor()
    const renders = await page.evaluate(() => window.renders)
    // Each frame draws the live turn and its row, and no other. The new prompt's turn is the one added, once.
    expect(renders.TurnView).toBeGreaterThanOrEqual(frames)
    expect(renders.TurnView).toBeLessThanOrEqual(frames + 2)
    expect(renders.MessageContent).toBeLessThanOrEqual(frames + 2)
    // 200 lines arrived; the tail draws 17 of them, about ten spans each.
    expect(Math.max(...spans)).toBeLessThanOrEqual(17 * 12)
    expect(await live.locator('pre code').textContent()).not.toContain('line0 ')
  })

  it('does not revisit settled history fields when only the live tail grows', async () => {
    await open()
    const past = prose(300, 1)
    const value = detail([...past, { id: 'user-live', role: 'user', text: '继续' }], {
      running: true,
      liveText: '正在回复',
      liveId: 'reply-live',
    })
    await page.evaluate(({ value, count }) => window.watchHistory(value, count), { value, count: past.length })
    const live = page.locator('[data-message-id="reply-live"]')
    await expect.poll(() => live.textContent()).toContain('正在回复')
    expect(await page.locator('[data-message-id]').count()).toBe(602)
    const first = page.locator('[data-message-id="user-0"]')
    await first.evaluate(element => element.setAttribute('data-owned-node', 'history'))
    expect(await page.evaluate(() => window.takeHistoryReads())).toBeGreaterThan(0)
    const railRenders = await page.evaluate(() => window.renders.ConversationRail)
    expect(railRenders).toBeGreaterThan(0)
    const counts: number[] = []
    for (let frame = 1; frame <= 3; frame++) {
      await page.evaluate(text => window.appendLive(text), ` 新片段${frame}`)
      await expect.poll(() => live.textContent()).toContain(`新片段${frame}`)
      counts.push(await page.evaluate(() => window.takeHistoryReads()))
    }
    expect(await first.getAttribute('data-owned-node')).toBe('history')
    expect(await page.locator('[data-message-id]').count()).toBe(602)
    expect(await page.locator('[data-message-id="reply-299"]').textContent()).toContain('word299x0')
    expect(counts, 'settled history field reads in three actual DOM commits').toEqual([0, 0, 0])
    expect(await page.evaluate(() => window.renders.ConversationRail)).toBe(railRenders)
    for (let frame = 1; frame <= 3; frame++) {
      const liveText = `旧 Host 发送完整帧 ${frame}`
      await show({ ...value, cursor: value.cursor + frame, liveText })
      await expect.poll(() => live.textContent()).toContain(liveText)
    }
    expect(await page.evaluate(() => window.renders.ConversationRail)).toBe(railRenders)
  })

  it("stands a thinking mark where the live turn's text will be, and takes it away when text arrives", async () => {
    await open()
    const past = [
      { id: 'prior', role: 'user', text: '上一条提问', turnId: 'run-prior' },
      { id: 'prior-reply', role: 'assistant', text: '上一轮已经答复' },
    ] satisfies Message[]
    const user: Message = { id: 'user-wait', role: 'user', text: '继续', turnId: 'run-wait' }
    const since = new Date(Date.now() - 12_000).toISOString()
    const preparing = detail(past, { running: true })
    preparing.summary.live = { runId: 'run-wait', activity: 'starting', since, runStartedAt: since, lastEventAt: since }
    await show(preparing)
    const old = page.locator('[data-turn="prior"]')
    await old.getByText('上一轮已经答复').waitFor()
    expect(await old.locator('.thinking-line').count()).toBe(0)
    const messages = [...past, user]
    const waitingOnModel = detail(messages, { running: true, liveId: 'reply-wait', cursor: 2 })
    waitingOnModel.summary.live = { ...preparing.summary.live, activity: 'model' }
    await show(waitingOnModel)
    const current = page.locator('[data-turn="user-wait"]')
    const status = current.locator('.thinking-line')
    await expect.poll(() => status.textContent()).toMatch(/^思考中0:1\d$/u)
    // Under the author's line, where the reply's first words will start; the author's line itself says nothing.
    const [line, word] = await Promise.all([page.locator('.assistant-meta').last().boundingBox(), status.boundingBox()])
    expect(word!.y).toBeGreaterThanOrEqual(line!.y + line!.height - 1)
    expect(word!.x).toBeLessThan(line!.x + 8)
    expect(await page.locator('.assistant-meta-status').count()).toBe(0)
    await mkdir('test-results/reply-waiting', { recursive: true })
    await page.screenshot({ path: 'test-results/reply-waiting/waiting.png', animations: 'disabled' })
    const writing = detail(messages, { running: true, liveId: 'reply-wait', liveText: '开始回答', cursor: 3 })
    writing.summary.live = waitingOnModel.summary.live
    await show(writing)
    await page.locator('[data-message-id="reply-wait"]').getByText('开始回答').waitFor()
    await expect.poll(() => status.count()).toBe(0)
    await page.screenshot({ path: 'test-results/reply-waiting/writing.png', animations: 'disabled' })
    const committed = detail([...messages, { id: 'reply-wait', role: 'assistant', text: '回复已记录' }], { running: true, cursor: 4 })
    committed.summary.live = waitingOnModel.summary.live
    await show(committed)
    await current.getByText('回复已记录').waitFor()
    expect(await page.locator('.thinking-line').count()).toBe(0)
  })

  it('keeps history settled while a new run locks and restores editing', async () => {
    await open()
    await page.evaluate(() => {
      window.transcriptEdits = []
      window.showTranscriptOptions({
        onEditFrom: (message, before) => window.transcriptEdits.push({ messageId: message.id, before }),
      })
    })
    const past = prose(300, 1)
    await show(detail(past))
    const oldPrompt = page.locator('[data-message-id="user-298"]')
    const edit = oldPrompt.getByRole('button', { name: '从这里编辑', exact: true })
    await edit.waitFor()
    expect(await edit.isEnabled()).toBe(true)
    const countTurns = () => page.evaluate(() => window.renders.TurnView ?? 0)
    const user: Message = { id: 'user-live', role: 'user', text: '继续' }
    const before = await countTurns()
    await show(detail([...past, user], { running: true, liveId: 'reply-live', liveText: '开始', cursor: 2 }))
    const reply = page.locator('[data-message-id="reply-live"]')
    await reply.waitFor()
    expect(await edit.isDisabled()).toBe(true)
    expect(await page.evaluate(() => window.transcriptEdits)).toEqual([])
    const running = await countTurns()
    expect(running - before).toBeLessThanOrEqual(6)

    await show(detail([...past, user, { id: 'reply-live', role: 'assistant', text: '完成' }], { cursor: 3 }))
    await expect.poll(() => reply.textContent()).toContain('完成')
    await expect.poll(() => edit.isEnabled()).toBe(true)
    expect((await countTurns()) - running).toBeLessThanOrEqual(6)
    await oldPrompt.hover()
    await edit.click()
    expect(await page.evaluate(() => window.transcriptEdits)).toEqual([{ messageId: 'user-298', before: 'reply-297' }])
  })

  it.each([2, 23])('keeps the old tail DOM, work expansion and text selection after %i earlier turns', async rounds => {
    await open()
    // The second case starts a new group when the old tail becomes history.
    const past = prose(rounds, 1)
    const current: Message[] = [
      ...past,
      { id: 'user-tail', role: 'user', text: '尾轮问题' },
      {
        id: 'tool:tail',
        role: 'tool',
        text: 'done',
        toolName: 'execute',
        state: 'completed',
        tool: { kind: 'execute', input: '{"command":"echo done"}' },
      },
      { id: 'reply-tail', role: 'assistant', text: '保留这段选择', state: 'completed' },
    ]
    await show(detail(current))
    const turn = page.locator('[data-turn="user-tail"]')
    const fold = turn.locator('button.work-fold')
    await fold.click()
    expect(await fold.getAttribute('aria-expanded')).toBe('true')
    await page.locator('[data-message-id="reply-tail"]').evaluate(element => {
      element.setAttribute('data-owned-node', 'tail')
      const range = document.createRange()
      range.selectNodeContents(element.querySelector('.message-content')!)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    const selected = await page.evaluate(() => document.getSelection()?.toString())
    expect(selected).toContain('保留这段选择')
    const next: Message[] = [...current, { id: 'next-user', role: 'user', text: '继续' }]
    const live = { running: true, liveId: 'next-reply', liveText: '新轮回复' }
    await show(detail(next, live))
    await expect.poll(() => page.locator('[data-message-id="next-reply"]').textContent()).toContain('新轮回复')
    expect(await page.locator('[data-message-id="reply-tail"]').getAttribute('data-owned-node')).toBe('tail')
    expect(await fold.getAttribute('aria-expanded')).toBe('true')
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected)

    await show(detail([...prose(1, 1, 'earlier-'), ...next], { ...live, cursor: 2 }))
    await expect.poll(() => page.locator('[data-message-id]').first().getAttribute('data-message-id')).toBe('earlier-user-0')
    expect(await page.locator('[data-message-id="reply-tail"]').getAttribute('data-owned-node')).toBe('tail')
    expect(await fold.getAttribute('aria-expanded')).toBe('true')
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected)
  })

  it('invalidates shared history display and new props while actions read their latest callback', async () => {
    await open()
    const past = prose(2, 1)
    const value = detail([...past, { id: 'user-live', role: 'user', text: '继续' }], {
      running: true,
      liveId: 'reply-live',
      liveText: '新轮',
    })
    await page.evaluate(({ value, count }) => window.watchHistory(value, count), { value, count: past.length })
    const first = page.locator('[data-turn="user-0"]')
    await first.locator('.assistant-meta').waitFor()
    await page.evaluate(() => {
      window.transcriptActions = []
      window.showTranscriptOptions({ harnessName: '更新的执行端', onFork: id => window.transcriptActions.push(`old:${id}`) })
    })
    await expect.poll(() => first.locator('.assistant-meta').textContent()).toContain('更新的执行端')
    const fork = first.getByRole('button', { name: '从这里分叉', exact: true })
    await fork.waitFor()
    await page.evaluate(() =>
      window.showTranscriptOptions({ harnessName: '更新的执行端', onFork: id => window.transcriptActions.push(`new:${id}`) }),
    )
    await first.hover()
    await fork.click()
    expect(await page.evaluate(() => window.transcriptActions)).toEqual(['new:reply-0'])
    await page.evaluate(() => window.showTranscriptOptions({ harnessName: '更新的执行端', speaker: { name: '小雨', avatar: 'general' } }))
    await expect.poll(() => first.locator('.assistant-meta').textContent()).toBe('小雨')
    expect(await fork.count()).toBe(0)
    expect(await first.locator('.assistant-meta-model').count()).toBe(0)
    await page.evaluate(() => window.showTranscriptOptions({ harnessName: '更新的执行端' }))
    await expect.poll(() => first.locator('.assistant-meta').textContent()).toContain('fixture')
    await page.evaluate(() => window.takeHistoryReads())
    const before = await page.evaluate(() => window.renders.Transcript ?? 0)
    await page.evaluate(() => {
      const next = { harnessName: '更新的执行端', futureDisplay: { revision: 1 } }
      window.showTranscriptOptions(next)
    })
    await expect.poll(() => page.evaluate(() => window.renders.Transcript ?? 0)).toBeGreaterThan(before)
    expect(await page.evaluate(() => window.takeHistoryReads())).toBeGreaterThan(0)
    await page.evaluate(() =>
      window.showTranscriptOptions({
        harnessName: '更新的执行端',
        coarse: true,
        frozenAt: Date.now(),
        changes: { enabled: false, undo: 'read-only', offline: true },
      }),
    )
    await expect.poll(() => page.locator('.status-line').count()).toBe(0)
    expect(await page.evaluate(() => window.takeHistoryReads())).toBeGreaterThan(0)
    expect(await fork.count()).toBe(0)
  })

  it('updates historical approval and question rows without replacing the message list', async () => {
    await open()
    const messages: Message[] = [
      { id: 'old-user', role: 'user', text: '先前问题' },
      { id: 'tool:approval', role: 'tool', toolName: 'write_file', text: '', state: 'awaiting-approval' },
      { id: 'tool:question', role: 'tool', toolName: 'ask_user', text: '等待选择', state: 'awaiting-approval' },
      { id: 'next-user', role: 'user', text: '继续' },
    ]
    await show(detail(messages, { running: true, liveId: 'next-reply', liveText: '新轮' }))
    const row = page.locator('[data-message-id="tool:approval"]')
    await row.waitFor()
    await page.evaluate(() =>
      window.showTranscriptOptions({
        approvals: [
          {
            id: 'approval',
            sessionId: 'session-fixture',
            toolCallId: 'approval',
            toolName: 'write_file',
            arguments: '{}',
            requestedAt: '2026-10-31T00:00:00.000Z',
            reason: '需要确认',
            tool: { toolTitle: '更新的待批准工具' },
          },
        ],
      }),
    )
    await expect.poll(() => row.textContent()).toContain('更新的待批准工具')
    await page.evaluate(() => window.showTranscriptOptions({ approvals: [] }))
    await expect.poll(() => row.textContent()).not.toContain('更新的待批准工具')
    const question = page.locator('[data-message-id="tool:question"]')
    expect(await question.count()).toBe(1)
    await page.evaluate(() =>
      window.patchDetail({
        questions: [
          {
            id: 'question',
            toolCallId: 'question',
            prompt: '现在选择',
            state: 'pending',
            questions: [],
          },
        ],
      }),
    )
    await expect.poll(() => question.count()).toBe(0)
    await page.evaluate(() => window.patchDetail({ questions: [] }))
    await expect.poll(() => question.count()).toBe(1)
  })

  it('refreshes historical file records and withdraws their actions when access changes', async () => {
    await open()
    let files = 1
    let recordReads = 0
    await page.route('**/api/tasks/**/changes/turns', route => {
      recordReads++
      return route.fulfill({ json: { turns: [{ turnId: 'old-run', startedAt: '2026-10-31T00:00:00.000Z', state: 'settled', files }] } })
    })
    await page.route('**/api/tasks/**/changes?**', route =>
      route.fulfill({
        json: {
          scope: 'turn',
          turnId: 'old-run',
          files: Array.from({ length: files }, (_, index) => ({ root: 'root', path: `file-${index}.txt`, status: 'A', add: 1, del: 0 })),
          totals: { files, add: files, del: 0 },
          undo: { available: true },
        },
      }),
    )
    await page.evaluate(() => window.showTranscriptOptions({ changes: { enabled: true, undo: 'open', offline: false } }))
    const messages: Message[] = [
      { id: 'old-user', role: 'user', text: '先前问题', createdAt: '2026-10-31T00:00:00.000Z' },
      { id: 'old-answer', role: 'assistant', text: '已有结果' },
      { id: 'new-user', role: 'user', text: '新问题', createdAt: '2026-10-31T01:00:00.000Z' },
      { id: 'new-answer', role: 'assistant', text: '新结果' },
    ]
    await show(detail(messages))
    const card = page.locator('[data-turn="old-user"]').getByRole('region', { name: '这一轮改动的文件' })
    await expect.poll(() => card.textContent()).toContain('改动了 1 个文件')
    files = 2
    await page.evaluate(() => window.refreshTurnRecords())
    await expect.poll(() => recordReads).toBeGreaterThan(1)
    await expect.poll(() => card.textContent()).toContain('改动了 2 个文件')
    const undo = card.getByRole('button', { name: '撤销本轮', exact: true })
    expect(await undo.count()).toBe(1)
    await page.evaluate(() => window.showTranscriptOptions({ changes: { enabled: true, undo: 'read-only', offline: false } }))
    await expect.poll(() => undo.count()).toBe(0)
    // Read-only is explained at the composer; the historical card withdraws the action without inventing another reason.
    await page.evaluate(() => window.showTranscriptOptions({ changes: { enabled: false, undo: 'read-only', offline: true } }))
    await expect.poll(() => card.count()).toBe(0)
  })

  it('keeps a synthetic leading reply indexed for placed content and its final file record', async () => {
    await open()
    await page.route('**/api/tasks/**/changes/turns', route =>
      route.fulfill({
        json: {
          turns: [
            {
              turnId: 'lead-run',
              startedAt: '2026-10-31T00:00:00.000Z',
              state: 'settled',
              files: 1,
            },
          ],
        },
      }),
    )
    await page.route('**/api/tasks/**/changes?**', route =>
      route.fulfill({
        json: {
          scope: 'turn',
          turnId: 'lead-run',
          files: [{ root: 'root', path: 'result.txt', status: 'A', add: 1, del: 0 }],
          totals: { files: 1, add: 1, del: 0 },
          undo: { available: true },
        },
      }),
    )
    await page.evaluate(() =>
      window.showTranscriptOptions({
        changes: { enabled: true, undo: 'open', offline: false },
        placed: turns => {
          window.placedTurnKeys = turns.map(turn => turn.key)
          return new Map()
        },
      }),
    )
    const initial = detail([], { liveId: 'lead-reply', liveText: '未提交的末段' })
    initial.summary.runId = 'lead-run'
    await show(initial)
    const row = page.locator('[data-message-id="lead-reply"]')
    await row.waitFor()
    expect(await page.evaluate(() => window.placedTurnKeys)).toEqual(['lead:lead-reply'])
    await row.evaluate(element => element.setAttribute('data-owned-node', 'lead'))
    await expect.poll(() => page.getByRole('region', { name: '这一轮改动的文件' }).textContent()).toContain('改动了 1 个文件')
    await show({ ...initial, messages: [{ id: 'lead-reply', role: 'assistant', text: '未提交的末段', state: 'completed' }], liveText: '' })
    await expect.poll(() => row.getAttribute('data-owned-node')).toBe('lead')
    expect(await page.evaluate(() => window.placedTurnKeys)).toEqual(['lead:lead-reply'])
  })

  it('rechecks a committed historical live ID when text appears and is cleared', async () => {
    await open()
    const past = prose(2, 1)
    const value = detail([...past, { id: 'current-user', role: 'user', text: '继续' }], { running: true, liveId: 'reply-0' })
    await page.evaluate(({ value, count }) => window.watchHistory(value, count), { value, count: past.length })
    const row = page.locator('[data-message-id="reply-0"]')
    await row.waitFor()
    expect(await row.getAttribute('class')).not.toContain('is-live')
    await page.evaluate(() => window.patchDetail({ liveText: 'legacy live fragment' }))
    await expect.poll(() => row.getAttribute('class')).toContain('is-live')
    await page.evaluate(() => window.patchDetail({ liveText: '' }))
    await expect.poll(() => row.getAttribute('class')).not.toContain('is-live')
    expect(await row.textContent()).toContain('word0x0')
    expect(await page.locator('[data-message-id="reply-0"]').count()).toBe(1)
  })

  it('displays a sent terminal excerpt as literal diagnostics and copies the full original message', async () => {
    const fence = '`'.repeat(3)
    const label = '终端 1 · 最近报错'
    const notes = '（较早的输出未包含）'
    const diagnostic = 'TypeError: Cannot read properties of undefined'
    const stack = '    at render (src/views/ConversationPanel.tsx:83:17)'
    const literal = '<img src=x onerror=alert(1)>'
    const body = [diagnostic, stack, literal, '[引用回复 session-fixture/answer@0]', '> log output'].join('\n')
    const text = ['帮我看一下这个错误', label + notes, fence + 'text', body, fence, '只改出错的地方'].join('\n')
    await open()
    await show(detail([{ id: 'user-terminal', role: 'user', text }]))
    const row = page.locator('[data-message-id="user-terminal"]')
    const card = row.locator('figure')
    await card.waitFor()
    expect(await card.locator('figcaption').innerText()).toContain(label)
    expect(await card.locator('small').innerText()).toBe(notes)
    expect(await card.locator('pre').textContent()).toBe(body)
    expect(await card.locator('pre img, pre a, pre button, .user-reply-quote').count()).toBe(0)
    expect(await row.locator('.user-bubble-text').innerText()).not.toContain(fence)
    expect(await card.locator('.sent-terminal-stack').innerText()).toBe(stack)
    const copied = await recordClipboardWrites(page)
    await row.hover()
    await row.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(copied).toEqual([text])
    const visible = [diagnostic, stack, '    at update (src/ui.ts:12:5)'].join('\n')
    await open()
    await show(detail([{ id: 'user-terminal', role: 'user', text: text.replace(body, visible) }]))
    const preview = page.locator('[data-message-id="user-terminal"] figure')
    await preview.waitFor()
    expect(await preview.locator('pre').textContent()).toBe(visible)
    await mkdir('test-results/sent-terminal', { recursive: true })
    for (const [width, colorScheme] of [
      [390, 'dark'],
      [820, 'light'],
      [1440, 'light'],
    ] as const) {
      await page.setViewportSize({ width, height: 820 })
      await page.emulateMedia({ colorScheme })
      expect(await preview.evaluate(el => el.getBoundingClientRect().right <= innerWidth)).toBe(true)
      expect(await preview.locator('pre').evaluate(el => getComputedStyle(el).overflowX)).toBe('auto')
      if (width === 390) expect(await preview.locator('pre').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.screenshot({ path: `test-results/sent-terminal/${width}-${colorScheme}.png`, animations: 'disabled' })
    }
  })

  it('wraps a highlighted URL in a sent message and renders quoted bold in the reply', async () => {
    const url = 'https://review.example.org/regression/sets/00000000-1111-4222-8333-444444444444'
    const prompt = `请用 ${url} 重新评估界面。`
    const quote = '“界面规整，但交互仍需调整”'
    const turn = detail([
      { id: 'user-url', role: 'user', text: prompt },
      { id: 'reply-quote', role: 'assistant', text: `这次评估呈现出明显的**${quote}**的特征。` },
    ])
    await mkdir('test-results/message-links', { recursive: true })
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1440, 900],
    ] as const) {
      await open(width, height, { isMobile: width < 1000, hasTouch: width < 1000 })
      await show(turn)
      const bubble = page.locator('.user-bubble-text')
      const link = bubble.getByRole('link', { name: url, exact: true })
      const reply = page.locator('[data-message-id="reply-quote"] .message-content')
      expect(await link.getAttribute('href')).toBe(url)
      expect(await bubble.innerText()).toBe(prompt)
      expect(await reply.locator('strong').innerText()).toBe(quote)
      expect(await reply.innerText()).not.toContain('**')
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.evaluate(() => document.fonts.ready)
        expect(await link.evaluate(element => getComputedStyle(element).textDecorationLine)).toBe('underline')
        await noHorizontalOverflow(page, bubble)
        if (width === 390) expect(await link.evaluate(element => element.getClientRects().length)).toBeGreaterThan(1)
        await page.screenshot({ path: `test-results/message-links/${width}-${colorScheme}.png`, animations: 'disabled' })
      }
    }
  })

  it('copies the current raw Markdown during streaming and retains the same reply and copy control when it settles', async () => {
    await open(390)
    const user: Message = { id: 'user-copy', role: 'user', text: '写一个重点' }
    const text = '说明：**未闭合重点'
    await show(detail([user], { running: true, liveText: text, liveId: 'reply-copy', cursor: 1 }))
    const reply = page.locator('[data-message-id="reply-copy"]')
    await reply.locator('strong').waitFor()
    await reply.evaluate(element => element.setAttribute('data-owned-node', 'reply'))
    const copied = await recordClipboardWrites(page)
    const copy = page.locator('.turn-footer').getByRole('button', { name: '复制', exact: true })
    expect(await copy.count()).toBe(1)
    expect(await page.locator('.turn-footer .turn-facts').count()).toBe(0)
    expect(await page.locator('.turn-footer button:not(.ui-copy-button)').count()).toBe(0)
    await reply.click()
    await copy.click()
    await expect.poll(copied).toEqual([text])
    await copy.evaluate(element => element.setAttribute('data-owned-node', 'copy'))
    const next = text + '继续到达'
    await show(detail([user], { running: true, liveText: next, liveId: 'reply-copy', cursor: 2 }))
    await reply.getByText('未闭合重点继续到达', { exact: true }).waitFor()
    await copy.click()
    await expect.poll(copied).toEqual([text, next])
    expect(await copy.getAttribute('data-owned-node')).toBe('copy')
    await mkdir('test-results/stream-copy', { recursive: true })
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await reply.hover()
        await copy.click({ trial: true })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `test-results/stream-copy/live-${width}-${colorScheme}.png`, animations: 'disabled' })
      }
    }
    await show(detail([user, { id: 'reply-copy', role: 'assistant', text: next }], { cursor: 3 }))
    await expect.poll(() => reply.locator('.message-content').getAttribute('aria-busy')).toBe(null)
    expect(await reply.getAttribute('data-owned-node')).toBe('reply')
    expect(await reply.innerText()).toContain('**未闭合重点')
    expect(await copy.getAttribute('data-owned-node')).toBe('copy')
    await reply.click()
    await copy.click()
    await expect.poll(copied).toEqual([text, next, next])
  })

  it('does not rerender completed Markdown blocks while only the live tail changes', async () => {
    await open()
    const user: Message = { id: 'user-blocks', role: 'user', text: '写一段说明' }
    const prefix = '```ts\nconst fixed = 1\n```\n\n'
    await show(detail([user], { running: true, liveText: prefix + '尾部', liveId: 'reply-blocks', cursor: 1 }))
    // Initial viewport activation renders the code block once, independently of live updates.
    await page.locator('[data-message-id="reply-blocks"] .syn-keyword', { hasText: 'const' }).waitFor()
    await page.evaluate(() => {
      for (const key of Object.keys(window.renders)) delete window.renders[key]
    })
    for (let frame = 2; frame <= 12; frame++) {
      await show(detail([user], { running: true, liveText: prefix + '尾部'.repeat(frame), liveId: 'reply-blocks', cursor: frame }))
      await expect.poll(() => page.locator('.message-content p').last().textContent()).toBe('尾部'.repeat(frame))
    }
    const renders = await page.evaluate(() => window.renders)
    expect(renders.MessageContent).toBeGreaterThanOrEqual(11)
    expect(renders.ClosedCode ?? 0).toBe(0)
    expect(renders.CodeBlock ?? 0).toBe(0)
  })

  it('shows the tail of an open fence, its finished lines coloured, its unfinished line plain, without moving when it closes', async () => {
    await open()
    const liveId = 'reply-live'
    const user: Message = { id: 'user-live', role: 'user', text: '写代码' }
    const lines = Array.from({ length: 40 }, (_, index) => `const line${index} = ${index}`)
    await show(detail([user], { running: true, liveText: `\`\`\`ts\n${lines.slice(0, 3).join('\n')}`, liveId, cursor: 1 }))
    const code = page.locator(`[data-message-id="${liveId}"] .message-code`)
    // Short: everything is there; the last line may still change, so it stays plain.
    await code.locator('.syn-keyword', { hasText: 'const' }).nth(1).waitFor()
    expect(await code.locator('.syn-keyword', { hasText: 'const' }).count()).toBe(2)
    const box = code.locator('.message-code-tail-note')
    expect(await box.count()).toBe(0)
    await show(detail([user], { running: true, liveText: `\`\`\`ts\n${lines.slice(0, 18).join('\n')}`, liveId, cursor: 2 }))
    await show(detail([user], { running: true, liveText: `\`\`\`ts\n${lines.join('\n')}`, liveId, cursor: 3 }))
    await expect.poll(() => box.textContent()).toBe('前 23 行已收起')
    await code.locator('.syn-keyword', { hasText: 'const' }).nth(15).waitFor()
    const shown = (await code.locator('pre code').textContent())!
    expect(shown.startsWith('const line23 = 23\n')).toBe(true)
    expect(shown.trimEnd().endsWith('const line39 = 39')).toBe(true)
    expect(await code.getByRole('button', { name: '展开全部 40 行', exact: true }).count()).toBe(1)
    // The last line is visible, with no scroll position written.
    const visible = await code.locator('pre').evaluate(pre => ({ top: pre.scrollTop, overflow: pre.scrollHeight - pre.clientHeight }))
    expect(visible.top).toBe(0)
    expect(visible.overflow).toBeLessThanOrEqual(0)
    const height = await code.evaluate(element => element.getBoundingClientRect().height)
    await show(detail([user], { running: true, liveText: `\`\`\`ts\n${lines.join('\n')}\n\`\`\`\n`, liveId, cursor: 4 }))
    await expect.poll(() => box.count()).toBe(0)
    expect(await code.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
    expect((await code.locator('pre code').textContent())!.startsWith('const line0 = 0\n')).toBe(true)
    await code.locator('.syn-keyword', { hasText: 'const' }).first().waitFor()
    // Colours reach the first lines shown, not all forty.
    expect(await code.locator('.syn-keyword', { hasText: 'const' }).count()).toBeLessThanOrEqual(19)
  })

  it('keeps a finished line’s DOM nodes as more arrive and when the block closes, and the reply’s ID throughout', async () => {
    await open()
    const liveId = 'reply-live'
    const user: Message = { id: 'user-live', role: 'user', text: '写代码' }
    const text = (count: number, close = '') =>
      `\`\`\`ts\n${Array.from({ length: count }, (_, index) => `const line${index} = ${index}`).join('\n')}${close}`
    await show(detail([user], { running: true, liveText: text(4), liveId, cursor: 1 }))
    const code = page.locator(`[data-message-id="${liveId}"] pre code`)
    await code.locator('.syn-keyword').nth(2).waitFor()
    const first = await code.locator('.syn-keyword').first().elementHandle()
    const row = await page.locator(`[data-message-id="${liveId}"]`).elementHandle()
    await show(detail([user], { running: true, liveText: text(8), liveId, cursor: 2 }))
    await code.locator('.syn-keyword').nth(6).waitFor()
    expect(await first!.evaluate(element => element.isConnected)).toBe(true)
    await show(detail([user, { id: liveId, role: 'assistant', text: text(8, '\n```\n') }], { cursor: 3 }))
    await code.locator('.syn-keyword').nth(7).waitFor()
    await page.waitForTimeout(50)
    expect(await first!.evaluate(element => element.isConnected)).toBe(true)
    expect(await row!.evaluate(element => element.isConnected)).toBe(true)
  })

  it('reads a block spanning grammar state across lines, as the whole block would', async () => {
    await open()
    const liveId = 'reply-live'
    const user: Message = { id: 'user-live', role: 'user', text: '写代码' }
    await show(
      detail([user], { running: true, liveText: '```ts\n/* opened\nstill a comment\n*/ const after = 1\nconst tail', liveId, cursor: 1 }),
    )
    const code = page.locator(`[data-message-id="${liveId}"] pre code`)
    await code.locator('.syn-keyword', { hasText: 'const' }).first().waitFor()
    expect(await code.locator('.syn-comment').allTextContents()).toEqual(
      expect.arrayContaining([expect.stringContaining('still a comment')]),
    )
    expect(await code.locator('.syn-keyword', { hasText: 'still' }).count()).toBe(0)
  })

  it('colours past a Python docstring and through a shell pipe', async () => {
    await open()
    const python = '```python\ndef f(x):\n    """doc"""\n    return x + 1\n```'
    const shell = '```bash\necho "x" | grep y\n```'
    await show(
      detail([
        { id: 'u', role: 'user', text: '代码' },
        { id: 'a', role: 'assistant', text: `${python}\n\n${shell}` },
      ]),
    )
    const blocks = page.locator('.message-code')
    await blocks.nth(0).locator('.syn-keyword', { hasText: 'return' }).waitFor()
    expect(await blocks.nth(0).locator('.syn-comment').allTextContents()).toEqual(['"""doc"""'])
    await blocks.nth(1).locator('.syn-string', { hasText: '"x"' }).waitFor()
    await blocks.nth(1).locator('.syn-keyword', { hasText: '|' }).waitFor()
  })

  it('colours a CRLF fence, the shell and console labels, and both sides of a diff', async () => {
    await open()
    await show(
      detail([
        { id: 'u', role: 'user', text: '代码' },
        {
          id: 'a',
          role: 'assistant',
          text: [
            '```ts\r\nconst a = 1\r\nconst b = 2\r\n```',
            '```shell\necho "x"\n```',
            '```console\necho "y"\n```',
            '```diff\n+added\n-removed\n```',
          ].join('\n\n'),
        },
      ]),
    )
    const blocks = page.locator('.message-code')
    await blocks.nth(0).locator('.syn-keyword', { hasText: 'const' }).first().waitFor()
    expect(await blocks.nth(0).locator('code').textContent()).toContain('const a = 1\nconst b = 2')
    await blocks.nth(1).locator('.syn-string', { hasText: '"x"' }).waitFor()
    await blocks.nth(2).locator('.syn-string', { hasText: '"y"' }).waitFor()
    await blocks.nth(3).locator('.syn-string', { hasText: 'added' }).waitFor()
    await blocks.nth(3).locator('.syn-constant', { hasText: 'removed' }).waitFor()
  })

  it.each([
    [320, 700],
    [768, 1024],
    [1440, 900],
  ])('lets a long code line be read to its end at %dpx, and the page stays in place', async (width, height) => {
    await open(width, height)
    const long = `const ${'veryLongIdentifier'.repeat(20)}_END = 1`
    await show(
      detail([
        { id: 'u', role: 'user', text: '长行' },
        { id: 'a', role: 'assistant', text: `\`\`\`ts\n${long}\n\`\`\`\n\n行内 \`${long}\`` },
      ]),
    )
    const pre = page.locator('.message-code pre')
    await pre.locator('.syn-keyword').first().waitFor()
    const measured = await pre.evaluate(element => {
      const style = getComputedStyle(element)
      const before = {
        client: element.clientWidth,
        scroll: element.scrollWidth,
        overflow: style.overflowX,
        hint: style.backgroundAttachment,
      }
      element.scrollLeft = element.scrollWidth
      const range = document.createRange()
      range.selectNodeContents(element.querySelector('code')!)
      const text = range.getBoundingClientRect(),
        box = element.getBoundingClientRect()
      return {
        ...before,
        left: element.scrollLeft,
        endInView: text.right <= box.right + 1 && text.right > box.left,
        tabIndex: element.tabIndex,
      }
    })
    expect(measured.overflow).toBe('auto')
    expect(measured.hint).toContain('local')
    expect(measured.scroll).toBeGreaterThan(measured.client)
    expect(measured.left).toBeGreaterThan(0)
    expect(measured.endInView).toBe(true)
    expect(measured.tabIndex).toBe(0)
    const page_ = await page.evaluate(() => {
      const transcript = document.querySelector('.transcript')!
      return { doc: document.documentElement.scrollWidth - window.innerWidth, transcript: transcript.scrollWidth - transcript.clientWidth }
    })
    expect(page_.doc).toBeLessThanOrEqual(0)
    expect(page_.transcript).toBeLessThanOrEqual(0)
  })

  it('finds text across coloured tokens and in blocks not coloured yet, and keeps the match when a block colours', async () => {
    await open()
    await show(detail(history(120)))
    await page.locator('.message-code').last().locator('.syn-keyword').first().waitFor()
    await page.evaluate(() => window.openFind())
    await page.getByRole('searchbox').fill('value3(input')
    // Spans three tokens once coloured, in a block far above the view.
    await expect.poll(() => page.getByRole('search').getByRole('status').textContent()).toBe('1/1')
    await page.locator('[data-message-id="reply-1"] .message-code .syn-keyword').first().waitFor()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const current = CSS.highlights.get('latch-find-current')
          const range = current ? ([...current.values()][0] as Range | undefined) : undefined
          return range && !range.collapsed ? range.toString() : ''
        }),
      )
      .toBe('value3(input')
    const inView = await page.evaluate(() => {
      const code = document.querySelector('[data-message-id="reply-1"]')!.getBoundingClientRect(),
        view = document.querySelector('.transcript')!.getBoundingClientRect()
      return code.bottom > view.top && code.top < view.bottom
    })
    expect(inView).toBe(true)
  })

  it.each(['preview', 'expanded'])('scrolls the conversation past either edge of a tool output (%s)', async mode => {
    await open()
    const output = Array.from({ length: 80 }, (_, line) => `match ${line}`).join('\n')
    await show(
      detail([
        ...prose(1, 20),
        { id: 'search', role: 'user', text: '搜索文件' },
        { id: 'result', role: 'tool', state: 'completed', toolName: 'rg', text: output, tool: { kind: 'search', output } },
        ...prose(1, 20, 'later-'),
      ]),
    )
    await page.evaluate(() => window.revealMessage('search'))
    const row = page.locator('[data-message-id="result"]')
    await row.locator('.tool-card-header').click()
    if (mode === 'expanded') await row.getByRole('button', { name: /展开全部/u }).click()
    const box = row.locator('.tool-output-scroll')
    const chatTop = () => page.locator('.transcript').evaluate(element => element.scrollTop)
    await box.hover()
    const before = await chatTop()
    await page.mouse.wheel(0, -60)
    await expect.poll(chatTop).toBeLessThan(before)

    await box.hover()
    const reading = await chatTop()
    const extent = await box.evaluate(element => element.scrollHeight - element.clientHeight)
    expect(extent).toBeGreaterThan(60)
    await page.mouse.wheel(0, extent)
    await expect.poll(() => box.evaluate(element => element.scrollTop)).toBeCloseTo(extent, 0)
    expect(await chatTop()).toBe(reading)
    await page.mouse.wheel(0, 60)
    await expect.poll(chatTop).toBeGreaterThan(reading)
  })

  it('keeps a match in a tool output current when a block colours', async () => {
    await open()
    await show(
      detail([
        ...history(40),
        { id: 'user-tool', role: 'user', text: '读取' },
        { id: 'tool', role: 'tool', text: 'the needle here', toolName: 'read_file', state: 'completed' },
        { id: 'reply-tool', role: 'assistant', model: 'fixture', text: '完成' },
      ]),
    )
    await page.locator('.message-code').last().locator('.syn-keyword').first().waitFor()
    await page.evaluate(() => window.openFind())
    await page.getByRole('searchbox').fill('needle')
    const current = () =>
      page.evaluate(() => {
        const highlight = CSS.highlights.get('latch-find-current')
        return highlight ? [...highlight.values()].map(range => (range as Range).toString()) : []
      })
    await expect.poll(current).toEqual(['needle'])
    await page.locator('.transcript').hover()
    await page.mouse.wheel(0, -100_000)
    await page.locator('.message-code').first().locator('.syn-keyword').first().waitFor()
    await page.waitForTimeout(200)
    expect(await current()).toEqual(['needle'])
  })

  it('finds the lines a plain open block brings back when expanded', async () => {
    await open()
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
    await show(
      detail([{ id: 'u', role: 'user', text: '继续' }], {
        running: true,
        liveId: 'a',
        liveText: `\`\`\`text\nhiddenword\n${lines}\nmore`,
      }),
    )
    await page.getByRole('button', { name: /展开全部/u }).waitFor()
    await page.evaluate(() => window.openFind())
    const status = page.getByRole('search').getByRole('status')
    await page.getByRole('searchbox').fill('hiddenword')
    await expect.poll(() => status.textContent()).toBe('0/0')
    await page.getByRole('button', { name: /展开全部/u }).click()
    await expect.poll(() => status.textContent()).toBe('1/1')
  })

  it('follows each observed growth of the live reply before paint', async () => {
    await open(390, 844)
    await show(
      detail([...prose(30, 5), { id: 'user-live', role: 'user', text: '继续' }], {
        running: true,
        liveText: '正在回复',
        liveId: 'reply-live',
      }),
    )
    const transcript = page.locator('.transcript')
    await expect
      .poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(2)
    const paintGaps = await transcript.evaluate(
      element =>
        new Promise<number[]>(done => {
          const content = element.querySelector('.transcript-content')!
          let extent = element.scrollHeight
          const gaps: number[] = []
          const grow = () => window.appendLive(`\n\n第 ${gaps.length + 1} 段回复增加两行。先看已有证据，再把差异说清楚。`)
          const finished = () => {
            clearTimeout(timeout)
            observer.disconnect()
            done(gaps)
          }
          // The hook already observes this box. Sample each actual resize in the same notification, before the next paint.
          const observer = new ResizeObserver(() => {
            const next = element.scrollHeight
            if (next === extent) return
            extent = next
            gaps.push(next - element.clientHeight - element.scrollTop)
            if (gaps.length >= 6) finished()
            else requestAnimationFrame(grow)
          })
          const timeout = setTimeout(finished, 5000)
          observer.observe(content, { box: 'border-box' })
          requestAnimationFrame(grow)
        }),
    )
    expect(paintGaps).toHaveLength(6)
    expect(Math.max(...paintGaps.map(Math.abs))).toBeLessThanOrEqual(2)
  })

  it('keeps following the conversation while scrolling within live tool output', async () => {
    await open()
    const output = 'still running\n'.repeat(80)
    await show(
      detail(
        [
          ...prose(8, 5),
          { id: 'user-live', role: 'user', text: '运行命令' },
          {
            id: 'tool-live',
            role: 'tool',
            state: 'running',
            text: '',
            toolName: 'execute',
            tool: { kind: 'execute', input: '{"command":"run"}', output },
          },
        ],
        { running: true },
      ),
    )
    await page.locator('[data-message-id="tool-live"] .tool-card-header').click()
    const box = page.locator('.tool-output-scroll.is-live')
    const latest = page.getByRole('button', { name: /回到最新/u })
    await box.hover()
    await page.mouse.wheel(0, -100)
    await expect.poll(() => box.evaluate(element => element.scrollTop)).toBeLessThan(0)
    expect(await latest.isVisible()).toBe(false)

    await box.evaluate(element => {
      element.scrollTop = -element.scrollHeight
    })
    await page.mouse.wheel(0, -100)
    await latest.waitFor()
  })

  it('holds the reader’s place above a stream, and jumps back to the latest', async () => {
    await open()
    const past = history(30)
    const liveId = 'reply-live'
    await show(detail(past, { running: true, cursor: 0 }))
    await page.locator('.message-code').last().waitFor()
    const transcript = page.locator('.transcript')
    await transcript.hover()
    await page.mouse.wheel(0, -2000)
    await page.getByRole('button', { name: /回到最新/u }).waitFor()
    const anchor = page.locator('[data-message-id="reply-27"]')
    const before = await anchor.evaluate(element => element.getBoundingClientRect().top)
    await page.waitForTimeout(300)
    for (let frame = 1; frame <= 20; frame++) {
      const liveText = `\`\`\`ts\n${Array.from({ length: frame * 3 }, (_, index) => `const line${index} = ${index}`).join('\n')}\nconst x`
      await show(detail([...past, { id: 'user-live', role: 'user', text: '继续' }], { running: true, liveText, liveId, cursor: frame }))
    }
    const after = await anchor.evaluate(element => element.getBoundingClientRect().top)
    expect(Math.abs(after - before)).toBeLessThan(400)
    const settled = await anchor.evaluate(element => element.getBoundingClientRect().top)
    await show(detail([...past, { id: 'user-live', role: 'user', text: '继续' }], { running: true, liveText: '`x`', liveId, cursor: 21 }))
    expect(Math.abs((await anchor.evaluate(element => element.getBoundingClientRect().top)) - settled)).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: /回到最新/u }).click()
    await expect
      .poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(2)
  })

  const turnOffset = (id: string) =>
    page.locator(`[data-message-id="${id}"]`).evaluate(element => {
      const view = document.querySelector('.transcript')!.getBoundingClientRect()
      return element.getBoundingClientRect().top - view.top
    })
  const markerInView = (marker: Locator) =>
    marker.evaluate(element => {
      const row = element.getBoundingClientRect()
      const track = element.parentElement!.getBoundingClientRect()
      return row.top >= track.top - 1 && row.bottom <= track.bottom + 1
    })

  it('remeasures the rail for a different marker order, and not for a reply settling in the same turn', async () => {
    await open()
    const messages = [...prose(299, 1), { id: 'user-live', role: 'user', text: '继续检查' }] satisfies Message[]
    const liveId = 'reply-live'
    const liveText = '当前回复的文本'
    await show(detail(messages, { running: true, liveText, liveId }))
    const reply = page.locator(`[data-message-id="${liveId}"] .message-content`)
    await expect.poll(() => reply.getAttribute('aria-busy')).toBe('true')
    const track = page.locator('.conversation-rail-track')
    const current = track.locator('[aria-current="true"]')
    await expect.poll(() => markerInView(current)).toBe(true)
    expect(await current.getAttribute('value')).toBe('user-live')
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const measures = await track.evaluateHandle(element => {
      const reads = { count: 0 }
      const original = element.getBoundingClientRect.bind(element)
      element.getBoundingClientRect = () => {
        reads.count++
        return original()
      }
      return reads
    })

    const settled: Message[] = [...messages, { id: liveId, role: 'assistant', text: liveText }]
    await show(detail(settled, { cursor: 2 }))
    await expect.poll(() => reply.getAttribute('aria-busy')).toBeNull()
    expect((await measures.jsonValue()).count).toBe(0)
    expect(await current.getAttribute('value')).toBe('user-live')
    expect(await markerInView(current)).toBe(true)

    // The target index and the number of marks stay the same when earlier turns are reordered.
    await track.evaluate(element => {
      element.scrollTop = 0
    })
    await show(detail([...settled.slice(2, 4), ...settled.slice(0, 2), ...settled.slice(4)], { cursor: 3 }))
    await expect.poll(() => track.getByRole('button').first().getAttribute('value')).toBe('user-1')
    expect((await measures.jsonValue()).count).toBeGreaterThan(1)
    expect(await current.getAttribute('value')).toBe('user-live')
    await expect.poll(() => markerInView(current)).toBe(true)
    await measures.dispose()
  })

  it('reaches the oldest turn by keyboard, previews independently, and restores each session’s marker', async () => {
    await open()
    const rail = page.getByRole('navigation', { name: '会话定位' })
    await show(detail(prose(5, 2)))
    await page.locator('[data-message-id="user-4"]').waitFor()
    expect(await rail.count()).toBe(0)

    const messages = prose(300, 8)
    messages[0]!.text = '核对改动的来龙去脉。\n再看每一步的结果。\n<示例内容>\u202E不可见方向符。\n最后记录验证。'
    const value = detail(messages, { running: true, liveText: '正在处理', liveId: 'reply-live' })
    await show(value)
    const markers = rail.getByRole('button')
    const current = rail.locator('[aria-current="true"]')
    const oldest = markers.first()
    const newest = markers.last()
    const preview = page.locator('.conversation-rail-preview')
    await expect.poll(() => markers.count()).toBe(300)
    await expect.poll(() => markerInView(newest)).toBe(true)
    expect(await newest.getAttribute('aria-current')).toBe('true')
    expect(await rail.locator('button[tabindex="0"]').count()).toBe(1)

    const track = rail.locator('.conversation-rail-track')
    const transcript = page.locator('.transcript')
    const readingTop = () => transcript.evaluate(element => element.scrollTop)
    const trackTop = () => track.evaluate(element => element.scrollTop)
    const initialTop = await readingTop()
    await newest.hover()
    await page.mouse.wheel(0, -800)
    await expect.poll(() => markerInView(newest)).toBe(false)
    expect(await readingTop()).toBe(initialTop)
    const browsingTop = await trackTop()
    await page.evaluate(() => window.appendLive('，仍在处理'))
    await expect.poll(() => page.locator('[data-message-id="reply-live"]').textContent()).toContain('仍在处理')
    expect(await trackTop()).toBe(browsingTop)
    await transcript.hover()
    await expect.poll(() => markerInView(newest)).toBe(true)

    await page.keyboard.press('Tab')
    await expect.poll(() => newest.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Home')
    await expect.poll(() => markerInView(oldest)).toBe(true)
    expect(await oldest.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await current.getAttribute('value')).toBe('user-299')
    expect(await preview.textContent()).toContain('核对改动的来龙去脉。\n再看每一步的结果。\n<示例内容>\\u{202E}')
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'detached' })
    await page.keyboard.press('ArrowDown')
    expect(await markers.nth(1).evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await expect.poll(() => turnOffset('user-0')).toBeGreaterThanOrEqual(0)
    const oldestOffset = await turnOffset('user-0')
    expect(oldestOffset).toBeLessThanOrEqual(24)
    expect(await current.getAttribute('value')).toBe('user-0')
    await preview.waitFor({ state: 'detached' })

    await markers.nth(2).hover()
    await expect.poll(() => preview.textContent()).toContain('问题 2')
    await preview.hover()
    expect(await preview.textContent()).toContain('问题 2')
    await page.evaluate(() => window.appendLive('，新的流式片段'))
    await expect.poll(() => page.locator('[data-message-id="reply-live"]').textContent()).toContain('新的流式片段')
    expect(await turnOffset('user-0')).toBeCloseTo(oldestOffset, 0)
    expect(await current.getAttribute('value')).toBe('user-0')
    expect(await preview.textContent()).toContain('问题 2')

    await show(detail(prose(7, 2, 'other-'), { id: 'other' }))
    await expect.poll(() => current.getAttribute('value')).toBe('other-user-6')
    expect(await preview.count()).toBe(0)
    await show(value)
    await expect.poll(() => current.getAttribute('value')).toBe('user-0')
    await expect.poll(() => markerInView(oldest)).toBe(true)

    await transcript.hover()
    await page.mouse.wheel(0, 1_200)
    await expect.poll(() => current.getAttribute('value')).not.toBe('user-0')
    await expect.poll(() => markerInView(current)).toBe(true)
    await page.getByRole('button', { name: /回到最新/u }).click()
    await expect.poll(() => current.getAttribute('value')).toBe('user-299')
    await expect.poll(() => markerInView(newest)).toBe(true)
  })

  it('leaves the current mark empty while reading an imported note before the first marked turn', async () => {
    await open()
    const messages: Message[] = [
      { id: 'import-note', role: 'system', text: '导入时仅保留最近的会话记录。' },
      { id: 'import-tool', role: 'tool', text: '', toolName: 'read_file', state: 'completed' },
      ...prose(8, 4),
    ]
    const liveId = 'import-live'
    const liveText = '仍在检查刚导入的工作记录。\n\n'.repeat(45)
    await show(detail(messages, { running: true, liveId, liveText }))
    const rail = page.getByRole('navigation', { name: '会话定位' })
    const current = rail.locator('[aria-current="true"]')
    await expect.poll(() => current.getAttribute('value')).toBe('user-7')
    await page.evaluate(() => window.revealMessage('import-note'))
    await expect.poll(() => current.count()).toBe(0)
    expect(await rail.getByRole('button').count()).toBe(8)
    await expect.poll(() => rail.locator('button[tabindex="0"]').getAttribute('value')).toBe('user-0')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect.poll(() => current.getAttribute('value')).toBe('user-0')
    await page.evaluate(id => window.revealMessage(id), liveId)
    await expect.poll(() => turnOffset(liveId)).toBeCloseTo(24, 0)
    expect(await current.getAttribute('value')).toBe('user-7')
  })

  it.each(['dialog', 'popover', 'inert'] as const)('leaves Escape to the active UI when the hovered rail is under %s', async kind => {
    await open()
    await show(detail(prose(8, 4)))
    const marker = page.locator('.conversation-rail [aria-current="true"]')
    await marker.hover()
    const preview = page.locator('.conversation-rail-preview')
    await preview.waitFor()
    await page.evaluate(layer => {
      const control = document.createElement(layer === 'dialog' ? 'dialog' : 'button')
      control.id = 'escape-target'
      document.body.append(control)
      if (layer === 'dialog') (control as HTMLDialogElement).showModal()
      else if (layer === 'popover') {
        control.popover = 'auto'
        control.showPopover()
        control.focus()
      } else {
        document.querySelector<HTMLElement>('.conversation-rail')!.inert = true
        control.focus()
        control.addEventListener('keydown', event => {
          if (event instanceof KeyboardEvent && event.key === 'Escape') control.remove()
        })
      }
    }, kind)
    // The browser can clear hover when it changes hit testing. Keep that event pending to reproduce the original race.
    await marker.dispatchEvent('pointerover', { pointerType: 'mouse' })
    await preview.waitFor()
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'detached' })
    await expect.poll(() => page.locator(kind === 'inert' ? '#escape-target' : '#escape-target:is([open], :popover-open)').count()).toBe(0)
  })

  it('keeps the preview dismissed when Escape closes a dialog under a stationary pointer', async () => {
    await open()
    await show(detail(prose(8, 4)))
    const marker = page.locator('.conversation-rail [aria-current="true"]')
    await marker.hover()
    const preview = page.locator('.conversation-rail-preview')
    const previousPreview = await preview.evaluateHandle(element => element)
    await page.evaluate(() => {
      const dialog = document.createElement('dialog')
      dialog.id = 'rail-dialog'
      document.body.append(dialog)
      dialog.showModal()
    })
    await page.keyboard.press('Escape')
    await page.locator('#rail-dialog').waitFor({ state: 'hidden' })
    const target = (await marker.boundingBox())!
    const x = target.x + target.width / 2
    const y = target.y + target.height / 2
    await marker.dispatchEvent('pointerover', { pointerType: 'mouse', clientX: x, clientY: y })
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    expect(await previousPreview.evaluate(element => element.isConnected)).toBe(false)
    expect(await preview.count()).toBe(0)
    await page.mouse.move(x + 2, y)
    await preview.waitFor()
  })

  it('dismisses a hovered preview before downstream Escape handlers and leaves IME in control', async () => {
    await open(390, 710)
    const value = detail(prose(100, 4))
    await show(value)
    await page.evaluate(() => window.openFind())
    const searchbox = page.getByRole('searchbox')
    await searchbox.waitFor()
    const marker = page.getByRole('navigation', { name: '会话定位' }).locator('[aria-current]')
    await expect.poll(() => markerInView(marker)).toBe(true)
    await marker.hover()
    const preview = page.locator('.conversation-rail-preview')
    await preview.waitFor()
    expect(await searchbox.evaluate(element => element === document.activeElement)).toBe(true)
    const previewBox = (await preview.boundingBox())!
    const findBox = (await page.getByRole('search').boundingBox())!
    expect(previewBox.y).toBeGreaterThanOrEqual(findBox.y + findBox.height)
    expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(390)
    await searchbox.evaluate(element => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    })
    expect(await preview.count()).toBe(1)
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'detached' })
    expect(await searchbox.count()).toBe(1)
    expect(await searchbox.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await searchbox.waitFor({ state: 'detached' })
  })

  it('leaves the touch rail where the reader swiped when a new turn arrives', async () => {
    await open(390, 844, { isMobile: true, hasTouch: true })
    const messages = prose(100, 4)
    await show(detail(messages))
    const rail = page.getByRole('navigation', { name: '会话定位' })
    const current = rail.locator('[aria-current="true"]')
    await expect.poll(() => markerInView(current)).toBe(true)
    const track = rail.locator('.conversation-rail-track')
    const top = () => track.evaluate(element => element.scrollTop)
    const bottom = await top()
    const box = (await track.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const client = await page.context().newCDPSession(page)
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 160 }] })
    await expect.poll(top).toBeLessThan(bottom - 40)
    await show(detail(prose(101, 4), { running: true, liveText: '新一轮正在进行', cursor: 2 }))
    await expect.poll(() => current.getAttribute('value')).toBe('user-100')
    expect(await markerInView(current)).toBe(false)
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.touchscreen.tap(200, 300)
    await expect.poll(() => markerInView(current)).toBe(true)
    expect(await page.locator('.conversation-rail-preview').count()).toBe(0)
  })

  it.each([
    { width: 390, height: 844, touch: true },
    { width: 768, height: 1024, touch: true },
    { width: 1440, height: 900, touch: false },
  ])('shows 100-turn markers and keeps the text clear at $width in both themes', async ({ width, height, touch }) => {
    await mkdir('test-results/conversation-rail', { recursive: true })
    for (const colorScheme of ['light', 'dark'] as const) {
      await open(width, height, { isMobile: touch, hasTouch: touch, colorScheme })
      const messages = prose(100, 8)
      messages[192]!.text = '从文件列表里的改动继续。\n先核对读取位置，再用本地夹具确认结果。\n把结果记在这段会话里，回到最新查看新的输出。'
      await show(detail(messages, { running: true, liveText: '正在检查最后一轮的结果。', liveId: 'reply-live' }))
      const rail = page.getByRole('navigation', { name: '会话定位' })
      const marker = rail.getByRole('button').nth(96)
      const preview = page.locator('.conversation-rail-preview')
      await expect.poll(() => markerInView(marker)).toBe(true)
      const box = (await marker.boundingBox())!
      if (touch) {
        expect(box.width).toBeGreaterThanOrEqual(44)
        expect(box.height).toBeGreaterThanOrEqual(44)
        await marker.tap()
        expect(await preview.count()).toBe(0)
        await expect.poll(() => turnOffset('user-96')).toBeCloseTo(24, 0)
      } else {
        await marker.hover()
        await expect.poll(() => preview.textContent()).toContain('从文件列表里的改动继续。\n先核对读取位置')
        const surface = (await preview.boundingBox())!
        expect(surface.x).toBeGreaterThanOrEqual(box.x + box.width)
        expect(surface.x + surface.width).toBeLessThanOrEqual(width)
        expect(surface.y).toBeGreaterThanOrEqual(0)
        expect(surface.y + surface.height).toBeLessThanOrEqual(height)
      }
      expect(
        await page.locator('.transcript-content').evaluate(element => {
          const { left } = element.getBoundingClientRect()
          return left + Number.parseFloat(getComputedStyle(element).paddingInlineStart)
        }),
      ).toBeGreaterThanOrEqual(box.x + box.width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      await page.screenshot({ path: `test-results/conversation-rail/${width}-${colorScheme}.png`, animations: 'disabled' })
      if (!touch) {
        await marker.click()
        await expect.poll(() => turnOffset('user-96')).toBeCloseTo(24, 0)
        expect(await preview.count()).toBe(0)
      }
    }
  })

  // Far turns are placeholders of a guessed height, and a turn's rows measure in full whether it is drawn or not.
  describe.each([
    ['barely taller than the placeholder', 10],
    ['several times the placeholder', 25],
    ['taller than the view', 60],
  ])('with turns %s', (_name, paragraphs) => {
    it('reveals a far row exactly where it asked, and it stays there', async () => {
      await open()
      await show(detail(prose(40, paragraphs)))
      const at = () =>
        page.evaluate(() => {
          const row = document.querySelector('[data-message-id="user-5"]')!.getBoundingClientRect()
          return row.top - document.querySelector('.transcript')!.getBoundingClientRect().top
        })
      await page.waitForTimeout(300)
      await page.evaluate(() => window.revealMessage('user-5'))
      await expect.poll(at).toBeCloseTo(24, 0)
      await page.waitForTimeout(800)
      expect(await at()).toBeCloseTo(24, 0)
    })

    it('reveals a far row near the end, though the turns after it are not drawn', async () => {
      await open()
      await show(detail(prose(40, paragraphs)))
      await page.waitForTimeout(300)
      await page.locator('.transcript').hover()
      await page.evaluate(() => {
        const view = document.querySelector('.transcript')!
        view.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
        view.scrollTop = 0
      })
      await page.waitForTimeout(500)
      await page.evaluate(() => window.revealMessage('user-38'))
      const at = () =>
        page.evaluate(() => {
          const row = document.querySelector('[data-message-id="user-38"]')!.getBoundingClientRect()
          return row.top - document.querySelector('.transcript')!.getBoundingClientRect().top
        })
      await page.waitForTimeout(800)
      expect(await at()).toBeLessThan(900)
    })

    it('finds a word in a far turn and lands on it', async () => {
      await open()
      await show(detail(prose(40, paragraphs)))
      await page.waitForTimeout(300)
      await page.evaluate(() => window.openFind())
      await page.getByRole('searchbox').fill('word5x0')
      await expect.poll(() => page.getByRole('search').getByRole('status').textContent()).toBe('1/1')
      const seen = () =>
        page.evaluate(() => {
          const current = [...CSS.highlights.get('latch-find-current')!.values()][0] as Range,
            view = document.querySelector('.transcript')!.getBoundingClientRect(),
            top = current.getBoundingClientRect().top
          return top >= view.top && top < view.top + 200
        })
      await expect.poll(seen).toBe(true)
      await page.waitForTimeout(800)
      expect(await seen()).toBe(true)
    })

    it('returns to the same paragraph after visiting another session', async () => {
      await open()
      const past = detail(prose(40, paragraphs))
      await show(past)
      await page.waitForTimeout(300)
      await page.locator('.transcript').hover()
      for (let step = 0; step < 6; step++) {
        await page.mouse.wheel(0, -900)
        await page.waitForTimeout(200)
      }
      await page.waitForTimeout(1000)
      const reading = () =>
        page.evaluate(() => {
          const view = document.querySelector('.transcript')!.getBoundingClientRect()
          for (let y = 300; y < 600; y += 20) {
            const paragraph = document.elementFromPoint(view.left + view.width / 2, view.top + y)?.closest('.message-content p')
            if (paragraph) return { text: paragraph.textContent, at: Math.round(paragraph.getBoundingClientRect().top - view.top) }
          }
          return null
        })
      const before = await reading()
      expect(before).not.toBeNull()
      await show(detail(prose(3, 5, 'other-'), { id: 'other' }))
      await page.waitForTimeout(300)
      await show(past)
      await page.waitForTimeout(1000)
      const after = await reading()
      expect(after?.text).toBe(before!.text)
      expect(Math.abs(after!.at - before!.at)).toBeLessThanOrEqual(1)
    })
  })

  it('only reads message rectangles in visible turns when the reader starts scrolling up', async () => {
    await open()
    await show(detail(prose(300, 10)))
    await page.locator('[data-message-id="reply-299"]').waitFor()
    const reads = await page.locator('.transcript').evaluate(view => {
      const measure = Element.prototype.getBoundingClientRect
      let messages = 0
      Element.prototype.getBoundingClientRect = function (this: Element) {
        if (this.hasAttribute('data-message-id')) messages++
        return measure.call(this)
      }
      try {
        view.dispatchEvent(new WheelEvent('wheel', { deltaY: -900, bubbles: true }))
        return messages
      } finally {
        Element.prototype.getBoundingClientRect = measure
      }
    })
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThan(32)
  })

  it('moves by what the wheel asks when scrolling up through turns not drawn yet, and prints every turn', async () => {
    await open()
    await show(detail(history(80)))
    await page.locator('.message-code').last().locator('.syn-keyword').first().waitFor()
    await page.locator('.transcript').hover()
    const top = () => page.locator('.transcript').evaluate(element => element.scrollTop)
    const row = (id: string) => page.locator(`[data-message-id="${id}"]`).evaluate(element => element.getBoundingClientRect().top)
    const jumps: number[] = []
    for (let step = 0; step < 12; step++) {
      const before = await page.evaluate(() => {
        const view = document.querySelector('.transcript')!.getBoundingClientRect()
        const first = [...document.querySelectorAll<HTMLElement>('[data-message-id]')].find(
          element => element.getBoundingClientRect().bottom > view.top,
        )!
        return { id: first.dataset.messageId!, at: first.getBoundingClientRect().top }
      })
      await page.mouse.wheel(0, -900)
      await expect.poll(async () => (await row(before.id)) - before.at).toBeGreaterThan(0)
      await page.waitForTimeout(120)
      jumps.push((await row(before.id)) - before.at)
    }
    expect(
      jumps.every(jump => Math.abs(jump - 900) <= 2),
      jumps.join(','),
    ).toBe(true)
    expect(await top()).toBeGreaterThan(0)
    await page.emulateMedia({ media: 'print' })
    const printed = await page.evaluate(() => getComputedStyle(document.querySelector('.turn')!).contentVisibility)
    expect(printed).toBe('visible')
    await page.emulateMedia({ media: 'screen' })
  })

  it.each(['light', 'dark'] as const)('draws syntax in readable colours from the tokens in %s', async colorScheme => {
    await open()
    await page.emulateMedia({ colorScheme })
    await show(detail(history(2)))
    await page.locator('.message-code .syn-comment').last().waitFor()
    const ratios = await page.evaluate(() => {
      const channels = (value: string) => value.match(/[\d.]+/gu)!.map(Number)
      const linear = (value: number) => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4)
      const luminance = ([r = 0, g = 0, b = 0]: number[]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
      const ground = channels(getComputedStyle(document.querySelector('.message-code')!).backgroundColor)
      return Object.fromEntries(
        ['keyword', 'string', 'comment', 'plain'].flatMap(role => {
          const token = document.querySelector(`.message-code .syn-${role}`)
          if (!token) return []
          const a = luminance(channels(getComputedStyle(token).color)),
            b = luminance(ground)
          return [[role, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)]]
        }),
      )
    })
    expect(Object.keys(ratios).sort()).toEqual(['comment', 'keyword', 'plain', 'string'])
    for (const [role, ratio] of Object.entries(ratios)) expect(ratio, role).toBeGreaterThanOrEqual(role === 'comment' ? 3 : 4.5)
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('shows silence without a decision, identifies unsupported requests, and reports unknown results after exit', async () => {
    await open()
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const live = { runId: 'r', activity: 'model', since: ago(5), lastEventAt: ago(3) }
    const withSummary = (extra: object, running: boolean): TaskDetail => {
      const base = detail(prose(1, 2), { running })
      return { ...base, summary: { ...base.summary, ...extra } } as TaskDetail
    }

    await show(withSummary({ live: { ...live, silent: true, silenceThresholdMs: 120_000 } }, true))
    const line = page.locator('.status-line')
    await line.filter({ hasText: /等模型回应 · 3 分钟没有新内容/ }).waitFor()
    expect(await line.getByRole('button').count()).toBe(0)
    expect(await line.getAttribute('class')).toContain('is-plain')

    await show(
      withSummary({ live: { ...live, unrecognized: { count: 1, at: ago(0), method: 'terminal/create', messageId: 'user-0' } } }, true),
    )
    await line.filter({ hasText: '发来不支持的请求 terminal/create' }).waitFor()
    await line.getByRole('button', { name: '查看', exact: true }).waitFor()
    expect(await line.getByRole('button').allTextContents()).toEqual(['查看'])

    await show(withSummary({ runEnd: { reason: 'process-exited', unknownResultCount: 1, unknownResults: [{ name: 'pnpm test' }] } }, false))
    const end = page.locator('.run-end')
    await end.filter({ hasText: '已退出 · 这一轮没有完成 · 这 1 条命令结果未知，请核对' }).waitFor()
    await end.getByText('pnpm test', { exact: true }).waitFor()
  })
})
