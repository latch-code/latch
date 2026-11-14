import { chromium, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPreset, AppSnapshot, CancelReceipt, CustomAgentList, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

const enabled = process.env.LATCH_HELPER_LIVE === '1'
const variants = [
  { id: 'pi', label: 'pi', person: '阿澄', binary: process.env.LATCH_PI_GATEWAY_BINARY, args: [] },
  { id: 'codex', label: 'Codex', person: '小林', binary: process.env.LATCH_CODEX_GATEWAY_BINARY, args: [] },
  { id: 'opencode', label: 'OpenCode', person: '青禾', binary: process.env.LATCH_OPENCODE_GATEWAY_BINARY, args: ['acp'] },
] as const
const NOTE = '家里的第一条笔记。\n'
const TITLE = '春日计划'
afterEach(() => vi.unstubAllEnvs())

async function personOnly(page: Page) {
  expect(await page.locator('.agent-frame .agent-boundary-trigger').filter({ visible: true }).count()).toBe(1)
  expect(await page.locator('.transcript .session-start-note').filter({ hasText: '不隔离' }).count()).toBe(0)
  const text = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.topbar, .agent-chat-title, .transcript, .composer, .agent-delegate')]
      .filter(element => element.checkVisibility() && !element.closest('[inert], [aria-hidden="true"]'))
      .map(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const words: string[] = []
        while (walker.nextNode()) {
          const parent = walker.currentNode.parentElement
          if (
            !parent?.checkVisibility()
            || parent.closest(
              '.message-content, .user-bubble-text, .reasoning-text, [popover], .sr-only, [inert], [aria-hidden="true"], [hidden]',
            )
          )
            continue
          words.push(walker.currentNode.textContent ?? '')
        }
        return words.join('')
      })
      .join('\n'),
  )
  expect(text).not.toMatch(/Harness|Codex|OpenCode|\bpi\b|模型|引擎|tokens|gpt-5\.5/u)
  expect(await page.locator('[data-composer-control]').filter({ visible: true }).count()).toBe(0)
}

async function capture(page: Page, file: string) {
  await page.evaluate(() => document.fonts.ready)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: file, animations: 'disabled' })
}

for (const variant of variants)
  it.skipIf(!enabled || !variant.binary)(
    `creates ${variant.label} as a helper through the normal page and uses its actual home and local web tool`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), `latch-helper-live-${variant.id}-`))
      const cleanup: Array<() => Promise<unknown>> = []
      try {
        for (const [key, leaf] of Object.entries({
          HOME: 'home',
          XDG_CONFIG_HOME: 'config',
          XDG_DATA_HOME: 'data',
          XDG_CACHE_HOME: 'cache',
          XDG_STATE_HOME: 'state',
          CODEX_HOME: 'codex',
          PI_CODING_AGENT_DIR: 'pi',
        })) {
          const path = join(root, leaf)
          await mkdir(path)
          vi.stubEnv(key, path)
        }
        const output = join('test-results', 'helper-live', variant.id)
        await mkdir(output, { recursive: true })
        let pageRequests = 0
        const site = createServer((_request, response) => {
          pageRequests++
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end(
            `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title></head><body><h1>只供本轮验收的页面</h1></body></html>`,
          )
        })
        cleanup.unshift(async () => {
          site.closeAllConnections()
          await new Promise<void>(resolve => site.close(() => resolve()))
        })
        await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
        const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`
        let phase: 'notes' | 'web' | 'hold' | 'recovered' = 'notes'
        let step = 0
        let holding = false
        let recoveredHistory = false
        const toolNames = new Set<string>()
        const usedTools: Array<{ phase: string; name: string }> = []
        const toolResults: string[] = []
        const upstream = await startFakeModels({
          replyFor: request => {
            const body = request.body as {
              tools?: Array<{ function?: { name: string; parameters?: { properties?: Record<string, unknown> } } }>
              messages?: Array<{ role?: string; content?: unknown }>
            }
            const offered = (body.tools ?? []).flatMap(item => (item.function ? [item.function] : []))
            for (const tool of offered) toolNames.add(tool.name)
            if (!offered.length) return { text: '家里的笔记' }
            if (phase === 'hold') {
              holding = true
              return { text: '等待停止', delayMs: 5000 }
            }
            if (phase === 'recovered') {
              const priorTools = (body.messages ?? []).filter(item => item.role === 'tool').map(item => JSON.stringify(item.content))
              recoveredHistory = priorTools.some(value => value.includes('NOTE_WRITTEN')) && priorTools.some(value => value.includes(TITLE))
              return { text: recoveredHistory ? '我还在，家里的笔记保留着。' : '没有收到此前的话题记录。' }
            }
            if (step++ > 0) {
              const results = (body.messages ?? []).filter(item => item.role === 'tool').map(item => JSON.stringify(item.content))
              toolResults.push(...results)
              return {
                text:
                  phase === 'notes'
                    ? '已在家里写好 notes.md。'
                    : results.some(value => value.includes(TITLE))
                      ? `网页标题是「${TITLE}」。`
                      : '这次没有取得网页标题。',
              }
            }
            const tool = offered.find(item => item.parameters?.properties?.cmd || item.parameters?.properties?.command)
            if (!tool) return { error: { status: 400, message: 'This helper did not offer a command tool' } }
            usedTools.push({ phase, name: tool.name })
            const command =
              phase === 'notes'
                ? `python3 -c 'from pathlib import Path; Path("notes.md").write_text("家里的第一条笔记。\\n", encoding="utf-8"); print("NOTE_WRITTEN")'`
                : `python3 -c 'import re,urllib.request; print(re.search(r"<title>(.*?)</title>",urllib.request.urlopen("${url}",timeout=5).read().decode("utf-8")).group(1))'`
            return {
              tool: {
                name: tool.name,
                input: tool.parameters?.properties?.cmd
                  ? {
                      cmd: command,
                      yield_time_ms: 1000,
                      max_output_tokens: 200,
                      ...(tool.parameters.properties.sandbox_permissions
                        ? {
                            sandbox_permissions: 'require_escalated',
                            justification: phase === 'notes' ? '写本次帮手家里的 notes.md' : '读取本次受控本地页面标题',
                          }
                        : {}),
                    }
                  : {
                      command,
                      description: phase === 'notes' ? '写家里的 notes.md' : '读取本地网页标题',
                      timeout: variant.id === 'pi' ? 10 : 10_000,
                    },
              },
            }
          },
        })
        cleanup.unshift(() => upstream.close())
        const hostOptions = {
          demo: false,
          dataDir: join(root, 'host'),
          workspaceRoot: join(root, 'workspace'),
          commandDirectories: () => [dirname(variant.binary!)],
          loginPrograms: (name: string) => (name === variant.id ? variant.binary : undefined),
          detectPreset: (preset: AgentPreset) => (preset.id === variant.id ? { found: true, path: variant.binary! } : { found: false }),
        }
        let host = await startTestHost(hostOptions)
        cleanup.unshift(() => host.close())
        const port = Number(new URL(host.host.loopbackOrigin).port)
        let owner = await host.enroll({ listener: 'unix' })
        const browser = await chromium.launch(browserLaunchOptions())
        cleanup.unshift(() => browser.close())
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
        cleanup.unshift(() => context.close())
        const page = await context.newPage()
        page.setDefaultTimeout(20_000)
        const approvals: Array<{ phase: string; id: string }> = []
        try {
          const provider = await owner.confirmedJson<{ provider: ProviderSettings }>('providers', {
            method: 'POST',
            body: {
              name: '临时模型服务',
              kind: 'openai-compatible',
              baseURL: `${upstream.origin}/v1`,
              apiKey: 'sk-test-helper-live-0123456789',
              models: ['gpt-5.5'],
              defaultModel: 'gpt-5.5',
              modelCapabilities: { 'gpt-5.5': { thinking: ['none', 'low', 'medium', 'high', 'xhigh'] } },
              confirmOrigin: true,
            },
          })
          await owner.confirmedJson('agents', {
            method: 'POST',
            body: {
              id: variant.id,
              name: variant.label,
              presetId: variant.id,
              command: variant.binary!,
              args: [...variant.args],
              env: variant.id === 'pi' ? { PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' } : {},
            },
          })
          await enrollBrowser(page, host, { name: `帮手实际流程-${variant.id}` })
          const device = host.host.security.devices.list().find(item => item.name === `帮手实际流程-${variant.id}`)!
          await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
          await page.reload()
          await connected(page)
          await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
          await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
          await page.getByRole('heading', { name: '你想让谁成为你的帮手？', exact: true }).waitFor()
          await capture(page, join(output, 'choose-1440-light.png'))
          await page.getByRole('list', { name: '候选' }).getByRole('button', { name: variant.label, exact: true }).click()
          const form = page.getByRole('form', { name: '新建 Agent' })
          await form.getByLabel('名字', { exact: true }).fill(variant.person)
          await form.getByRole('button', { name: '更多', exact: true }).click()
          await form.getByText('它自己的默认', { exact: true }).waitFor()
          await capture(page, join(output, 'about-1440-light.png'))
          await form.getByRole('button', { name: '创建', exact: true }).click()
          const input = () =>
            page
              .getByRole('textbox', { name: `给${variant.person}发消息`, exact: true })
              .or(page.getByRole('textbox', { name: '继续对话', exact: true }))
              .filter({ visible: true })
          await input().waitFor()
          const agent = (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.name === variant.person)!
          expect(agent.harnessId).toBe(variant.id)
          expect(agent.model).toBeUndefined()
          await personOnly(page)
          await capture(page, join(output, 'created-1440-light.png'))
          // Native helpers start with their own default; the normal profile settings expose their service route.
          await page
            .getByRole('button', { name: `${variant.person} 的资料`, exact: true })
            .filter({ visible: true })
            .click()
          const panel = page.getByRole('region', { name: `${variant.person} 的资料`, exact: true })
          await panel.getByRole('button', { name: '设置', exact: true }).click()
          await panel.locator('button.model-picker').click()
          const picker = page.getByRole('menu', { name: '模型', exact: true }).or(page.getByRole('dialog', { name: '模型', exact: true }))
          await picker
            .getByRole('group', { name: /临时模型服务/u })
            .getByRole('menuitemradio', { name: 'gpt-5.5', exact: true })
            .click()
          await panel.getByRole('button', { name: '保存', exact: true }).click()
          await expect
            .poll(async () => (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)?.model)
            .toMatchObject({ providerId: provider.provider.id, model: 'gpt-5.5' })
          await capture(page, join(output, 'service-settings-1440-light.png'))
          await page.getByRole('button', { name: '关闭资料', exact: true }).filter({ visible: true }).click()
          const topics = async () =>
            (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
          let sessionId = ''
          const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
          const send = async (prompt: string) => {
            step = 0
            await input().fill(prompt)
            const expectedPath = sessionId ? `/link/api/tasks/${sessionId}/prompt` : '/link/api/tasks'
            const submitted = page.waitForResponse(
              response => response.request().method() === 'POST' && new URL(response.url()).pathname === expectedPath,
            )
            await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
            const response = await submitted
            expect(response.ok()).toBe(true)
            await expect.poll(async () => (await topics()).length, { timeout: 20_000 }).toBe(1)
            const nextId = (await topics())[0]!.id
            if (sessionId) expect(nextId).toBe(sessionId)
            else sessionId = nextId
            await expect
              .poll(
                async () => {
                  const current = await detail()
                  for (const approval of current.approvals) {
                    if (approvals.some(item => item.id === approval.id)) continue
                    const card = page.locator(`[data-approval-id="${approval.id}"]`).filter({ visible: true })
                    const allow = card.getByRole('button', { name: /^允许(?:这次|一次)?$/u })
                    await expect.poll(() => allow.isEnabled()).toBe(true)
                    await personOnly(page)
                    await capture(page, join(output, `${phase}-approval-${approvals.length}.png`))
                    approvals.push({ phase, id: approval.id })
                    await allow.click()
                  }
                  return ['idle', 'failed', 'cancelled', 'interrupted'].includes(current.summary.status)
                },
                { timeout: 60_000, interval: 100 },
              )
              .toBe(true)
            const current = await detail()
            expect(
              current.summary.runOutcome,
              JSON.stringify(current.messages.filter(message => message.role === 'system').map(message => message.text)),
            ).toBe('completed')
            const reply =
              phase === 'notes' ? '已在家里写好 notes.md。' : phase === 'web' ? `网页标题是「${TITLE}」。` : '我还在，家里的笔记保留着。'
            await page.locator('.transcript').getByText(reply, { exact: true }).waitFor()
          }
          await send('请在家里写一个 notes.md，内容是“家里的第一条笔记。”')
          const home = join(host.workspaceRoot, 'helpers', agent.id)
          expect((await stat(home)).mode & 0o777).toBe(0o700)
          expect(await readFile(join(home, 'notes.md'), 'utf8')).toBe(NOTE)
          await expect(stat(join(host.workspaceRoot, 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' })
          await personOnly(page)
          await capture(page, join(output, 'notes-done-1440-light.png'))
          phase = 'web'
          await send(`请查一下这个本地页面的标题：${url}`)
          expect(pageRequests).toBeGreaterThan(0)
          expect(toolResults.some(value => value.includes(TITLE))).toBe(true)
          await page.locator('.transcript').getByText(`网页标题是「${TITLE}」。`, { exact: true }).waitFor()
          for (const [width, colorScheme] of [
            [1440, 'light'],
            [1440, 'dark'],
            [768, 'light'],
            [768, 'dark'],
            [390, 'light'],
            [390, 'dark'],
          ] as const) {
            await page.setViewportSize({ width, height: 1000 })
            await page.emulateMedia({ colorScheme })
            await personOnly(page)
            await capture(page, join(output, `web-title-${width}-${colorScheme}.png`))
          }
          await page.setViewportSize({ width: 1440, height: 1000 })
          await page.emulateMedia({ colorScheme: 'light' })
          phase = 'hold'
          await input().fill('请等我叫停。')
          await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
          await expect.poll(() => holding, { timeout: 20_000 }).toBe(true)
          const runId = (await detail()).summary.runId
          const cancellation = page.waitForResponse(
            response =>
              response.request().method() === 'POST' && new URL(response.url()).pathname === `/link/api/tasks/${sessionId}/cancel`,
          )
          await page.getByRole('button', { name: '停止', exact: true }).filter({ visible: true }).click()
          const cancellationResponse = await cancellation
          expect(cancellationResponse.ok()).toBe(true)
          const stopped = (await cancellationResponse.json()) as { accepted: true; receipt: CancelReceipt }
          expect(stopped).toMatchObject({ accepted: true, receipt: { sessionId, runId, outcome: 'stopped', status: 'cancelled' } })
          await expect.poll(async () => (await detail()).summary.status, { timeout: 20_000 }).toBe('cancelled')
          expect((await detail()).summary.runOutcome).toBe('cancelled')
          phase = 'recovered'
          await host.close()
          host = await startTestHost({ ...hostOptions, port })
          owner = await host.enroll({ listener: 'unix' })
          await page.reload()
          await connected(page)
          await input().waitFor()
          await send('继续刚才的话题。')
          expect(recoveredHistory).toBe(true)
          expect(await readFile(join(home, 'notes.md'), 'utf8')).toBe(NOTE)
          await personOnly(page)
          await capture(page, join(output, 'recovered-1440-light.png'))
          await writeFile(
            join(output, 'evidence.json'),
            JSON.stringify(
              {
                actualCli: variant.id,
                temporaryHome: true,
                modelUpstream: 'local scripted Chat service',
                realProviderVerified: false,
                homeMode: '0700',
                notesWritten: true,
                localPageRequests: pageRequests,
                localPageTitle: TITLE,
                usedTools,
                approvals: approvals.map(item => ({ phase: item.phase })),
                offeredToolNames: [...toolNames],
                mcp: { transportSupported: variant.id !== 'pi', actualToolCallVerified: false },
                browserMcp: { called: false, available: false, reason: 'No desktop browser provider in this Web acceptance' },
                cliOwnNetworkTool: true,
                stopped: true,
                stopScope: 'model-stream; Host acknowledged cancellation',
                commandCancellationVerified: false,
                recoveredSameTopic: true,
                recoveredPriorToolHistory: true,
                topicHasEngineLabels: false,
                testPresence: true,
                cliCredentialsReadByTest: false,
              },
              null,
              2,
            ) + '\n',
          )
        } catch (error) {
          const snapshot = await owner.json<AppSnapshot>('snapshot').catch(() => undefined)
          const last = snapshot?.tasks[0]
          {
            const current = last ? await owner.json<TaskDetail>(`tasks/${last.id}`).catch(() => undefined) : undefined
            await writeFile(
              join(output, 'failure-evidence.json'),
              JSON.stringify(
                {
                  summary: current?.summary,
                  messages: current?.messages.map(message => ({ role: message.role, text: message.text })),
                  nativeToolSteps: usedTools,
                  modelRequests: upstream.requests.length,
                },
                null,
                2,
              ) + '\n',
            )
          }
          await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' })
          throw error
        }
      } finally {
        const failures: unknown[] = []
        for (const close of cleanup) {
          try {
            await close()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Temporary helper resources did not all close')
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
