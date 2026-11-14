import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startFakeModels } from '@latch/testkit'
import { CodexWire } from '../src/wires/codex.ts'
import { AgentProcess, isRecord } from '../src/wires/process.ts'
import { skillsServer, writeSessionSkills } from '../src/skills-server.ts'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
it.skipIf(process.env.LATCH_HELPER_PROPOSALS_LIVE !== '1' || !binary)(
  'reads the actual private Codex thread skill-server catalog without accessing CLI storage',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-skills-live-'))
    let upstream: Awaited<ReturnType<typeof startFakeModels>> | undefined
    let wire: CodexWire | undefined
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
      for (const [key, leaf] of Object.entries({
        HOME: 'home',
        CODEX_HOME: 'codex',
        XDG_CONFIG_HOME: 'config',
        XDG_DATA_HOME: 'data',
        XDG_CACHE_HOME: 'cache',
        XDG_STATE_HOME: 'state',
        TMPDIR: 'tmp',
      })) {
        env[key] = join(root, leaf)
        await mkdir(env[key]!)
      }
      let replies = 0
      let discoveredNamespace: string | undefined
      upstream = await startFakeModels({
        replyFor: request => {
          if (++replies === 2) return { search: { input: { query: 'latch-skills propose_memory', limit: 4 } } }
          if (replies === 3) {
            const body = request.body as {
              input?: Array<{ type?: string; tools?: Array<{ type?: string; name?: string; tools?: Array<{ name?: string }> }> }>
            }
            const catalog = body.input?.filter(item => item.type === 'tool_search_output').flatMap(item => item.tools ?? []) ?? []
            const namespace = catalog.find(
              item => item.type === 'namespace' && item.tools?.some(tool => tool.name === 'propose_memory'),
            )?.name
            if (!namespace) return { text: 'No discovered proposal tool.' }
            discoveredNamespace = namespace
            return { tool: { namespace, name: 'propose_memory', input: { content: 'A diagnostic preference' } } }
          }
          if (replies === 5 && discoveredNamespace)
            return { tool: { namespace: discoveredNamespace, name: 'propose_memory', input: { content: '' } } }
          return { text: 'Ready.' }
        },
      })
      const directory = join(root, 'skills')
      await writeSessionSkills(directory, [])
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
          redact: text => text.replace(/(?:lmg1|lbt1)\.[A-Za-z0-9_-]+/gu, '[redacted]'),
        },
        { request: async () => ({ outcome: { outcome: 'selected', optionId: 'accept' } }), notification: () => {}, exit: () => {} },
        { model: 'gpt-5.5', models: ['gpt-5.5'] },
      )
      await wire.request('initialize', {}, 10_000)
      const opened = (await wire.request('session/new', { cwd: root, mcpServers: [skillsServer(directory, true)] }, 20_000)) as {
        sessionId: string
      }
      // Only this new test-owned process: inspect the official response before Latch hides its own servers from its public list.
      const native = wire as unknown as { send(method: string, params: unknown, timeoutMs: number): Promise<unknown> }
      const result = (await native.send(
        'mcpServerStatus/list',
        { threadId: opened.sessionId, serverName: 'latch-skills', detail: 'toolsAndAuthOnly' },
        15_000,
      )) as {
        data: Array<{ name: string; runtimeStatus?: string; serverCapabilities?: unknown; tools?: Record<string, unknown> }>
      }
      const entry = result.data.find(server => server.name === 'latch-skills')
      const evidence = entry
        ? {
            name: entry.name,
            runtimeStatus: entry.runtimeStatus,
            serverCapabilities: entry.serverCapabilities,
            toolNames: Object.keys(entry.tools ?? {}),
          }
        : { missing: true }
      await mkdir('test-results/helper-proposals/codex', { recursive: true })
      await writeFile('test-results/helper-proposals/codex/native-catalog.json', JSON.stringify(evidence, null, 2) + '\n')
      expect(upstream.requests).toEqual([])
      expect(entry).toBeDefined()
      expect(Object.keys(entry!.tools ?? {})).toEqual(expect.arrayContaining(['propose_memory', 'propose_schedule']))
      await wire.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'Say ready.' }] }, 20_000)
      expect(upstream.requests).toHaveLength(1)
      const describe = (item: unknown): unknown => {
        if (!item || typeof item !== 'object') return { invalid: true }
        return {
          ...('type' in item ? { type: item.type } : {}),
          ...('name' in item ? { name: item.name } : {}),
          ...('tools' in item && Array.isArray(item.tools) ? { tools: item.tools.map(describe) } : {}),
        }
      }
      const request = upstream.requests[0]!.body as { tools?: unknown[] }
      expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_search', execution: 'client' })]))
      await writeFile(
        'test-results/helper-proposals/codex/native-model-tools.json',
        JSON.stringify(request.tools?.map(describe), null, 2) + '\n',
      )
      const observed: unknown[] = []
      const inspect = wire as unknown as {
        onNotification(method: string, params: Record<string, unknown>): void
        onRequest(method: string, params: Record<string, unknown>, id: string | number): Promise<unknown>
      }
      const notify = inspect.onNotification.bind(wire)
      const ask = inspect.onRequest.bind(wire)
      vi.spyOn(inspect, 'onNotification').mockImplementation((method, params) => {
        if (method === 'item/started' || method === 'item/completed') observed.push({ method, params })
        notify(method, params)
      })
      vi.spyOn(inspect, 'onRequest').mockImplementation((method, params, id) => {
        observed.push({ method, params, id })
        return ask(method, params, id)
      })
      await wire.request(
        'session/prompt',
        { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'Propose a preference.' }] },
        20_000,
      )
      await wire.request(
        'session/prompt',
        { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'Try an invalid empty preference.' }] },
        20_000,
      )
      await writeFile('test-results/helper-proposals/codex/native-mcp-events.json', JSON.stringify(observed, null, 2) + '\n')
      expect(observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'item/completed',
            params: expect.objectContaining({ item: expect.objectContaining({ type: 'mcpToolCall', status: 'completed' }) }),
          }),
          expect.objectContaining({
            method: 'item/completed',
            params: expect.objectContaining({ item: expect.objectContaining({ type: 'mcpToolCall', status: 'failed' }) }),
          }),
        ]),
      )
    } finally {
      try {
        await wire?.stop('stop', 500)
      } finally {
        try {
          await upstream?.close()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  },
  60_000,
)

it.skipIf(process.env.LATCH_SLASH_LIVE !== '1' || !binary)(
  'uses a private real Codex directory and injects only the current user skill into a controlled model request',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-skills-live-')))
    let upstream: Awaited<ReturnType<typeof startFakeModels>> | undefined
    let wire: CodexWire | undefined
    const sent: Array<Record<string, unknown>> = []
    const write = AgentProcess.prototype.write
    const observer = vi.spyOn(AgentProcess.prototype, 'write').mockImplementation(function (this: AgentProcess, message: unknown) {
      if (isRecord(message) && message.method === 'turn/start' && isRecord(message.params)) sent.push(structuredClone(message.params))
      write.call(this, message)
    })
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
      for (const name of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
        env[name] = join(root, name.toLowerCase())
        await mkdir(env[name]!)
      }
      const directory = join(root, '.agents', 'skills', 'latch-public-proof')
      await mkdir(directory, { recursive: true })
      const path = join(directory, 'SKILL.md')
      const marker = 'LATCH_NATIVE_SKILL_BODY_20261114'
      await writeFile(
        path,
        '---\nname: latch-public-proof\ndescription: A public fixture for explicit skill invocation.\n---\nUse this public verification phrase: '
          + marker
          + '\n',
      )
      upstream = await startFakeModels({
        replyFor: request => ({
          text: JSON.stringify(request.body).includes(marker) ? 'Native skill body received.' : 'Native skill body missing.',
        }),
      })
      const updates: unknown[] = []
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
          notification: (_method, params) => {
            updates.push(params)
          },
          exit: () => {},
        },
        { model: 'gpt-5.5', models: ['gpt-5.5'] },
      )
      const initialized = await wire.request('initialize', {}, 10_000)
      const { sessionId } = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 20_000)) as { sessionId: string }
      const userText = 'Use $latch-public-proof and answer with its public verification phrase. Use no tools.'
      expect(
        await wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: userText }] }, 20_000, undefined, undefined, {
          userText,
        }),
      ).toMatchObject({ stopReason: 'end_turn' })
      expect((sent[0]!.input as Array<Record<string, unknown>>).filter(item => item.type === 'skill')).toEqual([
        { type: 'skill', name: 'latch-public-proof', path },
      ])
      expect(JSON.stringify(upstream.requests[0]?.body)).toContain(marker)
      const ordinary = 'Say one ordinary sentence. Use no tools.'
      await wire.request(
        'session/prompt',
        {
          sessionId,
          prompt: [
            { type: 'text', text: 'Context example $latch-public-proof is not this turn input.' },
            { type: 'text', text: ordinary },
          ],
        },
        20_000,
        undefined,
        undefined,
        { userText: ordinary },
      )
      expect((sent[1]!.input as Array<Record<string, unknown>>).filter(item => item.type === 'skill')).toEqual([])
      const catalogues = updates.flatMap(value =>
        isRecord(value) && isRecord(value.update) && value.update.sessionUpdate === '_latch/skills_update' ? [value.update] : [],
      )
      expect(JSON.stringify(catalogues)).not.toContain(path)
      expect(
        catalogues.some(
          value => Array.isArray(value.skills) && value.skills.some(skill => isRecord(skill) && skill.invocation === '$latch-public-proof'),
        ),
      ).toBe(true)
      await mkdir('test-results/native-slash/codex', { recursive: true })
      await writeFile(
        'test-results/native-slash/codex/skills-evidence.json',
        JSON.stringify(
          {
            initialized,
            officialDirectoryUsed: true,
            structuredSkillCounts: sent.map(
              value => (value.input as Array<Record<string, unknown>>).filter(item => item.type === 'skill').length,
            ),
            bodyMarkerReceived: true,
            publicCatalogueHasNoPath: true,
            modelRequests: upstream.requests.length,
          },
          null,
          2,
        ),
      )
    } finally {
      observer.mockRestore()
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
