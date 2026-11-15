import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AgentPreset,
  AppSnapshot,
  AutomationList,
  CustomAgent,
  CustomAgentDetail,
  MemoryProposalList,
  ProviderSettings,
  TaskDetail,
} from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

const enabled = process.env.LATCH_HELPER_PROPOSALS_LIVE === '1'
const variants = [
  { id: 'codex', name: 'Codex', person: '小林', binary: process.env.LATCH_CODEX_GATEWAY_BINARY, args: [] },
  { id: 'opencode', name: 'OpenCode', person: '青禾', binary: process.env.LATCH_OPENCODE_GATEWAY_BINARY, args: ['acp'] },
] as const
const MEMORY = '我喜欢简短的回答。'
const SCHEDULE = '查看邮件'
afterEach(() => vi.unstubAllEnvs())

interface OfferedTool {
  name: string
  namespace?: string
  description?: string
  parameters?: { properties?: Record<string, unknown> }
}
function responseTools(values: unknown[], namespace?: string): OfferedTool[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const item = value as { type?: string; name?: string; tools?: unknown[] } & OfferedTool
    if (item.type === 'namespace' && Array.isArray(item.tools)) return responseTools(item.tools, item.name)
    return item.type === 'function' && typeof item.name === 'string' ? [{ ...item, ...(namespace ? { namespace } : {}) }] : []
  })
}
const textOf = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/(?:lmg1|lbt1)\.[A-Za-z0-9_-]+/gu, '[redacted]') + '\n'
function catalogPaths(outputs: string[]): string[] {
  return outputs.flatMap(output => {
    let value: unknown
    try {
      value = JSON.parse(output)
    } catch {
      return []
    }
    if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return []
    return value.items.flatMap((item: unknown) =>
      item
      && typeof item === 'object'
      && 'path' in item
      && typeof item.path === 'string'
      && /^tools(?:\["[A-Za-z0-9_-]+"\]|\.[A-Za-z_$][\w$-]*)+$/u.test(item.path)
        ? [item.path]
        : [],
    )
  })
}
async function capture(page: Page, file: string) {
  await page.evaluate(() => document.fonts.ready)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: file, animations: 'disabled' })
}
async function captureWidths(page: Page, output: string, state: string) {
  for (const width of [1440, 768, 390])
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme })
      await capture(page, join(output, `${state}-${width}-${colorScheme}.png`))
    }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light' })
}

for (const variant of variants)
  it.skipIf(!enabled || !variant.binary)(
    `receives real ${variant.name} skill-server proposals and only saves them through the person's controls`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), `latch-helper-proposals-${variant.id}-`))
      const cleanup: Array<() => Promise<unknown>> = []
      try {
        for (const [key, leaf] of Object.entries({
          HOME: 'home',
          XDG_CONFIG_HOME: 'config',
          XDG_DATA_HOME: 'data',
          XDG_CACHE_HOME: 'cache',
          XDG_STATE_HOME: 'state',
          CODEX_HOME: 'codex',
        })) {
          const path = join(root, leaf)
          await mkdir(path)
          vi.stubEnv(key, path)
        }
        const output = join('test-results', 'helper-proposals', variant.id)
        await mkdir(output, { recursive: true })
        let phase: 'memory' | 'schedule' = 'memory'
        let step = 0
        const offered = new Map<string, OfferedTool>()
        const results: Array<{ phase: string; text: string }> = []
        const calls: Array<{ phase: string; tool: string; path?: string }> = []
        const upstream = await startFakeModels({
          replyFor: request => {
            const body = request.body as {
              tools?: Array<{ type?: string; execution?: string; function?: OfferedTool; parameters?: OfferedTool['parameters'] }>
              messages?: Array<{ role?: string; content?: unknown }>
              input?: Array<{ type?: string; output?: unknown; tools?: unknown[] }>
            }
            const catalog = (body.input ?? []).filter(item => item.type === 'tool_search_output')
            const tools =
              request.wire === 'responses'
                ? responseTools([...(body.tools ?? []), ...catalog.flatMap(item => item.tools ?? [])])
                : (body.tools ?? []).flatMap(item => (item.function ? [item.function] : []))
            if (!body.tools?.length) return { text: '偏好与提醒' }
            for (const tool of tools) offered.set(tool.name, tool)
            const outputs =
              request.wire === 'responses'
                ? [
                    ...catalog.map(textOf),
                    ...(body.input ?? []).filter(item => item.type === 'function_call_output').map(item => textOf(item.output)),
                  ]
                : (body.messages ?? []).filter(item => item.role === 'tool').map(item => textOf(item.content))
            for (const text of outputs) if (!results.some(item => item.phase === phase && item.text === text)) results.push({ phase, text })
            const wanted = phase === 'memory' ? 'propose_memory' : 'propose_schedule'
            const input =
              phase === 'memory'
                ? { content: MEMORY, reason: '用户在本轮表达的偏好' }
                : { name: SCHEDULE, plan: { kind: 'daily', time: '09:00' }, prompt: '提醒我查看邮件。' }
            const direct = tools.find(tool => tool.name.endsWith(wanted))
            if (direct && step < 2) {
              step = 2
              calls.push({ phase, tool: direct.name, ...(direct.namespace ? { path: direct.namespace } : {}) })
              return { tool: { name: direct.name, ...(direct.namespace ? { namespace: direct.namespace } : {}), input } }
            }
            if (request.wire === 'responses') {
              const search = body.tools?.find(item => item.type === 'tool_search' && item.execution === 'client')
              if (step++ === 0 && search?.parameters?.properties?.query) {
                calls.push({ phase, tool: 'tool_search', path: wanted })
                return { search: { input: { query: `latch-skills ${wanted}`, limit: 4 } } }
              }
              return { text: '提议已交给你确认。' }
            }
            const execute = tools.find(tool => tool.name === 'execute' && tool.parameters?.properties?.code)
            if (execute) {
              if (step++ === 0) {
                calls.push({ phase, tool: execute.name, path: 'search' })
                return { tool: { name: execute.name, input: { code: `return search({ query: "latch-skills ${wanted}" })` } } }
              }
              if (step === 2) {
                const paths = catalogPaths(outputs)
                const path = paths.find(path => path.endsWith(`.${wanted}`) || path.endsWith(`["${wanted}"]`))
                if (!path) return { text: '这次没有发现提议工具。' }
                calls.push({ phase, tool: execute.name, path })
                return { tool: { name: execute.name, input: { code: `return await ${path}(${JSON.stringify(input)})` } } }
              }
            }
            return { text: '提议已交给你确认。' }
          },
        })
        cleanup.unshift(() => upstream.close())
        const host = await startTestHost({
          demo: false,
          dataDir: join(root, 'host'),
          workspaceRoot: join(root, 'workspace'),
          uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
          commandDirectories: () => [dirname(variant.binary!)],
          loginPrograms: name => (name === variant.id ? variant.binary : undefined),
          detectPreset: (preset: AgentPreset) => (preset.id === variant.id ? { found: true, path: variant.binary! } : { found: false }),
        })
        cleanup.unshift(() => host.close())
        const owner = await host.enroll({ listener: 'unix' })
        const provider = await owner.confirmedJson<{ provider: ProviderSettings }>('providers', {
          method: 'POST',
          body: {
            name: '临时模型服务',
            kind: variant.id === 'codex' ? 'openai-responses' : 'openai-compatible',
            baseURL: `${upstream.origin}/v1`,
            apiKey: 'sk-test-helper-proposals-0123456789',
            models: ['gpt-5.5'],
            defaultModel: 'gpt-5.5',
            modelCapabilities: { 'gpt-5.5': { thinking: ['none', 'low', 'medium', 'high', 'xhigh'] } },
            confirmOrigin: true,
          },
        })
        await owner.confirmedJson('agents', {
          method: 'POST',
          body: { id: variant.id, name: variant.name, presetId: variant.id, command: variant.binary!, args: [...variant.args], env: {} },
        })
        // Normal creation was proven by helper-live; this fixture isolates the later proposal and person-decision path.
        const agent = await owner.json<CustomAgent>('custom-agents', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            name: variant.person,
            harnessId: variant.id,
            mode: 'agent',
            instructions: '',
            skills: [],
            model: { providerId: provider.provider.id, model: 'gpt-5.5' },
          },
        })
        const browser = await chromium.launch(browserLaunchOptions())
        cleanup.unshift(() => browser.close())
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
        cleanup.unshift(() => context.close())
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        let sessionId = ''
        const approvals = new Set<string>()
        const proposals = () => owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
        const memories = () => owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)
        try {
          await enrollBrowser(page, host, { name: `提议验收-${variant.id}` })
          const device = host.host.security.devices.list().find(item => item.name === `提议验收-${variant.id}`)!
          await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
          await page.reload()
          await connected(page)
          await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
          await page
            .getByRole('navigation', { name: '我的 Agent', exact: true })
            .getByRole('button', { name: new RegExp(variant.person, 'u') })
            .click()
          const send = async (prompt: string) => {
            step = 0
            const previousRun = sessionId ? (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.runId : undefined
            const input = page
              .getByRole('textbox', { name: `给${variant.person}发消息`, exact: true })
              .or(page.getByRole('textbox', { name: '继续对话', exact: true }))
              .filter({ visible: true })
            await input.fill(prompt)
            const expectedPath = sessionId ? `/link/api/tasks/${sessionId}/prompt` : '/link/api/tasks'
            const submitted = page.waitForResponse(
              response => response.request().method() === 'POST' && new URL(response.url()).pathname === expectedPath,
            )
            await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
            expect((await submitted).ok()).toBe(true)
            const topics = async () =>
              (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
            await expect.poll(async () => (await topics()).length).toBe(1)
            const nextId = (await topics())[0]!.id
            if (sessionId) expect(nextId).toBe(sessionId)
            else sessionId = nextId
            await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.runId).not.toBe(previousRun)
            await expect
              .poll(
                async () => {
                  const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
                  for (const approval of detail.approvals) {
                    if (approvals.has(approval.id)) continue
                    const allow = page
                      .locator(`[data-approval-id="${approval.id}"]`)
                      .filter({ visible: true })
                      .getByRole('button', { name: /^允许(?:这次|一次)?$/u })
                    await expect.poll(() => allow.isEnabled(), { timeout: 15_000 }).toBe(true)
                    await capture(page, join(output, `${phase}-approval-${approvals.size}.png`))
                    approvals.add(approval.id)
                    await allow.click()
                  }
                  return ['idle', 'failed', 'cancelled'].includes(detail.summary.status)
                },
                { timeout: 45_000, interval: 100 },
              )
              .toBe(true)
            expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.runOutcome).toBe('completed')
            const settled = await owner.json<TaskDetail>(`tasks/${sessionId}`)
            await writeFile(
              join(output, `${phase}-settlement.json`),
              safeJson({
                summary: settled.summary,
                tools: settled.messages.filter(message => message.role === 'tool'),
              }),
            )
            expect(settled.summary.runEnd?.unknownResults ?? []).toEqual([])
            expect(settled.messages.filter(message => message.role === 'tool').every(message => message.state === 'completed')).toBe(true)
          }
          await send('请提出一条偏好提议：我喜欢简短的回答。')
          await expect.poll(async () => (await proposals()).proposals.length, { timeout: 5_000 }).toBe(1)
          const memory = (await proposals()).proposals[0]!
          expect(memory).toMatchObject({ content: MEMORY, origin: 'agent', state: 'pending' })
          expect((await memories()).memories).toEqual([])
          const memoryRow = page.getByRole('group', { name: '记忆提议', exact: true }).filter({ hasText: MEMORY })
          await memoryRow.getByText('它推断的', { exact: true }).waitFor()
          await captureWidths(page, output, 'memory-pending')
          await memoryRow.getByRole('button', { name: '保存', exact: true }).click()
          await memoryRow.getByText('已保存', { exact: true }).waitFor()
          await memoryRow.getByText('清空上下文后生效', { exact: true }).waitFor()
          expect((await memories()).memories).toHaveLength(1)
          phase = 'schedule'
          await send('请提议每天九点提醒我查看邮件。')
          await expect.poll(async () => (await proposals()).proposals.length, { timeout: 5_000 }).toBe(2)
          const schedule = (await proposals()).proposals.find(item => item.kind === 'schedule')!
          expect(schedule).toMatchObject({
            origin: 'agent',
            state: 'pending',
            schedule: { name: SCHEDULE, plan: { kind: 'daily', time: '09:00' } },
          })
          expect((await owner.json<AutomationList>('automations')).automations).toEqual([])
          const scheduleRow = page.getByRole('group', { name: '定时提议', exact: true }).filter({ hasText: SCHEDULE })
          await capture(page, join(output, 'schedule-pending-1440-light.png'))
          await scheduleRow.getByRole('button', { name: '打开', exact: true }).click()
          const form = page.getByRole('form', { name: '新建定时任务', exact: true })
          await form.getByRole('button', { name: '保存为关闭', exact: true }).waitFor()
          expect((await owner.json<AutomationList>('automations')).automations).toEqual([])
          await captureWidths(page, output, 'schedule-open')
          await form.getByRole('button', { name: '保存为关闭', exact: true }).click()
          await expect.poll(async () => (await owner.json<AutomationList>('automations')).automations.length).toBe(1)
          const saved = (await owner.json<AutomationList>('automations')).automations[0]!
          expect(saved).toMatchObject({ name: SCHEDULE, customAgentId: agent.id, enabled: false })
          await expect
            .poll(async () => (await proposals()).proposals.find(item => item.id === schedule.id))
            .toMatchObject({ state: 'saved', automationId: saved.id })
          expect(saved.projectId).toBeUndefined()
          await writeFile(
            join(output, 'evidence.json'),
            safeJson({
              actualCli: variant.id,
              modelWire: variant.id === 'codex' ? 'responses' : 'chat-completions',
              fakeModelUpstream: true,
              realProviderVerified: false,
              calls,
              approvals: approvals.size,
              memory: { origin: memory.origin, external: memory.external, savedOnlyByPerson: true },
              schedule: {
                origin: schedule.origin,
                external: schedule.external,
                enabled: saved.enabled,
                home: saved.projectId === undefined,
              },
              mcpToolVerified: true,
              browserMcpVerified: false,
              temporaryHome: true,
              cliCredentialFilesRead: false,
            }),
          )
        } catch (error) {
          await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' })
          await writeFile(
            join(output, 'failure.json'),
            safeJson({
              phase,
              calls,
              results,
              offered: [...offered.values()],
              proposals: await proposals(),
              detail: sessionId ? await owner.json<TaskDetail>(`tasks/${sessionId}`) : undefined,
            }),
          )
          throw error
        } finally {
          await writeFile(join(output, 'tool-discovery.json'), safeJson({ calls, results, offered: [...offered.values()] }))
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
        if (failures.length) throw new AggregateError(failures, 'Temporary proposal resources did not all close')
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
