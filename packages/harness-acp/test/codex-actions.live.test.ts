import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startFakeModels } from '@latch/testkit'
import { CodexWire } from '../src/wires/codex.ts'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
const COMMANDS = ['cat notes.txt', 'ls -la docs', "rg -n 'alpha' notes.txt", 'cat notes.txt | wc -l', 'echo ok']

/**
 * What a real Codex says about the commands it runs: the installed binary with a private home and a local scripted
 * model service that asks for a few harmless commands in a temporary folder. Owner-approved runs only; it reads no
 * login and calls no model. The raw command items are written to test-results/ for the record.
 */
it.skipIf(process.env.LATCH_CODEX_ACTIONS_LIVE !== '1' || !binary)(
  'reports the actions a real Codex parsed for read, list and search commands',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-actions-live-')))
    let upstream: Awaited<ReturnType<typeof startFakeModels>> | undefined
    let wire: CodexWire | undefined
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
      for (const name of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
        env[name] = join(root, name.toLowerCase())
        await mkdir(env[name]!)
      }
      const project = join(root, 'project')
      await mkdir(join(project, 'docs'), { recursive: true })
      await writeFile(join(project, 'notes.txt'), 'alpha\nbeta\n')
      await writeFile(join(project, 'docs', 'guide.md'), '# guide\n')
      const offered: unknown[] = []
      upstream = await startFakeModels({
        replyFor: request => {
          const body = request.body as { tools?: unknown[]; input?: Array<{ type?: string }> }
          if (offered.length === 0 && Array.isArray(body.tools)) offered.push(...body.tools)
          const done = (body.input ?? []).filter(item => item.type === 'function_call_output').length
          const command = COMMANDS[done]
          if (command === undefined) return { text: 'done' }
          // Codex's shell tool by whichever name this version offers it; the fixture adapts the arguments below.
          return {
            tool: { name: /^(?:shell|shell_command|exec_command|local_shell)$/u, input: { command, cmd: command, workdir: project } },
          }
        },
      })
      const updates: Array<Record<string, unknown>> = []
      wire = CodexWire.spawn(
        {
          command: binary!,
          args: [
            '-c',
            'model_provider="fixture"',
            '-c',
            'model_providers.fixture.name="Fixture"',
            '-c',
            `model_providers.fixture.base_url="${upstream.origin}/v1"`,
            '-c',
            'model_providers.fixture.wire_api="responses"',
            '-c',
            'model_providers.fixture.requires_openai_auth=false',
          ],
          cwd: project,
          env,
          maxLineBytes: 16 * 1024 * 1024,
          redact: text => text,
        },
        {
          // Every command here is one of COMMANDS, in a temporary folder.
          request: async () => ({ outcome: { outcome: 'selected', optionId: 'accept' } }),
          notification: (_method, params) => {
            const update = (params as { update?: Record<string, unknown> }).update
            if (update) updates.push(update)
          },
          exit: () => {},
        },
        { model: 'gpt-5.5', models: ['gpt-5.5'] },
      )
      const native = wire as unknown as { onNotification(method: string, params: Record<string, unknown>): void }
      const items: Array<{ method: string; item: Record<string, unknown> }> = []
      const notify = native.onNotification.bind(wire)
      vi.spyOn(native, 'onNotification').mockImplementation((method, params) => {
        const item = params.item as Record<string, unknown> | undefined
        if ((method === 'item/started' || method === 'item/completed') && item?.type === 'commandExecution') items.push({ method, item })
        notify(method, params)
      })
      await wire.request('initialize', {}, 10_000)
      const { sessionId } = (await wire.request('session/new', { cwd: project, mcpServers: [] }, 20_000)) as { sessionId: string }
      await wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Look at the notes.' }] }, 60_000)
      const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(root, '<tmp>'))
      await mkdir('test-results/codex-actions', { recursive: true })
      await writeFile(
        'test-results/codex-actions/items.json',
        JSON.stringify(
          {
            tools: offered.map(tool => (tool as { name?: string; type?: string }).name ?? (tool as { type?: string }).type),
            items: scrub(items),
            rows: scrub(updates.filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')),
          },
          null,
          2,
        ) + '\n',
      )
      const completed = items.filter(entry => entry.method === 'item/completed').map(entry => entry.item)
      expect(completed.length).toBeGreaterThan(0)
      for (const item of completed) expect(Array.isArray(item.commandActions)).toBe(true)
    } finally {
      try {
        await wire?.stop('stop', 500)
      } finally {
        await upstream?.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  90_000,
)
