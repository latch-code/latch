import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

describe('conversation forks', () => {
  it('opens a selectable new session, folds authoritative context and returns to its source at desktop, tablet and phone widths', async () => {
    const host = await startTestHost({ uiDir: resolve('dist/web') })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const source = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '讨论另一个方案', requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${source.sessionId}`)).summary.status).toBe('idle')
      for (const width of [1440, 768, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 960 },
          reducedMotion: 'reduce',
          colorScheme: width === 390 ? 'dark' : 'light',
        })
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `分叉 ${width}` })
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill('讨论另一个方案')
        await palette.getByRole('option').filter({ hasText: '讨论另一个方案' }).first().click()
        await page.locator('.turn-reply').first().hover()
        await page.getByRole('button', { name: '从这里分叉', exact: true }).first().click()
        await page.getByText('文件不会复制或回滚', { exact: false }).waitFor()
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        expect(await input.inputValue()).toBe('请接着这个会话继续。')
        // What a fork borrows from its source is for this draft: nothing goes into what this device remembers.
        expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('latch.composer.')))).toEqual([])
        await input.fill('请走另一条路')
        if (width === 390)
          await page.getByRole('dialog', { name: '新会话', exact: true }).getByRole('button', { name: '开始', exact: true }).click()
        else await input.press('Enter')
        await page.locator('.fork-context summary').waitFor()
        expect(await page.locator('.fork-context').getAttribute('open')).toBeNull()
        await page.locator('.fork-context summary').click()
        await expect.poll(() => page.locator('.fork-context pre').textContent()).toContain('讨论另一个方案')
        await page.locator('.fork-context summary').click()
        await page.screenshot({ path: `test-results/fork-${width}.png`, fullPage: true })
        await page.getByRole('button', { name: '返回来源会话', exact: true }).click()
        await page.locator('.fork-context').waitFor({ state: 'detached' })
        const snapshot = await owner.json<{ tasks: Array<{ id: string; forkOf?: { taskId: string } }> }>('snapshot')
        const fork = snapshot.tasks.find(task => task.forkOf?.taskId === source.sessionId)
        expect(fork).toBeDefined()
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })

  it('forks the latest turn from the Harness popover onto another Harness, taking the stricter row, and not while it runs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-forks-popover-'))
    const bin = join(directory, 'bin')
    await mkdir(bin)
    for (const [name, env] of [
      ['qwen', 'FAKE_ACP_MODES=plan,default,auto-edit,auto,yolo FAKE_ACP_INITIAL_MODE=default'],
      ['goose', 'FAKE_ACP_MODES=chat,approve,smart_approve,auto FAKE_ACP_INITIAL_MODE=approve'],
    ] as const) {
      await writeFile(
        join(bin, name),
        [
          '#!/bin/sh',
          `export FAKE_ACP_STATE='${join(directory, `${name}.json`)}' FAKE_ACP_LOG='${join(directory, `${name}.log`)}'`,
          `export FAKE_ACP_CONFIG=options ${env}`,
          `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        ].join('\n'),
      )
      await chmod(join(bin, name), 0o755)
    }
    const host = await startTestHost({
      uiDir: resolve('dist/web'),
      sessionFolders: true,
      detectPreset: preset =>
        preset.id === 'qwen' || preset.id === 'goose' ? { found: true, path: join(bin, preset.id) } : { found: false },
      commandDirectories: () => [bin],
    })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      for (const id of ['qwen', 'goose']) {
        const preset = AGENT_PRESETS.find(item => item.id === id)!
        await owner.json('agents', {
          method: 'POST',
          body: { id, name: preset.name, presetId: id, command: preset.command, args: preset.args, env: {}, enabled: true },
        })
      }
      const source = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt: '从弹层分叉',
          requestId: randomUUID(),
          harnessId: 'qwen',
          workspaceId: 'default',
          config: [{ configId: 'mode', value: 'auto-edit' }],
        },
      })
      const status = async () => (await owner.json<TaskDetail>(`tasks/${source.sessionId}`)).summary.status
      await expect.poll(status, { timeout: 30_000 }).toBe('idle')

      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '弹层分叉' })
      await connected(page)
      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByRole('searchbox').fill('从弹层分叉')
      await palette.getByRole('option').filter({ hasText: '从弹层分叉' }).first().click()
      await palette.waitFor({ state: 'hidden' })
      const popover = page.getByRole('dialog', { name: 'Harness', exact: true })
      const forkRow = popover.locator('.harness-fork')
      await page.getByRole('button', { name: 'Harness：Qwen Code', exact: true }).click()
      await forkRow.getByText('从最后一轮分叉，可以换 Harness；文件不会复制或回滚。', { exact: true }).waitFor()
      expect(await forkRow.getAttribute('aria-disabled')).toBeNull()
      await forkRow.click()

      // The new-session page: one notice, the sentence in the input, and the Harness menu open on the source's Harness.
      const notice = page.locator('.ui-notice', { hasText: '正在从' }).first()
      await notice.getByText('正在从「从弹层分叉」分叉。文件不会复制或回滚；同一项目中的会话共用项目文件夹。', { exact: false }).waitFor()
      expect(await page.getByRole('textbox', { name: '新会话消息', exact: true }).inputValue()).toBe('请接着这个会话继续。')
      const menu = page.getByRole('menu', { name: /^Harness/u })
      await menu.waitFor()
      await menu.getByRole('menuitemradio', { name: /goose/u }).click()
      await expect
        .poll(() => notice.locator('.fork-missed').allInnerTexts(), { timeout: 20_000 })
        .toContain('来源会话的权限是「按规则放行」，goose 没有这一项，这里用更严的「先问你」。')
      await expect
        .poll(async () =>
          page
            .getByRole('button', { name: /^权限：/u })
            .first()
            .getAttribute('aria-label'),
        )
        .toContain('先问你')
      await page.screenshot({ path: 'test-results/fork-popover-1440.png' })
      await notice.getByRole('button', { name: '取消分叉', exact: true }).click()

      // While the latest turn runs the Host would refuse the fork: the row stays, off, with why.
      await owner.json(`tasks/${source.sessionId}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
      await expect.poll(status, { timeout: 20_000 }).toBe('running')
      await page.keyboard.press('Meta+k')
      await palette.getByRole('searchbox').fill('从弹层分叉')
      await palette.getByRole('option').filter({ hasText: '从弹层分叉' }).first().click()
      await palette.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Harness：Qwen Code', exact: true }).click()
      await forkRow.getByText('请等这一轮结束后再从这里分叉', { exact: true }).waitFor()
      expect(await forkRow.getAttribute('aria-disabled')).toBe('true')
      await forkRow.dispatchEvent('click')
      expect(await page.locator('.ui-notice', { hasText: '正在从' }).count()).toBe(0)
      await page.screenshot({ path: 'test-results/fork-popover-running-1440.png' })
      await owner.request(`tasks/${source.sessionId}/cancel`, { method: 'POST', body: { requestId: randomUUID() } }).catch(() => {})
      await context.close()
    } finally {
      await browser.close()
      await host.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("keeps the source's model, thinking and row over what the device remembers, and maps them onto another Harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-forks-'))
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const fake = async (name: string, env: string) => {
      await writeFile(
        join(bin, name),
        [
          '#!/bin/sh',
          `export FAKE_ACP_STATE='${join(directory, `${name}.json`)}' FAKE_ACP_LOG='${join(directory, `${name}.log`)}'`,
          `export FAKE_ACP_CONFIG=options ${env}`,
          `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        ].join('\n'),
      )
      await chmod(join(bin, name), 0o755)
    }
    await fake('qwen', 'FAKE_ACP_MODES=plan,default,auto-edit,auto,yolo FAKE_ACP_INITIAL_MODE=default')
    // goose has no 按规则放行 and no large model.
    await fake('goose', 'FAKE_ACP_MODES=chat,approve,smart_approve,auto FAKE_ACP_INITIAL_MODE=approve FAKE_ACP_MODELS=small,medium')
    const found: string[] = []
    const host = await startTestHost({
      uiDir: resolve('dist/web'),
      sessionFolders: true,
      // Only the fakes in this test's folder are ever found.
      detectPreset: preset => {
        if (preset.id !== 'qwen' && preset.id !== 'goose') return { found: false }
        found.push(preset.id)
        return { found: true, path: join(bin, preset.id) }
      },
      commandDirectories: () => [bin],
    })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      for (const id of ['qwen', 'goose']) {
        const preset = AGENT_PRESETS.find(item => item.id === id)!
        await owner.json('agents', {
          method: 'POST',
          body: { id, name: preset.name, presetId: id, command: preset.command, args: preset.args, env: {}, enabled: true },
        })
      }
      const values = async (sessionId: string) => {
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 30_000 }).toBe('idle')
        const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
        return Object.fromEntries((detail.config ?? []).map(option => [option.id, option.currentValue]))
      }
      const source = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt: '换一个方向',
          requestId: randomUUID(),
          harnessId: 'qwen',
          workspaceId: 'default',
          config: [
            { configId: 'mode', value: 'auto-edit' },
            { configId: 'model', value: 'large' },
            { configId: 'effort', value: 'high' },
          ],
        },
      })
      expect(await values(source.sessionId)).toMatchObject({ mode: 'auto-edit', model: 'large', effort: 'high' })

      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '分叉沿用' })
      await connected(page)
      const label = async (name: RegExp) => (await page.getByRole('button', { name }).first().getAttribute('aria-label')) ?? ''
      const pick = (page: Page, name: string) =>
        page
          .getByRole('radio', { name: new RegExp(name, 'u') })
          .or(page.getByRole('menuitemradio', { name: new RegExp(name, 'u') }))
          .first()
      const notice = page.locator('.ui-notice', { hasText: '正在从' }).first()
      // This device remembers a wider row for Qwen Code.
      await page
        .getByRole('button', { name: /^Harness：/u })
        .first()
        .click()
      await pick(page, 'Qwen Code').click()
      await expect.poll(() => label(/^权限：/u), { timeout: 20_000 }).toContain('先问你')
      await page
        .getByRole('button', { name: /^权限：/u })
        .first()
        .click()
      await pick(page, '不再询问').click()
      await expect.poll(() => label(/^权限：/u)).toContain('不再询问')

      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByRole('searchbox').fill('换一个方向')
      await palette.getByRole('option').filter({ hasText: '换一个方向' }).first().click()
      await page.locator('.turn-reply').first().hover()
      await page.getByRole('button', { name: '从这里分叉', exact: true }).first().click()
      await notice.waitFor()
      // The same Harness: the source's row, model and thinking, with nothing to explain.
      expect(await label(/^权限：/u)).toContain('按规则放行')
      expect(await label(/^模型：/u)).toBe('模型：Large')
      expect(await label(/^思考：/u)).toBe('思考：High')
      expect(await notice.locator('.fork-missed').count()).toBe(0)

      // Another Harness: what maps is kept, the row is never wider than the source's, and the draft says what changed.
      await page
        .getByRole('button', { name: /^Harness：/u })
        .first()
        .click()
      // goose's options are read only now: every line the notice shows meanwhile is kept, so a wrong one is caught too.
      expect(
        await owner
          .json<AppSnapshot>('snapshot')
          .then(snapshot => snapshot.catalog?.harnesses.find(item => item.id === 'goose')?.catalogue),
      ).toBeUndefined()
      await page.evaluate(() => {
        const seen: string[] = []
        ;(window as unknown as { forkLines: string[] }).forkLines = seen
        new MutationObserver(() => {
          for (const line of document.querySelectorAll('.fork-missed')) seen.push(line.textContent ?? '')
        }).observe(document.body, { subtree: true, childList: true, characterData: true })
      })
      await pick(page, 'goose').click()
      const mapped = [
        '没有沿用来源会话的模型「Large」：goose 在这里不能选。',
        '来源会话的权限是「按规则放行」，goose 没有这一项，这里用更严的「先问你」。',
      ]
      await expect.poll(() => notice.locator('.fork-missed').allInnerTexts(), { timeout: 20_000 }).toEqual(mapped)
      const shown = new Set(await page.evaluate(() => (window as unknown as { forkLines: string[] }).forkLines))
      expect([...shown].filter(line => !mapped.includes(line))).toEqual([
        '来源会话的模型「Large」、思考「High」与权限「按规则放行」要等读到 goose 的选项后才能沿用。',
      ])
      expect(await label(/^权限：/u)).toContain('先问你')
      await page.screenshot({ path: 'test-results/fork-carry-1280.png', fullPage: true })
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('在 goose 里接着做')
      await input.press('Enter')
      await page.locator('.fork-context summary').waitFor({ timeout: 30_000 })
      const forked = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.forkOf?.taskId === source.sessionId)!
      expect(forked.harnessId).toBe('goose')
      expect(await values(forked.id)).toMatchObject({ mode: 'approve', model: 'small', effort: 'high' })
      // The device still remembers its own wider row for Qwen Code: the fork's were for its draft.
      expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))).toContain('yolo')

      // Qwen Code moves itself from 先问你 to 不再询问 mid-turn: the session it is continued in starts where the person had it.
      const asked = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '先问一下', requestId: randomUUID(), harnessId: 'qwen', workspaceId: 'default' },
      })
      expect(await values(asked.sessionId)).toMatchObject({ mode: 'default' })
      await owner.json(`tasks/${asked.sessionId}/prompt`, { method: 'POST', body: { prompt: 'drift yolo', requestId: randomUUID() } })
      // The turn ends cancelled, and the session reports the mode the agent moved into.
      await expect
        .poll(
          async () => {
            const detail = await owner.json<TaskDetail>(`tasks/${asked.sessionId}`)
            return [
              detail.summary.status,
              detail.summary.permissionDrift,
              detail.config?.find(option => option.id === 'mode')?.currentValue,
            ]
          },
          { timeout: 20_000 },
        )
        .toEqual(['cancelled', true, 'yolo'])
      await page.keyboard.press('Meta+k')
      await palette.getByRole('searchbox').fill('先问一下')
      await palette.getByRole('option').filter({ hasText: '先问一下' }).first().click()
      await palette.waitFor({ state: 'hidden' })
      await page.getByText('这个 Harness 的设置变了，为了安全换个新会话继续', { exact: true }).waitFor()
      await page.getByRole('button', { name: '在新会话中继续', exact: true }).click()
      await notice.waitFor()
      await expect.poll(() => label(/^权限：/u)).toContain('先问你')
      expect(await notice.locator('.fork-missed').count()).toBe(0)
      await page.screenshot({ path: 'test-results/fork-drift-1280.png', fullPage: true })
      await input.fill('换个会话接着问')
      await input.press('Enter')
      await expect
        .poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.forkOf?.taskId === asked.sessionId)?.id, {
          timeout: 30_000,
        })
        .toBeDefined()
      const continued = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.forkOf?.taskId === asked.sessionId)!
      expect(await values(continued.id)).toMatchObject({ mode: 'default' })

      // A session that only chats, forked to a Harness that always works on files: the draft starts at its default row, not
      // at the wider one this device remembers, and says so.
      const chat = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '只聊一聊', requestId: randomUUID(), harnessId: 'standard', mode: 'chat' },
      })
      await expect
        .poll(async () => (await owner.json<TaskDetail>(`tasks/${chat.sessionId}`)).summary.status, { timeout: 30_000 })
        .toBe('idle')
      await page.keyboard.press('Meta+k')
      await palette.getByRole('searchbox').fill('只聊一聊')
      await palette.getByRole('option').filter({ hasText: '只聊一聊' }).first().click()
      await palette.waitFor({ state: 'hidden' })
      await page.locator('.turn-reply').first().hover()
      await page.getByRole('button', { name: '从这里分叉', exact: true }).first().click()
      await notice.waitFor()
      await page
        .getByRole('button', { name: /^Harness：/u })
        .first()
        .click()
      await pick(page, 'Qwen Code').click()
      await expect
        .poll(() => notice.locator('.fork-missed').allInnerTexts(), { timeout: 20_000 })
        .toContain('来源会话不读写文件，Qwen Code 没有这一项，这里从它默认的那一项开始。')
      expect(await label(/^权限：/u)).toContain('先问你')
      await page.screenshot({ path: 'test-results/fork-chat-1280.png', fullPage: true })
      await context.close()
      expect(found.toSorted()).toEqual(expect.arrayContaining(['goose', 'qwen']))
      expect(await readFile(join(directory, 'goose.log'), 'utf8')).toContain('session/prompt')
    } finally {
      await browser.close()
      await host.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
