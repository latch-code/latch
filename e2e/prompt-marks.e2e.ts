import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, webkit, type Locator, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSession } from './helpers/layout.ts'

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const SKILLED = '请用 $lark-apps 写一个页面'
const MIXED =
  '/compact 先压缩一下上下文，然后请用 $lark-apps 帮我把这一周的项目进度整理成一个可以分享给团队的飞书应用页面，最后用 $check 检查一遍'

/** The input's caret lands where the mirror drew each character: a click on a glyph's right half puts it after that glyph. */
async function caretAfterGlyph(page: Page, input: Locator, index: number): Promise<number> {
  // The input grows a line at a time after a fill; measure once it and the mirror have settled on the same box.
  await page.waitForFunction(() => {
    const area = document.querySelector<HTMLTextAreaElement>('.composer-input[data-marks] > textarea')
    const mirror = document.querySelector<HTMLElement>('.composer-input[data-marks] > .composer-command-mirror')
    if (!area || !mirror) return false
    const a = area.getBoundingClientRect(),
      m = mirror.getBoundingClientRect()
    return area.scrollHeight <= area.clientHeight + 1 && a.top === m.top && a.height === m.height && area.scrollTop === mirror.scrollTop
  })
  const point = await page.evaluate(at => {
    const mirror = document.querySelector('.composer-input[data-marks] > .composer-command-mirror')!
    const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT)
    let left = at
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent!.length
      if (left < length) {
        const range = document.createRange()
        range.setStart(node, left)
        range.setEnd(node, left + 1)
        const rect = range.getBoundingClientRect()
        return { x: rect.right - 1, y: rect.top + rect.height / 2 }
      }
      left -= length
    }
    throw new Error('no glyph at ' + at)
  }, index)
  await page.mouse.click(point.x, point.y)
  return input.evaluate(element => (element as HTMLTextAreaElement).selectionStart)
}

it.each(['chromium', 'webkit'] as const)('draws skill and command tokens as marks while the draft stays text on %s', async engine => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-prompt-marks-')))
  let host: Awaited<ReturnType<typeof startTestHost>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const command = join(root, 'codex'),
      log = join(root, 'native.jsonl'),
      skillFile = join(root, 'skills.json')
    const rows = [
      { name: 'lark-apps', description: '飞书应用', path: '/private/native-skill/lark/SKILL.md', scope: 'user', enabled: true },
      { name: 'check', description: '检查改动', path: '/private/native-skill/check/SKILL.md', scope: 'repo', enabled: true },
    ]
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
    const { workspace } = (await (await owner.addFolders({ paths: [project], name: '标记项目' })).json()) as { workspace: WorkspaceInfo }
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
    await expect.poll(async () => (await detail()).skills?.length).toBe(2)
    expect((await detail()).commands?.some(item => item.name === 'compact')).toBe(true)
    browser = await (engine === 'webkit' ? webkit.launch() : chromium.launch(browserLaunchOptions()))
    const output = `test-results/prompt-marks/${engine}`
    await mkdir(output, { recursive: true })
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [390, 'light'],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
      const page = await context.newPage()
      try {
        await enrollBrowser(page, host)
        await connected(page)
        await openSession(page, sessionId)
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        const frame = page.locator('.composer-input:has(> textarea[aria-label="继续对话"])')
        await input.fill('$lark $lark-apps-x a$check /tmp/$check')
        expect(await frame.locator('.prompt-mark').count()).toBe(0)
        expect(await frame.getAttribute('data-marks')).toBeNull()

        await input.fill(SKILLED)
        const mark = frame.locator('.prompt-mark[data-kind="skill"]')
        await mark.waitFor()
        expect(await mark.textContent()).toBe('$lark-apps')
        expect(await mark.locator('svg').count()).toBe(1)
        const end = SKILLED.indexOf('$lark-apps') + '$lark-apps'.length
        expect(await caretAfterGlyph(page, input, end - 1)).toBe(end)
        expect(await caretAfterGlyph(page, input, SKILLED.length - 1)).toBe(SKILLED.length)
        const ink = await input.evaluate(element => getComputedStyle(element).webkitTextFillColor)
        expect(ink).toMatch(/rgba\(0, 0, 0, 0\)|transparent/u)

        // One Backspace after the mark takes it whole as one native edit. Chromium's undo brings it back; WebKit folds
        // that edit into the text entered before it, so its undo does exactly what it does after its own Delete over
        // the same token.
        await input.press('ArrowLeft')
        await input.evaluate((element, at) => (element as HTMLTextAreaElement).setSelectionRange(at, at), end)
        await input.press('Backspace')
        expect(await input.inputValue()).toBe('请用  写一个页面')
        expect(await frame.locator('.prompt-mark').count()).toBe(0)
        await input.press('ControlOrMeta+z')
        if (engine === 'webkit') {
          const undone = await input.inputValue()
          await input.fill(SKILLED)
          await input.press('ArrowLeft')
          await input.evaluate(
            (element, [from, to]) => (element as HTMLTextAreaElement).setSelectionRange(from!, to!),
            [end - '$lark-apps'.length, end],
          )
          await input.press('Delete')
          expect(await input.inputValue()).toBe('请用  写一个页面')
          await input.press('ControlOrMeta+z')
          expect(undone).toBe(await input.inputValue())
          await input.fill(SKILLED)
        }
        expect(await input.inputValue()).toBe(SKILLED)
        await mark.waitFor()
        // Typing inside the token turns it back into text.
        await input.evaluate((element, at) => (element as HTMLTextAreaElement).setSelectionRange(at, at), end - 2)
        await input.press('x')
        expect(await frame.locator('.prompt-mark').count()).toBe(0)

        // Mixed with Chinese over two or more lines, a command mark first and a selection across a skill mark.
        await input.fill(MIXED)
        await frame.locator('.prompt-mark[data-kind="command"]').waitFor()
        expect(await frame.locator('.prompt-mark').count()).toBe(3)
        const lines = await input.evaluate(element => element.scrollHeight / parseFloat(getComputedStyle(element).lineHeight))
        expect(lines).toBeGreaterThan(2)
        const metrics = await page.evaluate(() => {
          const area = document.querySelector<HTMLTextAreaElement>('.composer-input[data-marks] > textarea')!
          const mirror = document.querySelector<HTMLElement>('.composer-input[data-marks] > .composer-command-mirror')!
          return { area: area.scrollHeight, mirror: mirror.scrollHeight, areaWidth: area.clientWidth, mirrorWidth: mirror.clientWidth }
        })
        expect(Math.abs(metrics.area - metrics.mirror)).toBeLessThanOrEqual(1)
        const second = MIXED.lastIndexOf('$check') + '$check'.length
        expect(await caretAfterGlyph(page, input, second - 1)).toBe(second)
        const skill = MIXED.indexOf('$lark-apps')
        await input.focus()
        await input.evaluate(
          (element, [from, to]) => (element as HTMLTextAreaElement).setSelectionRange(from!, to!),
          [skill - 4, skill + '$lark-apps'.length + 3],
        )
        await page.screenshot({ path: `${output}/mixed-${width}-${theme}.png`, animations: 'disabled' })
        await frame.screenshot({ path: `${output}/input-${width}-${theme}.png`, animations: 'disabled' })
      } catch (error) {
        await page.screenshot({ path: `${output}/failure-${width}-${theme}.png`, animations: 'disabled' }).catch(() => {})
        throw error
      } finally {
        await context.close()
      }
    }

    // What is sent is the literal text, and the Codex wire still attaches the skill.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await enrollBrowser(page, host)
    await connected(page)
    await openSession(page, sessionId)
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill(SKILLED)
    await page.locator('.prompt-mark[data-kind="skill"]').waitFor()
    await input.press('Control+Enter')
    await expect
      .poll(async () => (await detail()).messages.filter(message => message.role === 'user' && message.text === SKILLED).length)
      .toBe(1)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    const prompts = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { method?: string; params?: { input?: unknown[] } })
      .filter(call => call.method === 'turn/start')
    expect(JSON.stringify(prompts.at(-1)?.params?.input)).toContain(JSON.stringify(SKILLED).slice(1, -1))
    expect(prompts.at(-1)?.params?.input).toContainEqual({ type: 'skill', name: 'lark-apps', path: rows[0]!.path })
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
