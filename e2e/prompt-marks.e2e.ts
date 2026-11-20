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
import { promptSelection, promptValue, setPromptSelection } from './helpers/prompt.ts'

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const SKILLED = '请用 $lark-apps 写一个页面'
const MIXED =
  '/compact 先压缩一下上下文，然后请用 $lark-apps 帮我把这一周的项目进度整理成一个可以分享给团队的飞书应用页面，最后用 $check 检查一遍'
const FILE = 'vitest.browser.config.ts'

/** Each chip's box against the standard: its padding, glyph and gap, radius, side margins, height under the line. */
async function chipGeometry(input: Locator): Promise<string[]> {
  return input.evaluate(element =>
    [...element.querySelectorAll<HTMLElement>('.prompt-chip')].flatMap((chip, index) => {
      const style = getComputedStyle(chip)
      const icon = chip.querySelector<HTMLElement>('.prompt-chip-icon')!.getBoundingClientRect()
      const label = chip.querySelector<HTMLElement>('.prompt-chip-label')!.getBoundingClientRect()
      const box = chip.getBoundingClientRect()
      const line = parseFloat(getComputedStyle(element).lineHeight)
      const problems: string[] = []
      const near = (value: number, want: number) => Math.abs(value - want) <= 0.5
      if (!near(parseFloat(style.paddingLeft), 4) || !near(parseFloat(style.paddingRight), 6))
        problems.push(`${index}: padding ${style.padding}`)
      if (!near(parseFloat(style.marginLeft), 2) || !near(parseFloat(style.marginRight), 2))
        problems.push(`${index}: margin ${style.margin}`)
      if (!near(icon.width, 14) || !near(icon.height, 14)) problems.push(`${index}: icon ${icon.width}x${icon.height}`)
      if (!near(label.left - icon.right, 4)) problems.push(`${index}: gap ${label.left - icon.right}`)
      if (!near(parseFloat(style.borderTopLeftRadius), 6)) problems.push(`${index}: radius ${style.borderTopLeftRadius}`)
      if (!(box.height < line && box.height >= line - 6)) problems.push(`${index}: height ${box.height} on a ${line} line`)
      if (/rgb\(36, 97, 224\)|rgb\(47, 107, 230\)/u.test(style.backgroundColor)) problems.push(`${index}: primary fill`)
      return problems
    }),
  )
}

/** The horizontal room between neighbouring chips and between a chip and the text beside it, on the same line. */
async function chipRoom(input: Locator): Promise<number[]> {
  return input.evaluate(element => {
    const rooms: number[] = []
    for (const chip of element.querySelectorAll<HTMLElement>('.prompt-chip')) {
      const box = chip.getBoundingClientRect()
      const previous = chip.previousSibling
      if (!previous) continue
      const range = document.createRange()
      if (previous instanceof Text && previous.length) {
        range.setStart(previous, previous.length - 1)
        range.setEnd(previous, previous.length)
      } else if (previous instanceof HTMLElement) range.selectNode(previous)
      else continue
      const before = [...range.getClientRects()].at(-1)
      if (before && Math.abs(before.top - box.top) < box.height) rooms.push(Math.round((box.left - before.right) * 10) / 10)
    }
    return rooms
  })
}

const chips = (input: Locator) =>
  input.evaluate(element =>
    [...element.querySelectorAll<HTMLElement>('.prompt-chip')].map(chip => [
      chip.dataset.kind,
      chip.querySelector('.prompt-chip-label')!.textContent,
      chip.dataset.selected === undefined ? '' : 'selected',
    ]),
  )

/** Text typed through the platform's input method: composition events around the committed text. */
async function compose(page: Page, engine: 'chromium' | 'webkit', steps: string[], commit: string) {
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    for (const step of steps)
      await cdp.send('Input.imeSetComposition', { text: step, selectionStart: step.length, selectionEnd: step.length })
    await cdp.send('Input.insertText', { text: commit })
    await cdp.detach()
    return
  }
  // Playwright's WebKit has no input method: the composition is synthesised around inserted text.
  await page.evaluate(last => {
    const element = document.activeElement!
    element.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    element.dispatchEvent(new CompositionEvent('compositionupdate', { data: last, bubbles: true }))
  }, steps.at(-1)!)
  await page.keyboard.insertText(commit)
  await page.evaluate(text => {
    document.activeElement!.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }))
  }, commit)
}

it.each(['chromium', 'webkit'] as const)(
  'draws tokens as atomic chips while the draft stays text on %s',
  async engine => {
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
      await writeFile(join(project, FILE), 'export default {}\n')
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
      const mod = engine === 'webkit' || process.platform === 'darwin' ? 'Meta' : 'Control'
      let marker = ''
      for (const [width, theme] of [
        [1440, 'light'],
        [1440, 'dark'],
        [390, 'light'],
        [390, 'dark'],
      ] as const) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
        const page = await context.newPage()
        const shot = (name: string, target: Locator | Page) =>
          target.screenshot({ path: `${output}/${name}-${width}-${theme}.png`, animations: 'disabled', caret: 'hide' })
        try {
          await enrollBrowser(page, host)
          await connected(page)
          await openSession(page, sessionId)
          const input = page.getByRole('textbox', { name: '继续对话', exact: true })
          const frame = page.locator('form.composer:not([hidden])').filter({ has: input })
          // Unknown names, glued tokens and paths stay text.
          await input.fill('$lark $lark-apps-x a$check /tmp/$check')
          expect(await chips(input)).toEqual([])

          // A skill: its book and name, never its `$`; the caret steps over it whole.
          await input.fill(SKILLED)
          await expect.poll(() => chips(input)).toEqual([['skill', 'lark-apps', '']])
          expect(await promptValue(input)).toBe(SKILLED)
          expect(await input.locator('.prompt-chip svg').count()).toBe(1)
          expect(await input.locator('.prompt-chip .prompt-chip-token').textContent()).toBe('$lark-apps')
          expect(await input.locator('.prompt-chip').getAttribute('title')).toBe('技能 · lark-apps\n飞书应用')
          expect(await chipGeometry(input)).toEqual([])
          expect((await chipRoom(input)).every(room => room >= 2)).toBe(true)
          const start = SKILLED.indexOf('$lark-apps'),
            end = start + '$lark-apps'.length
          await setPromptSelection(input, end)
          await input.press('ArrowLeft')
          expect((await promptSelection(input)).head).toBe(start)
          await input.press('ArrowRight')
          expect((await promptSelection(input)).head).toBe(end)
          // Shift+arrows select across it, and the chip says it is inside the selection.
          await setPromptSelection(input, start - 1)
          await input.press('Shift+ArrowRight')
          await input.press('Shift+ArrowRight')
          expect(await promptSelection(input)).toEqual({ from: start - 1, to: end, head: end })
          await expect.poll(() => chips(input)).toEqual([['skill', 'lark-apps', 'selected']])
          await shot('selected', frame)
          // Backspace after it takes it whole; one undo brings it back, and redo takes it again.
          await setPromptSelection(input, end)
          await input.press('Backspace')
          expect(await promptValue(input)).toBe('请用  写一个页面')
          expect(await chips(input)).toEqual([])
          await input.press(`${mod}+z`)
          expect(await promptValue(input)).toBe(SKILLED)
          expect(await chips(input)).toEqual([['skill', 'lark-apps', '']])
          await input.press(`${mod}+Shift+z`)
          expect(await promptValue(input)).toBe('请用  写一个页面')
          await input.press(`${mod}+z`)
          // Delete before it does the same.
          await setPromptSelection(input, start)
          await input.press('Delete')
          expect(await promptValue(input)).toBe('请用  写一个页面')
          await input.press(`${mod}+z`)
          expect(await promptValue(input)).toBe(SKILLED)
          // Typed after the chip and its space, words are text; typed against it, the token is text again.
          await setPromptSelection(input, end + 1)
          await page.keyboard.type('先')
          expect(await promptValue(input)).toBe('请用 $lark-apps 先写一个页面')
          expect(await chips(input)).toEqual([['skill', 'lark-apps', '']])
          await setPromptSelection(input, end)
          await page.keyboard.type('x')
          expect(await chips(input)).toEqual([])

          // A command first, two skills, Chinese over several lines.
          await input.fill(MIXED)
          await expect
            .poll(() => chips(input))
            .toEqual([
              ['command', 'compact', ''],
              ['skill', 'lark-apps', ''],
              ['skill', 'check', ''],
            ])
          expect(await promptValue(input)).toBe(MIXED)
          const lines = await input.evaluate(
            element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
          )
          expect(lines).toBeGreaterThan(2)
          expect(await chipGeometry(input)).toEqual([])
          expect((await chipRoom(input)).every(room => room >= 2)).toBe(true)
          // The input keeps the page's face, not CodeMirror's monospace.
          const fonts = await input.evaluate(element => [getComputedStyle(element).fontFamily, getComputedStyle(document.body).fontFamily])
          expect(fonts[0]).toBe(fonts[1])
          await shot('mixed', frame)
          await shot('command', input.locator('.prompt-chip[data-kind="command"]'))

          // A file chosen with @: the chip shows its name; the draft holds its marker.
          await input.fill('看看 ')
          await setPromptSelection(input, 3)
          await page.keyboard.type('@vitest')
          const files = page.getByRole('listbox', { name: '引用项目文件', exact: true })
          await files.getByRole('option').filter({ hasText: FILE }).first().waitFor()
          await page.keyboard.press('Enter')
          await expect.poll(() => chips(input)).toEqual([['file', FILE, '']])
          marker = (await promptValue(input)).trim().split(' ').at(-1)!
          expect(marker).toMatch(new RegExp(`^@[^:]+:${FILE.replaceAll('.', '\\.')}$`, 'u'))
          expect(await promptValue(input)).toBe(`看看 ${marker} `)
          expect(await input.locator('.prompt-chip').getAttribute('title')).toBe(marker.slice(1))
          // One undo takes back what the menu put in.
          await input.press(`${mod}+z`)
          expect(await promptValue(input)).toBe('看看 @vitest')
          await input.press(`${mod}+Shift+z`)
          expect(await promptValue(input)).toBe(`看看 ${marker} `)
          await page.keyboard.type('里的 $check 和 $lark-apps 设置')
          await expect
            .poll(() => chips(input))
            .toEqual([
              ['file', FILE, ''],
              ['skill', 'check', ''],
              ['skill', 'lark-apps', ''],
            ])
          expect(await chipGeometry(input)).toEqual([])
          expect((await chipRoom(input)).every(room => room >= 2)).toBe(true)
          await shot('file', frame)

          // An input method's composition after a chip, and Enter while composing never sends.
          await input.fill('请用 $lark-apps ')
          await setPromptSelection(input, '请用 $lark-apps '.length)
          await compose(page, engine, ['n', 'ni', 'nih', 'niha', 'nihao'], '你好')
          expect(await promptValue(input)).toBe('请用 $lark-apps 你好')
          expect(await chips(input)).toEqual([['skill', 'lark-apps', '']])
          if (engine === 'chromium') {
            const cdp = await page.context().newCDPSession(page)
            const before = (await detail()).messages.length
            await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 229,
              nativeVirtualKeyCode: 229,
            })
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 })
            await cdp.send('Input.insertText', { text: '呢' })
            await cdp.detach()
            expect(await promptValue(input)).toBe('请用 $lark-apps 你好呢')
            await page.waitForTimeout(300)
            expect((await detail()).messages.length).toBe(before)
          }

          // A paste is plain text, and its tokens become chips.
          await input.fill('')
          await input.focus()
          await input.evaluate(element => {
            const data = new DataTransfer()
            data.setData('text/plain', '粘贴 $check 和\n$lark-apps')
            data.setData('text/html', '<b style="color:red">粘贴 $check 和</b><br><i>$lark-apps</i>')
            element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
          })
          expect(await promptValue(input)).toBe('粘贴 $check 和\n$lark-apps')
          expect(await chips(input)).toEqual([
            ['skill', 'check', ''],
            ['skill', 'lark-apps', ''],
          ])
          expect(await input.locator('b, i').count()).toBe(0)

          // Feed the shortcut and its paste event an isolated clipboard. The prompt keeps the selected range and one undo.
          await setPromptSelection(input, 3, 9)
          const pastedLog = '日志：测试长文本\n'.repeat(250)
          await input.evaluate((element, text) => {
            const mac = /Mac/u.test(navigator.platform)
            const shortcut = { key: 'V', metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true }
            element.dispatchEvent(new KeyboardEvent('keydown', shortcut))
            const data = new DataTransfer()
            data.setData('text/plain', text)
            element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
            element.dispatchEvent(new KeyboardEvent('keyup', shortcut))
          }, pastedLog)
          expect(await promptValue(input)).toBe(`粘贴 ${pastedLog} 和\n$lark-apps`)
          const caret = 3 + pastedLog.length
          expect(await promptSelection(input)).toEqual({ from: caret, to: caret, head: caret })
          expect(await page.locator('.attachment-draft').count()).toBe(0)
          await input.press('ControlOrMeta+z')
          expect(await promptValue(input)).toBe('粘贴 $check 和\n$lark-apps')

          // A dropped image never becomes text in the draft.
          await input.evaluate(element => {
            const data = new DataTransfer()
            data.items.add(new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])], 'shot.png', { type: 'image/png' }))
            element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
          })
          expect(await promptValue(input)).toBe('粘贴 $check 和\n$lark-apps')
          await input.fill('')
        } catch (error) {
          await page.screenshot({ path: `${output}/failure-${width}-${theme}.png`, animations: 'disabled' }).catch(() => {})
          throw error
        } finally {
          await context.close()
        }
      }

      // What is sent is the literal text: the Codex wire still attaches the skill, and the message shows the same chips.
      const sent = `${SKILLED} 看 ${marker} 再 $check`
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      await enrollBrowser(page, host)
      await connected(page)
      await openSession(page, sessionId)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await input.fill(`${SKILLED} 看 `)
      await page.keyboard.type('@vitest')
      await page.getByRole('listbox', { name: '引用项目文件', exact: true }).getByRole('option').filter({ hasText: FILE }).first().waitFor()
      await page.keyboard.press('Enter')
      await page.keyboard.type('再 $check')
      expect(await promptValue(input)).toBe(sent)
      await input.press('Control+Enter')
      await expect
        .poll(async () => (await detail()).messages.filter(message => message.role === 'user' && message.text === sent).length)
        .toBe(1)
      await expect.poll(async () => (await detail()).summary.status).toBe('idle')
      const prompts = (await readFile(log, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { method?: string; params?: { input?: unknown[] } })
        .filter(call => call.method === 'turn/start')
      expect(JSON.stringify(prompts.at(-1)?.params?.input)).toContain(JSON.stringify(SKILLED).slice(1, -1))
      expect(prompts.at(-1)?.params?.input).toContainEqual({ type: 'skill', name: 'lark-apps', path: rows[0]!.path })
      const bubble = page.locator('.user-bubble-text').filter({ hasText: '写一个页面' }).last()
      await bubble.locator('.prompt-chip').first().waitFor()
      expect(
        await bubble.evaluate(element =>
          [...element.querySelectorAll<HTMLElement>('.prompt-chip')].map(chip => [
            chip.dataset.kind,
            chip.querySelector('.prompt-chip-label')!.textContent,
          ]),
        ),
      ).toEqual([
        ['skill', 'lark-apps'],
        ['file', FILE],
        ['skill', 'check'],
      ])
      // A copy across the chips takes the tokens as written, not the names (the browser may break the line round one).
      expect(
        await bubble.evaluate(element => {
          const range = document.createRange()
          range.selectNodeContents(element)
          getSelection()!.removeAllRanges()
          getSelection()!.addRange(range)
          return getSelection()!.toString().replace(/\s+/gu, ' ').trim()
        }),
      ).toBe(sent)
      // A file chip taken out before sending takes its reference with it, though undo could have brought it back.
      await input.fill('不带文件 ')
      await page.keyboard.type('@vitest')
      await page.getByRole('listbox', { name: '引用项目文件', exact: true }).getByRole('option').filter({ hasText: FILE }).first().waitFor()
      await page.keyboard.press('Enter')
      await expect.poll(() => chips(input)).toEqual([['file', FILE, '']])
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Backspace')
      expect(await promptValue(input)).toBe('不带文件 ')
      await page.keyboard.press(`${engine === 'webkit' || process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
      await expect.poll(() => chips(input)).toEqual([['file', FILE, '']])
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Backspace')
      await page.keyboard.type('就这样')
      await input.press('Control+Enter')
      await expect
        .poll(async () => (await detail()).messages.filter(message => message.role === 'user' && message.text === '不带文件 就这样').length)
        .toBe(1)
      expect((await detail()).messages.findLast(message => message.role === 'user')?.fileRefs ?? []).toEqual([])
      await expect.poll(async () => (await detail()).summary.status).toBe('idle')
      await page.close()
      for (const [width, theme] of [
        [1440, 'light'],
        [1440, 'dark'],
        [390, 'light'],
        [390, 'dark'],
      ] as const) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
        const view = await context.newPage()
        try {
          await enrollBrowser(view, host)
          await connected(view)
          await openSession(view, sessionId)
          const shown = view.locator('.user-bubble').filter({ hasText: '写一个页面' }).last()
          await shown.locator('.prompt-chip').first().waitFor()
          await view.evaluate(() => document.fonts.ready)
          await shown.screenshot({ path: `${output}/sent-${width}-${theme}.png`, animations: 'disabled' })
        } finally {
          await context.close()
        }
      }
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
  },
  240_000,
)
