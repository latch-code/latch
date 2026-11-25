import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSession } from './helpers/layout.ts'
import { promptValue, setPromptSelection } from './helpers/prompt.ts'

const passage = 'Keep the original\nrevision.'

it.each([
  { width: 1440, height: 960 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
])('references authorized work and returns to a quoted passage at $width px', async ({ width, height }) => {
  const host = await startTestHost({
    providerId: 'reference-ui',
    plugins: [
      {
        id: 'reference-fixture',
        name: 'References',
        version: '1',
        description: '',
        activate(context) {
          context.registerProvider({
            id: 'reference-ui',
            name: 'References',
            model: 'fake',
            async *stream() {
              yield { type: 'text', text: `First result. ${passage} Last result.` }
              yield { type: 'finish', reason: 'stop' }
            },
          })
        },
      },
    ],
  })
  const browser = await chromium.launch({ ...browserLaunchOptions(), args: ['--enable-caret-browsing'] })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    async function start(prompt: string) {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt, workspaceId: 'default', mode: 'agent' },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      return sessionId
    }
    const source = await start('Earlier investigation')
    const target = await start('Resume work')
    await owner.json(`tasks/${source}`, { method: 'PATCH', body: { title: 'Last week review' } })
    const page = await browser.newPage({
      viewport: { width, height },
      hasTouch: width === 390,
      colorScheme: width === 390 ? 'dark' : 'light',
      reducedMotion: 'reduce',
    })
    page.setDefaultTimeout(10000)
    const shots = 'test-results/conversation-references'
    await mkdir(shots, { recursive: true })
    const capture = async (step: string, prepare?: () => Promise<void>) => {
      await prepare?.()
      await page.screenshot({ path: `${shots}/${step}-${width}.png`, animations: 'disabled' })
    }
    await enrollBrowser(page, host, { name: '会话上下文' })
    await openSession(page, target)
    await page.locator('.attachment-button:visible').click()
    await page.getByText('引用另一条会话', { exact: true }).click()
    const picker = page.getByRole('dialog', { name: '引用另一条会话' })
    await picker.getByRole('searchbox', { name: '搜索会话标题' }).fill('week')
    await capture('picker', () => picker.getByRole('button', { name: 'Last week review' }).waitFor())
    await picker.getByRole('button', { name: 'Last week review' }).click()
    const input = page.locator('.composer .cm-content:visible')
    await expect.poll(() => promptValue(input)).toContain('[conversation-ref:')
    expect(await promptValue(input)).not.toContain(passage)
    await input.locator('.prompt-chip[data-kind=conversation] .prompt-chip-label').filter({ hasText: 'Last week review' }).waitFor()
    await capture('draft', () => input.locator('.prompt-chip[data-kind=conversation]').waitFor())
    await input.press('Meta+Enter')
    await expect
      .poll(async () =>
        (await owner.json<TaskDetail>(`tasks/${target}`)).messages.some(m => m.role === 'user' && m.text.includes('[conversation-ref:')),
      )
      .toBe(true)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${target}`)).summary.status).toBe('idle')
    const reply = page.locator('.message-assistant:not(.is-live) .message-text p').first()
    const action = page.getByRole('button', { name: '引用这句话', exact: true })
    const selected = () =>
      page.evaluate(() => {
        const selection = document.getSelection()
        return selection?.rangeCount ? selection.getRangeAt(0).toString() : ''
      })
    await reply.scrollIntoViewIfNeeded()
    // A programmatic highlight can run in the click immediately after pointerup.
    await reply.evaluate(node => {
      node.addEventListener('click', () => document.getSelection()!.setBaseAndExtent(node.firstChild!, 0, node.firstChild!, 5), {
        once: true,
      })
    })
    await reply.click()
    expect(await selected()).toBe('First')
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await action.isVisible()).toBe(false)

    if (width === 390) {
      // The OS normally chooses the word on a long press. Reproduce its selection and pointer handoff explicitly.
      for (const end of ['touchcancel', 'touchend'] as const) {
        await reply.evaluate(node => {
          const selection = document.getSelection()!
          selection.removeAllRanges()
          const touch = new Touch({ identifier: 1, target: node })
          node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch] }))
          node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'touch' }))
          selection.setBaseAndExtent(node.firstChild!, 0, node.firstChild!, 5)
        })
        expect(await action.isVisible()).toBe(false)
        await reply.dispatchEvent(end)
        await expect.poll(() => action.isVisible()).toBe(end === 'touchend')
      }
    }

    await reply.click()
    await reply.evaluate(node => document.getSelection()!.collapse(node.firstChild!, 0))
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowRight')
    await expect.poll(selected).toBe('F')
    expect(await action.isVisible()).toBe(false)
    await page.keyboard.up('Shift')
    await action.waitFor()

    const points = await reply.evaluate((node, phrase) => {
      const text = node.firstChild!
      const start = text.textContent!.indexOf(phrase)
      const point = (index: number) => {
        const range = document.createRange()
        range.setStart(text, index)
        range.collapse(true)
        const bounds = range.getBoundingClientRect()
        return { x: bounds.left, y: bounds.top + bounds.height / 2 }
      }
      return { start: point(start), middle: point(start + 'Keep the'.length), end: point(start + phrase.length) }
    }, passage)
    await page.mouse.move(points.start.x, points.start.y)
    await page.mouse.down()
    expect(await action.isVisible()).toBe(false)
    await page.mouse.move(points.middle.x, points.middle.y, { steps: 6 })
    await expect.poll(selected).toBe('Keep the')
    // Someone can pause to read with the button still down. Even a settled selection must stay unobstructed.
    await page.waitForTimeout(350)
    expect(await action.isVisible()).toBe(false)
    await page.mouse.move(points.end.x, points.end.y, { steps: 6 })
    await expect.poll(selected).toBe(passage)
    expect(await action.isVisible()).toBe(false)
    await page.mouse.up()
    await action.waitFor()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(colorScheme)
      const alpha = await action.evaluate(button => {
        const canvas = document.createElement('canvas').getContext('2d')!
        for (const surface of [button.closest('.reply-quote-action')!, button]) {
          canvas.fillStyle = getComputedStyle(surface).backgroundColor
          canvas.fillRect(0, 0, 1, 1)
        }
        return canvas.getImageData(0, 0, 1, 1).data[3]
      })
      expect(alpha).toBe(255)
      await capture(`quote-action-${colorScheme}`)
      if (width === 1440 && colorScheme === 'dark') {
        const clip = await action.evaluate(button => {
          const control = button.getBoundingClientRect()
          const text = document.getSelection()!.getRangeAt(0).cloneRange()
          text.selectNodeContents(text.commonAncestorContainer)
          const paragraph = text.getBoundingClientRect()
          const x = Math.max(0, Math.min(control.left, paragraph.left) - 20)
          const y = Math.max(0, Math.min(control.top, paragraph.top) - 20)
          return {
            x,
            y,
            width: Math.min(innerWidth, Math.max(control.right, paragraph.right) + 20) - x,
            height: Math.min(innerHeight, Math.max(control.bottom, paragraph.bottom) + 20) - y,
          }
        })
        await page.screenshot({ path: `${shots}/quote-action-detail-dark.png`, clip, animations: 'disabled' })
      }
    }
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
    // Scrolling a settled selection keeps its action available.
    await page.locator('.transcript:visible').first().dispatchEvent('scroll')
    if (width === 390) await action.tap()
    else await action.click()
    const quotedText = '> Keep the original\n> revision.'
    await expect.poll(() => promptValue(input)).toContain(quotedText)
    const chip = input.locator('.prompt-chip[data-kind=quote]')
    await chip.locator('.prompt-chip-icon svg.lucide-quote').waitFor()
    expect((await chip.locator('.prompt-chip-label').innerText()).replace(/\s+/gu, ' ')).toBe(passage.replace('\n', ' '))
    expect(await chip.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    const outsideChip = await input.evaluate(element => {
      const copy = element.cloneNode(true) as HTMLElement
      copy.querySelector('.prompt-chip[data-kind=quote]')?.remove()
      return copy.textContent ?? ''
    })
    expect(outsideChip.trim()).toBe('')
    const reference = await promptValue(input)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    const undo = `${modifier}+z`
    // Immediately after quoting, the focused caret can delete the entire item and its generated separator.
    await page.keyboard.press('Backspace')
    expect(await promptValue(input)).toBe('')
    expect(await chip.count()).toBe(0)
    await page.keyboard.press(undo)
    expect(await promptValue(input)).toBe(reference)
    expect(await chip.count()).toBe(1)
    await page.keyboard.press(undo)
    expect(await promptValue(input)).toBe('')
    await page.keyboard.press(`${modifier}+Shift+z`)
    expect(await promptValue(input)).toBe(reference)
    const followUp = '请按这两行继续检查。'
    await page.keyboard.insertText(followUp)
    const draft = await promptValue(input)
    expect(draft).toBe(reference + followUp)
    const composer = page.locator('form.composer:visible')
    await composer.screenshot({ path: `${shots}/quote-draft-${width}.png`, animations: 'disabled', caret: 'hide' })
    if (width === 1440) {
      await page.emulateMedia({ colorScheme: 'dark' })
      await composer.screenshot({ path: `${shots}/quote-draft-dark-1440.png`, animations: 'disabled', caret: 'hide' })
      await page.emulateMedia({ colorScheme: 'light' })
    }
    await setPromptSelection(input, reference.length)
    await input.press('ArrowLeft')
    await input.press('Delete')
    expect(await chip.count()).toBe(0)
    expect(await promptValue(input)).toBe(followUp)
    await input.press(undo)
    expect(await promptValue(input)).toBe(draft)
    expect(await chip.count()).toBe(1)
    const code = draft.split('\n')[0]! + '\n> Example markup'
    const message = draft + '\n```text\n' + code + '\n```'
    await input.fill(message)
    await expect.poll(() => input.locator('.prompt-chip[data-kind=quote]').count()).toBe(1)
    await input.press('Meta+Enter')
    const sent = page.locator('.message-user').last()
    const sourceLink = sent.getByRole('button', { name: '查看引用原文', exact: true })
    await sourceLink.waitFor()
    expect((await owner.json<TaskDetail>(`tasks/${target}`)).messages).toContainEqual(
      expect.objectContaining({ role: 'user', text: message }),
    )
    expect(await sent.locator('pre.user-code').textContent()).toBe(code)
    await page.reload()
    await sourceLink.click()
    await expect.poll(selected).toBe(passage)
    await capture('passage', async () => {
      await sourceLink.click()
      await expect.poll(selected).toBe(passage)
    })
    expect(await action.isVisible()).toBe(false)
    expect(await sourceLink.evaluate(button => document.activeElement === button)).toBe(true)
    await page.keyboard.press('Shift+ArrowRight')
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await selected()).toBe(passage)
    expect(await action.isVisible()).toBe(false)
  } finally {
    await browser.close()
    await host.close()
  }
})
