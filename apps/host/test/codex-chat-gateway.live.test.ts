import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { CancelReceipt, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
afterEach(() => vi.unstubAllEnvs())

it.skipIf(!binary).each([
  { model: 'gpt-5.5', custom: true, thinking: true },
  { model: 'service-only-chat', custom: false, thinking: true },
  { model: 'deepseek-flash', custom: false, thinking: false },
])(
  'runs real Codex $model tools through translated Chat with signed reasoning replay (custom=$custom)',
  async ({ model, custom, thinking }) => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-chat-live-'))
    for (const [key, leaf] of Object.entries({
      HOME: 'home',
      CODEX_HOME: 'codex',
      XDG_CONFIG_HOME: 'config',
      XDG_DATA_HOME: 'data-home',
      XDG_CACHE_HOME: 'cache',
    })) {
      const path = join(root, leaf)
      await mkdir(path, { recursive: true })
      vi.stubEnv(key, path)
    }
    const received: Array<Record<string, unknown>> = []
    let phase: 'tools' | 'hold' | 'failure' = 'tools'
    let holding = false
    let upstreamCancelled = false
    const upstream = createServer(async (req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404)
        res.end()
        return
      }
      let text = ''
      for await (const chunk of req) text += chunk.toString()
      const body = JSON.parse(text) as Record<string, unknown>
      received.push(body)
      if (phase === 'failure') {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'planned Chat refusal' } }))
        return
      }
      if (phase === 'hold') {
        holding = true
        res.once('close', () => {
          upstreamCancelled = true
        })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'Waiting for cancellation.' }, finish_reason: null }] })}\n\n`,
        )
        return
      }
      const step = received.length
      const offered = body.tools as Array<{
        function: { name: string; description?: string; parameters?: { properties?: Record<string, unknown> } }
      }>
      const patch = offered.find(
        tool => tool.function.description?.includes('apply_patch') && tool.function.parameters?.properties?.content,
      )
      const shell = offered.find(tool => tool.function.parameters?.properties?.cmd || tool.function.parameters?.properties?.command)
      const tool = step === 1 && custom ? patch : step <= 2 ? shell : undefined
      if (step < 3 && !tool) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Required tool not offered to the Chat service' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, reason: string | null = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`)
      emit({ reasoning_content: `Reasoning for step ${step}.` })
      if (tool) {
        const command =
          step === 1
            ? "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: note.txt\n+gateway translated tool proof\n*** End Patch\nPATCH"
            : "cat note.txt; if [ -n \"${LMG_TOKEN:-}\" ]; then printf 'TOKEN_VISIBLE'; else printf 'TOKEN_ABSENT'; fi"
        const args =
          step === 1 && custom
            ? { content: '*** Begin Patch\n*** Add File: note.txt\n+gateway translated tool proof\n*** End Patch' }
            : tool.function.parameters?.properties?.cmd
              ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 200 }
              : { command, timeout_ms: 1000 }
        emit(
          {
            tool_calls: [
              { index: 0, id: `call_${step}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } },
            ],
          },
          'tool_calls',
        )
      } else emit({ content: 'translated tools completed' }, 'stop')
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
      res.end()
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    const host = await startTestHost({
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [dirname(binary!)],
      loginPrograms: name => (name === 'codex' ? binary : undefined),
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: binary! } : { found: false }),
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: 'Temporary Chat',
          kind: 'openai-compatible',
          baseURL: `${origin}/v1`,
          apiKey: 'fake-codex-chat-service-key',
          models: [model],
          defaultModel: model,
          ...(thinking ? { modelCapabilities: { [model]: { thinking: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] } } } : {}),
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      const agent = await owner.confirmed('agents', {
        method: 'POST',
        body: {
          id: 'codex',
          name: 'Codex',
          presetId: 'codex',
          command: binary!,
          args: thinking ? [] : ['-c', 'model_reasoning_effort="medium"'],
          env: {},
        },
      })
      expect(agent.status).toBe(201)
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'codex',
          requestId: randomUUID(),
          prompt: 'Create note.txt containing gateway translated tool proof, then read it.',
          model: { providerId: provider.id, model },
          config: [
            { configId: '~mode', value: 'agent-full-access' },
            ...(thinking ? [{ configId: 'reasoning_effort', value: 'high' }] : []),
          ],
        },
      })
      const detail = () => owner.json<TaskDetail>(`tasks/${started.sessionId}`)
      await vi.waitFor(
        async () => {
          const current = await detail()
          expect(['idle', 'failed']).toContain(current.summary.status)
        },
        { timeout: 60_000, interval: 100 },
      )
      const result = await detail()
      expect(
        result.summary.status,
        JSON.stringify({
          errors: result.messages.filter(message => message.role === 'system').map(message => message.text),
          tools: (
            received[0]?.tools as
              | Array<{ function: { name: string; description?: string; parameters?: { properties?: object } } }>
              | undefined
          )?.map(tool => ({
            name: tool.function.name,
            description: tool.function.description?.slice(0, 180),
            properties: Object.keys(tool.function.parameters?.properties ?? {}),
          })),
        }),
      ).toBe('idle')
      expect(result.messages.filter(message => message.role === 'assistant').at(-1)?.text).toBe('translated tools completed')
      expect(await readFile(join(root, 'project', 'note.txt'), 'utf8')).toBe('gateway translated tool proof\n')
      expect(received).toHaveLength(3)
      if (!thinking) for (const request of received) expect(request).not.toHaveProperty('reasoning_effort')
      else for (const request of received) expect(request).toHaveProperty('reasoning_effort', 'high')
      expect(JSON.stringify(received.at(-1))).toContain('TOKEN_ABSENT')
      expect(JSON.stringify(received.at(-1))).not.toContain('TOKEN_VISIBLE\\n')
      const last = received.at(-1)!.messages as Array<Record<string, unknown>>
      expect(last.filter(item => item.reasoning_content).map(item => item.reasoning_content)).toEqual([
        'Reasoning for step 1.',
        'Reasoning for step 2.',
      ])
      expect(result.messages.find(message => message.turn)?.turn?.routed).toMatchObject({
        requests: 3,
        ...(custom ? { dropped: expect.arrayContaining(['tool-grammar']) } : {}),
      })
      phase = 'hold'
      if (thinking)
        await owner.json(`tasks/${started.sessionId}/config`, {
          method: 'POST',
          body: { configId: 'reasoning_effort', value: '~default', requestId: randomUUID() },
        })
      await owner.json(`tasks/${started.sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Wait until this run is stopped.', requestId: randomUUID() },
      })
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: 15_000 })
      expect(received.at(-1)).not.toHaveProperty('reasoning_effort')
      const runId = (await detail()).summary.runId
      const stopped = await owner.json<{ receipt: CancelReceipt }>(`tasks/${started.sessionId}/cancel`, {
        method: 'POST',
        body: { runId, requestId: randomUUID() },
      })
      expect(stopped.receipt).toMatchObject({ outcome: 'stopped', status: 'cancelled' })
      await vi.waitFor(() => expect(upstreamCancelled).toBe(true), { timeout: 15_000 })
      phase = 'failure'
      await owner.json(`tasks/${started.sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Report the planned service refusal.', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('failed'), { timeout: 30_000 })
      expect((await detail()).messages.map(message => message.text).join('\n')).toContain('Selected model is at capacity')
      await assertNoGatewayCredentials(root)
    } finally {
      await host.close()
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  90_000,
)
