import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

interface ResponseGate {
  marker: string
  seen: Promise<void>
  waiting: Promise<void>
  entered(): void
  failed(): void
  release(): void
  claimed: boolean
}

function responseGate(marker: string): ResponseGate {
  let entered!: () => void
  let release!: () => void
  let failed!: () => void
  const seen = new Promise<void>((resolve, reject) => {
    entered = resolve
    failed = () => reject(new Error('Controlled upstream gate failed'))
  })
  void seen.catch(() => {})
  return {
    marker,
    seen,
    waiting: new Promise(resolve => {
      release = resolve
    }),
    entered: () => entered(),
    failed: () => failed(),
    release: () => release(),
    claimed: false,
  }
}

const binary = process.env.LATCH_PI_GATEWAY_BINARY
it.skipIf(process.env.LATCH_SLASH_LIVE !== '1' || !binary)(
  'discovers and invokes real pi public commands while keeping extension and skill steering distinct',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-pi-commands-ui-'))
    let service: Awaited<ReturnType<typeof startFakeModels>> | undefined
    let host: Awaited<ReturnType<typeof startTestHost>> | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    let proxy: ReturnType<typeof createServer> | undefined
    const gates: ResponseGate[] = []
    const pending = new Set<Promise<void>>()
    const proxyErrors: string[] = []
    const appendProofs: Array<{ command: string; runId: string | undefined; steered: boolean; sameRun: boolean }> = []
    let inspect: (() => Promise<TaskDetail>) | undefined
    const output = 'test-results/pi-commands-live'
    try {
      for (const name of ['HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
        const path = join(root, name.toLowerCase())
        await mkdir(path)
        vi.stubEnv(name, path)
      }
      const agentDirectory = process.env.PI_CODING_AGENT_DIR!
      await mkdir(join(agentDirectory, 'extensions'), { recursive: true })
      await mkdir(join(agentDirectory, 'prompts'), { recursive: true })
      await mkdir(join(agentDirectory, 'skills/public-note'), { recursive: true })
      await writeFile(
        join(agentDirectory, 'extensions/public-note.ts'),
        `export default function(pi) {
        pi.registerCommand('public-note', { description: '显示公开记录', handler: async (args, ctx) => {
          ctx.ui.notify('公共命令已执行：' + args, 'info')
        } })
      }`,
      )
      await writeFile(
        join(agentDirectory, 'prompts/plan-note.md'),
        '---\ndescription: 展开计划模板\n---\nPUBLIC_TEMPLATE_BODY $ARGUMENTS\n',
      )
      await writeFile(
        join(agentDirectory, 'skills/public-note/SKILL.md'),
        '---\nname: public-note\ndescription: 读取公开技能说明\n---\nPUBLIC_SKILL_BODY\n',
      )
      const userText = (body: unknown) => {
        const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
        return JSON.stringify(messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
      }
      service = await startFakeModels({
        replyFor: request => {
          const content = userText(request.body)
          return content.includes('HOLD_PUBLIC')
            ? { text: 'Waiting completed.' }
            : {
                text: content.includes('PUBLIC_SKILL_BODY')
                  ? '技能内容已收到。'
                  : content.includes('PUBLIC_TEMPLATE_BODY')
                    ? '模板内容已收到。'
                    : 'Ready.',
              }
        },
      })
      // Hold actual fake-upstream responses, not a timer: both the held turn and its expanded addition stay observable.
      proxy = createServer((request, response) => {
        const controller = new AbortController()
        request.once('aborted', () => controller.abort())
        response.once('close', () => {
          if (!response.writableEnded) controller.abort()
        })
        let matched: ResponseGate | undefined
        const job = (async () => {
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of request) {
            const bytes = Buffer.from(chunk)
            size += bytes.byteLength
            if (size > 2 * 1024 * 1024) throw new Error('Fixture request too large')
            chunks.push(bytes)
          }
          const body = Buffer.concat(chunks).toString('utf8')
          const text = body ? userText(JSON.parse(body)) : ''
          const gate = gates.find(item => !item.claimed && text.includes(item.marker))
          if (gate) {
            gate.claimed = true
            matched = gate
          }
          const upstream = await fetch(`${service!.origin}${request.url ?? '/'}`, {
            method: request.method,
            headers: {
              'content-type': 'application/json',
              ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
            },
            ...(body ? { body } : {}),
            signal: controller.signal,
          })
          if (gate) {
            gate.entered()
            await Promise.race([
              gate.waiting,
              new Promise<void>(resolve => {
                if (controller.signal.aborted) resolve()
                else controller.signal.addEventListener('abort', () => resolve(), { once: true })
              }),
            ])
          }
          if (controller.signal.aborted || response.destroyed) {
            await upstream.body?.cancel()
            return
          }
          response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
          response.end(Buffer.from(await upstream.arrayBuffer()))
        })()
          .catch(() => {
            matched?.failed()
            if (!controller.signal.aborted) proxyErrors.push('Controlled upstream request failed')
            if (!response.destroyed) {
              if (!response.headersSent) response.writeHead(502).end('Controlled upstream unavailable')
              else response.destroy()
            }
          })
          .finally(() => pending.delete(job))
        pending.add(job)
      })
      await new Promise<void>((resolve, reject) => {
        proxy!.once('error', reject)
        proxy!.listen(0, '127.0.0.1', resolve)
      })
      const proxyOrigin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
      host = await startTestHost({
        demo: false,
        dataDir: join(root, 'data'),
        workspaceRoot: join(root, 'project'),
        uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
        commandDirectories: () => [dirname(binary!)],
        loginPrograms: name => (name === 'pi' ? binary : undefined),
        detectPreset: preset => (preset.id === 'pi' ? { found: true, path: binary! } : { found: false }),
      })
      const owner = await host.enroll({ listener: 'unix' })
      expect(
        (
          await owner.confirmed('providers', {
            method: 'POST',
            body: {
              name: 'Local command fixture',
              kind: 'openai-compatible',
              baseURL: `${proxyOrigin}/v1`,
              apiKey: 'sk-test-commands-local-only',
              models: ['gpt-5.5'],
              defaultModel: 'gpt-5.5',
              confirmOrigin: true,
            },
          })
        ).status,
      ).toBe(201)
      expect(
        (
          await owner.confirmed('agents', {
            method: 'POST',
            body: {
              id: 'pi',
              name: 'pi',
              presetId: 'pi',
              command: 'pi',
              args: [],
              env: { PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' },
            },
          })
        ).status,
      ).toBe(201)
      browser = await chromium.launch(browserLaunchOptions())
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      await mkdir(output, { recursive: true })
      try {
        await enrollBrowser(page, host)
        await connected(page)
        await page
          .getByRole('button', { name: /^模型：/u })
          .filter({ visible: true })
          .first()
          .click()
        await page.getByRole('menu', { name: '模型', exact: true }).getByRole('menuitemradio', { name: 'gpt-5.5', exact: true }).click()
        const first = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await first.fill('Remember the public plan: check the heading, then report.')
        await first.press('Meta+Enter')
        await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(1)
        const id = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!.id
        const detail = () => owner.json<TaskDetail>(`tasks/${id}`)
        inspect = detail
        await page.locator('.transcript').getByText('Ready.', { exact: true }).waitFor()
        await expect.poll(async () => (await detail()).summary.status).toBe('idle')
        const commands = (await detail()).commands!
        expect(commands).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'public-note', idleOnly: true }),
            expect.objectContaining({ name: 'plan-note' }),
            expect.objectContaining({ name: 'skill:public-note' }),
          ]),
        )
        expect(commands.find(command => command.name === 'skill:public-note')?.idleOnly).toBeUndefined()
        expect(commands.some(command => command.name.startsWith('latch-permission'))).toBe(false)
        expect(JSON.stringify(commands)).not.toContain(agentDirectory)
        expect((await detail()).skills).toContainEqual(expect.objectContaining({ name: 'public-note', invocation: '/skill:public-note' }))
        expect((await detail()).skills?.every(skill => skill.description === undefined)).toBe(true)
        expect(JSON.stringify((await detail()).skills)).not.toContain(agentDirectory)
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        const list = page.getByRole('listbox', { name: '命令与提示模板', exact: true })
        for (const [width, theme] of [
          [1440, 'light'],
          [768, 'dark'],
          [390, 'dark'],
        ] as const) {
          await page.setViewportSize({ width, height: 1000 })
          await page.emulateMedia({ colorScheme: theme })
          await input.fill('/')
          await list.getByRole('option').filter({ hasText: '/skill:public-note' }).waitFor()
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${output}/catalog-${width}-${theme}.png`, animations: 'disabled' })
        }
        const send = async (text: string) => {
          const before = (await detail()).messages.filter(message => message.role === 'user').length
          await input.fill(text)
          await input.press('Meta+Enter')
          await expect.poll(async () => (await detail()).messages.filter(message => message.role === 'user').length).toBe(before + 1)
          await expect.poll(async () => (await detail()).summary.status).toBe('idle')
        }
        const beforeExtension = service.requests.length
        await send('/public-note proof')
        expect(service.requests).toHaveLength(beforeExtension)
        await expect.poll(async () => (await detail()).messages.some(message => message.text.includes('公共命令已执行：proof'))).toBe(true)
        await send('/skill:public-note NORMAL_SKILL')
        expect(userText(service.requests.at(-1)?.body)).toContain('PUBLIC_SKILL_BODY')
        expect(userText(service.requests.at(-1)?.body)).toContain('NORMAL_SKILL')
        await send('/plan-note NORMAL_TEMPLATE')
        expect(userText(service.requests.at(-1)?.body)).toContain('PUBLIC_TEMPLATE_BODY')
        expect(userText(service.requests.at(-1)?.body)).toContain('NORMAL_TEMPLATE')
        await page.screenshot({ path: `${output}/commands-completed-390-dark.png`, animations: 'disabled' })
        for (const command of ['/skill:public-note STEER_SKILL', '/plan-note STEER_TEMPLATE']) {
          const before = service.requests.length
          const held = responseGate('HOLD_PUBLIC')
          const expanded = responseGate(command.includes('skill:') ? 'STEER_SKILL' : 'STEER_TEMPLATE')
          gates.push(held, expanded)
          await input.fill('HOLD_PUBLIC')
          await input.press('Meta+Enter')
          await expect.poll(() => service!.requests.length).toBe(before + 1)
          await held.seen
          const running = await detail()
          expect(running.summary.status).toBe('running')
          expect(running.steer).toBe(true)
          await input.fill('/')
          expect(await list.getByRole('option').filter({ hasText: '/public-note' }).getAttribute('aria-disabled')).toBe('true')
          expect(await list.getByRole('option').filter({ hasText: '/skill:public-note' }).getAttribute('aria-disabled')).toBeNull()
          const queued = await owner.request(`tasks/${id}/prompt`, {
            method: 'POST',
            body: { prompt: '/public-note should-not-run', requestId: randomUUID(), queue: true },
          })
          expect(queued.status).toBe(409)
          expect(await queued.json()).toMatchObject({ error: 'command-queued' })
          if (command.includes('skill:'))
            await page.screenshot({ path: `${output}/running-command-availability-390-dark.png`, animations: 'disabled' })
          await input.fill(command)
          const append = page.getByRole('button', { name: '立即发送', exact: true })
          await append.waitFor()
          const accepted = page.waitForResponse(
            response =>
              response.request().method() === 'POST'
              && new URL(response.url()).pathname === `/link/api/tasks/${id}/prompt`
              && response.request().postDataJSON()?.prompt === command,
          )
          await append.click()
          const receipt = await accepted
          expect(receipt.request().postDataJSON()).toMatchObject({ steer: true, prompt: command })
          expect(receipt.ok()).toBe(true)
          expect(await receipt.json()).toMatchObject({ steered: true })
          const taken = await detail()
          expect(taken.summary).toMatchObject({ status: 'running', runId: running.summary.runId })
          expect(taken.messages.some(message => message.role === 'user' && message.text === command && message.steered)).toBe(true)
          held.release()
          await expect.poll(() => service!.requests.length).toBe(before + 2)
          await expanded.seen
          const continuing = await detail()
          expect(continuing.summary).toMatchObject({ status: 'running', runId: running.summary.runId })
          expect(continuing.queue ?? []).toHaveLength(0)
          expanded.release()
          await expect.poll(async () => (await detail()).summary.status, { timeout: 10_000 }).toBe('idle')
          expect((await detail()).summary.runId).toBe(running.summary.runId)
          appendProofs.push({ command, runId: running.summary.runId, steered: true, sameRun: true })
          const last = userText(service.requests.at(-1)?.body)
          expect(last).toContain(command.includes('skill:') ? 'PUBLIC_SKILL_BODY' : 'PUBLIC_TEMPLATE_BODY')
          expect(last).toContain(command.includes('skill:') ? 'STEER_SKILL' : 'STEER_TEMPLATE')
        }
        expect(proxyErrors).toEqual([])
        await page.screenshot({ path: `${output}/steering-completed-390-dark.png`, animations: 'disabled' })
        await writeFile(
          `${output}/evidence.json`,
          JSON.stringify(
            {
              actualCli: 'pi1.5.0',
              modelUpstream: 'local controlled Chat fixture',
              testPresence: true,
              temporaryHome: true,
              cliStorageReadByTest: false,
              commands,
              requests: service.requests.length,
              appendProofs,
            },
            null,
            2,
          ) + '\n',
        )
      } catch (error) {
        const current = await inspect?.()
        await writeFile(
          `${output}/diagnostic.json`,
          JSON.stringify(
            {
              status: current?.summary.status,
              activity: current?.activity,
              live: current?.summary.live,
              runId: current?.summary.runId,
              steer: current?.steer,
              users: current?.messages
                .filter(message => message.role === 'user')
                .map(message => ({ text: message.text, steered: message.steered })),
              queue: current?.queue,
              appendProofs,
              lastUser: service?.requests.length ? userText(service.requests.at(-1)?.body) : undefined,
              gates: gates.map(gate => ({ marker: gate.marker, claimed: gate.claimed })),
              proxyErrors,
            },
            null,
            2,
          ) + '\n',
        )
        await page.screenshot({ path: `${output}/failure.png`, animations: 'disabled' })
        throw error
      }
    } finally {
      for (const gate of gates) gate.release()
      try {
        await browser?.close()
      } finally {
        try {
          await host?.close()
        } finally {
          try {
            await Promise.allSettled([...pending])
            if (proxy?.listening) {
              proxy.closeAllConnections()
              await new Promise<void>(resolve => proxy!.close(() => resolve()))
            }
            await service?.close()
          } finally {
            vi.unstubAllEnvs()
            await rm(root, { recursive: true, force: true })
          }
        }
      }
    }
  },
)
