import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPreset, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

/**
 * A definition saved on a preset's adapter before the preset ran its own program is moved to that program when the
 * Host starts, and a session begun on the adapter goes on with it. The installed programs, through Latch's gateway to
 * a local fake model.
 */
const CASES = [
  {
    preset: 'opencode',
    before: { command: 'opencode', args: ['acp'] },
    after: { command: 'opencode', args: [] as string[] },
    programs: { opencode: process.env.LATCH_OPENCODE_GATEWAY_BINARY },
    homes: ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'],
    kind: 'openai-compatible',
  },
  {
    preset: 'claude-agent',
    before: { command: 'claude-agent-acp', args: [] as string[] },
    after: { command: 'claude', args: [] as string[] },
    programs: { 'claude-agent-acp': process.env.LATCH_CLAUDE_ADAPTER_BINARY, claude: process.env.LATCH_CLAUDE_DIRECT_BINARY },
    homes: ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR'],
    kind: 'anthropic',
  },
] as const

afterEach(() => vi.unstubAllEnvs())

const RUNNABLE = CASES.filter(item => Object.values(item.programs).every(Boolean))

// Without the programs' paths set there is nothing to run, and an empty file is an error to Vitest.
if (!RUNNABLE.length) it.skip('moves an adapter definition to its preset program (no program paths set)', () => {})

it.each(RUNNABLE)(
  'moves a $preset definition saved on its adapter to its own program at a start, and its session goes on',
  async ({ preset, before, after, programs, homes, kind }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-direct-migrate-')))
    for (const name of homes) {
      const path = join(root, name.toLowerCase())
      await mkdir(path, { recursive: true })
      vi.stubEnv(name, path)
    }
    // A harness may ask the model more than once a turn (a title, a suggestion): the answer follows the route, not a count.
    let answer = 'adapter answer'
    const upstream = await startFakeModels({ replyFor: () => ({ text: answer }) })
    const paths = programs as Record<string, string>
    const hostOptions = {
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'workspace'),
      commandDirectories: () => [...new Set(Object.values(paths).map(path => dirname(path)))],
      loginPrograms: (name: string) => paths[name],
      detectPreset: (item: AgentPreset) => (item.id === preset ? { found: true, path: paths[after.command]! } : { found: false }),
    }
    let host = await startTestHost(hostOptions)
    try {
      let owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: 'Temporary service',
          kind,
          baseURL: `${upstream.origin}/v1`,
          apiKey: 'sk-test-direct-migrate-0123456789',
          models: ['fake-model'],
          defaultModel: 'fake-model',
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      const saved = await owner.confirmed('agents', {
        method: 'POST',
        body: { id: preset, name: preset, presetId: preset, command: before.command, args: before.args, env: {} },
      })
      expect(saved.status).toBe(201)
      const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
      const settled = async (id: string) => {
        await vi.waitFor(async () => expect(['running', 'waiting-approval']).not.toContain((await detail(id)).summary.status), {
          timeout: 90_000,
          interval: 100,
        })
        return detail(id)
      }
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: preset, prompt: 'Say hello.', requestId: randomUUID(), model: { providerId: provider.id, model: 'fake-model' } },
      })
      const first = await settled(started.sessionId)
      expect(first.summary.status, first.messages.map(message => message.text).join('\n')).toBe('idle')
      expect(first.messages.map(message => message.text).join('\n')).toContain('adapter answer')
      await host.close()
      answer = 'direct answer'

      // As a Host before the presets had their own programs left it: no mark that the person chose this route.
      const file = join(root, 'host', 'settings.json')
      const settings = JSON.parse(await readFile(file, 'utf8')) as { agents: Array<Record<string, unknown>> }
      for (const agent of settings.agents) delete agent.routeKept
      await writeFile(file, JSON.stringify(settings), { mode: 0o600 })

      host = await startTestHost(hostOptions)
      owner = await host.enroll({ listener: 'unix' })
      const moved = (JSON.parse(await readFile(file, 'utf8')) as { agents: Array<Record<string, unknown>> }).agents.find(
        agent => agent.id === preset,
      )
      expect(moved).toMatchObject({
        command: after.command,
        args: after.args,
        migratedFrom: { command: before.command, args: before.args },
      })
      await owner.json(`tasks/${started.sessionId}/prompt`, { method: 'POST', body: { prompt: 'And again.', requestId: randomUUID() } })
      const second = await settled(started.sessionId)
      expect(second.summary.status, second.messages.map(message => message.text).join('\n')).toBe('idle')
      expect(second.messages.map(message => message.text).join('\n')).toContain('direct answer')
      // The same session of the harness, with what was said before.
      expect(
        upstream.requests.map(request => JSON.stringify(request)).some(text => text.includes('And again.') && text.includes('Say hello.')),
      ).toBe(true)

      // A second start moves nothing more.
      await host.close()
      host = await startTestHost(hostOptions)
      const again = (JSON.parse(await readFile(file, 'utf8')) as { agents: Array<Record<string, unknown>> }).agents.find(
        agent => agent.id === preset,
      )
      expect(again).toEqual(moved)
    } finally {
      await host.close().catch(() => {})
      await upstream.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  240_000,
)
