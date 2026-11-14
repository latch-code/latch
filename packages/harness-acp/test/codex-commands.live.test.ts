import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startFakeModels } from '@latch/testkit'
import { CodexWire } from '../src/wires/codex.ts'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
it.skipIf(process.env.LATCH_SLASH_LIVE !== '1' || !binary)(
  'runs and cancels compact on a private real Codex thread, refusing unapplied settings',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-commands-live-'))
    let upstream: Awaited<ReturnType<typeof startFakeModels>> | undefined
    let wire: CodexWire | undefined
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
      for (const name of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
        env[name] = join(root, name.toLowerCase())
        await mkdir(env[name]!)
      }
      let hold = false
      upstream = await startFakeModels({
        replyFor: () => ({ text: 'The public plan is retained.', ...(hold ? { delayMs: 30_000 } : {}) }),
      })
      const updates: Array<{ method: string; params: unknown }> = []
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
          cwd: root,
          env,
          maxLineBytes: 16 * 1024 * 1024,
          redact: text => text,
        },
        {
          request: async () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }),
          notification: (method, params) => {
            updates.push({ method, params })
          },
          exit: () => {},
        },
        { model: 'gpt-5.5', models: ['gpt-5.5', 'gpt-5.4'] },
      )
      const native = wire as unknown as {
        onNotification(method: string, params: Record<string, unknown>): void
      }
      const events: Array<{ method: string; params: Record<string, unknown> }> = []
      const notify = native.onNotification.bind(wire)
      vi.spyOn(native, 'onNotification').mockImplementation((method, params) => {
        if (method.startsWith('turn/') || method.startsWith('item/')) events.push({ method, params })
        notify(method, params)
      })
      await wire.request('initialize', {}, 10_000)
      const { sessionId } = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 20_000)) as { sessionId: string }
      await wire.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'Remember the public marker SLASH_HISTORY.' }] },
        20_000,
      )
      const compact = () => wire!.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/compact' }] }, 20_000)
      expect(await compact()).toMatchObject({ stopReason: 'end_turn' })
      for (const [mode, model, effort] of [
        ['workspace-write', 'gpt-5.4', 'high'],
        ['read-only', 'gpt-5.5', 'low'],
      ]) {
        await wire.request('session/set_config_option', { sessionId, configId: 'mode', value: mode })
        await wire.request('session/set_config_option', { sessionId, configId: 'model', value: model })
        await wire.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: effort })
        const before = upstream.requests.length
        await expect(compact()).rejects.toThrow('与选择不一致')
        expect(upstream.requests).toHaveLength(before)
        await wire.request(
          'session/prompt',
          { sessionId, prompt: [{ type: 'text', text: 'Use no tools. Remember SLASH_SETTINGS.' }] },
          20_000,
        )
        expect(await compact()).toMatchObject({ stopReason: 'end_turn' })
        expect(upstream.requests.at(-1)?.body).toMatchObject({ model, reasoning: { effort } })
      }
      hold = true
      const before = upstream.requests.length
      let settled = false
      const pending = compact().then(result => {
        settled = true
        return result
      })
      await vi.waitFor(() => expect(upstream!.requests.length).toBe(before + 1), { timeout: 10_000 })
      expect(settled).toBe(false)
      wire.notify('session/cancel')
      expect(await pending).toMatchObject({ stopReason: 'cancelled' })
      const compactions = updates.flatMap(({ params }) => {
        const update = (params as { update?: { sessionUpdate?: string; status?: string } }).update
        return update?.sessionUpdate === 'compaction_update' ? [update.status] : []
      })
      expect(compactions.filter(status => status === 'completed')).toHaveLength(3)
      expect(compactions.filter(status => status === 'cancelled')).toHaveLength(1)
      await mkdir('test-results/native-slash/codex', { recursive: true })
      await writeFile(
        'test-results/native-slash/codex/compact-events.json',
        JSON.stringify(
          { events, updates, models: upstream.requests.map(request => ({ model: request.model, wire: request.wire })) },
          null,
          2,
        ) + '\n',
      )
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'turn/completed',
            params: expect.objectContaining({ turn: expect.objectContaining({ status: 'interrupted' }) }),
          }),
        ]),
      )
    } finally {
      try {
        await wire?.stop('stop', 500)
      } finally {
        await upstream?.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  60_000,
)
