import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

const binary = process.env.LATCH_CLAUDE_GATEWAY_BINARY
/** The person's own `claude` runs on the Agent SDK wire, which takes no arguments; anything else is the adapter. */
const direct = binary !== undefined && basename(binary) === 'claude'
const program = direct ? 'claude' : 'claude-agent-acp'
const launchArgs = direct ? [] : ['--hide-claude-auth']
afterEach(() => vi.unstubAllEnvs())

// Claude sends `output_config.effort: high` of its own on Default; a Chat model that declares only `max` once refused it.
it.skipIf(!binary)(
  'runs Claude on a converted route through Default, a declared level and Default again',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-claude-thinking-'))
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR']) {
      const directory = join(root, name.toLowerCase())
      await mkdir(directory)
      vi.stubEnv(name, directory)
    }
    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1')
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(name, 'http://127.0.0.1:9')
    const model = await startFakeModels({
      replyFor: request =>
        JSON.stringify(request.body).includes('测试四') ? { error: { status: 400, message: 'planned refusal' } } : { text: 'ok' },
    })
    const host = await startTestHost({
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [dirname(binary!)],
      loginPrograms: name => (name === program ? binary : undefined),
      detectPreset: preset => (preset.id === 'claude-agent' ? { found: true, path: binary! } : { found: false }),
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        body: {
          name: 'Temporary thinking service',
          kind: 'openai-compatible',
          baseURL: `${model.origin}/v1`,
          apiKey: 'sk-test-thinking-0123456789',
          models: ['fake-model'],
          modelCapabilities: { 'fake-model': { thinking: ['max'] } },
          defaultModel: 'fake-model',
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      const saved = await owner.confirmed('agents', {
        body: {
          id: 'thinking-claude',
          name: 'Claude Code',
          presetId: 'claude-agent',
          command: binary!,
          args: launchArgs,
          env: {},
        },
      })
      expect(saved.status).toBe(201)
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'thinking-claude',
          prompt: '测试一',
          requestId: randomUUID(),
          model: { providerId: provider.id, model: 'fake-model' },
        },
      })
      const detail = () => owner.json<TaskDetail>(`tasks/${started.sessionId}`)
      // By the turn's own prompt: Claude may still send a request of the turn before after that turn settled.
      const turn = async (prompt: string) => {
        await vi.waitFor(async () => expect(['idle', 'failed']).toContain((await detail()).summary.status), { timeout: 60_000 })
        const current = await detail()
        const notes = current.messages.filter(message => message.role === 'system').map(message => message.text)
        expect(current.summary.status, notes.join('\n')).toBe('idle')
        return model.requests
          .filter(request => JSON.stringify(request.body).includes(prompt))
          .map(request => (request.body as Record<string, unknown>).reasoning_effort)
      }
      const thinking = async () => (await detail()).config?.find(option => option.category === 'thought_level')
      const choose = async (value: string, prompt: string) => {
        await owner.json(`tasks/${started.sessionId}/config`, {
          method: 'POST',
          body: { configId: (await thinking())!.id, value, requestId: randomUUID() },
        })
        await owner.json(`tasks/${started.sessionId}/prompt`, { method: 'POST', body: { prompt, requestId: randomUUID() } })
      }

      const first = await turn('测试一')
      expect(first.length).toBeGreaterThan(0)
      expect(first.every(effort => effort === undefined)).toBe(true)
      expect((await thinking())?.options.map(option => option.value)).toEqual(['default', 'max'])
      await choose('max', '测试二')
      expect(await turn('测试二')).toContain('max')
      await choose('default', '测试三')
      const again = await turn('测试三')
      expect(again.length).toBeGreaterThan(0)
      expect(
        again.every(effort => effort === undefined),
        JSON.stringify(again),
      ).toBe(true)
      expect((await thinking())?.currentValue).toBe('default')

      // A refused request: Claude writes the error as its reply too, which is exactly what the failure row ends with.
      const before = (await detail()).messages.length
      await owner.json(`tasks/${started.sessionId}/prompt`, { method: 'POST', body: { prompt: '测试四', requestId: randomUUID() } })
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('failed'), { timeout: 60_000 })
      const failed = (await detail()).messages.slice(before)
      const reply = failed.filter(message => message.role === 'assistant')
      const row = failed.find(message => message.role === 'system' && message.state === 'failed')
      expect(reply).toHaveLength(1)
      expect(row?.text).not.toContain('Internal error')
      expect(row?.text.endsWith(`：${reply[0]!.text.trim()}`), JSON.stringify(failed.map(message => message.text))).toBe(true)
    } finally {
      await host.close()
      await model.close()
      try {
        await assertNoGatewayCredentials(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  180_000,
)
