import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPreset, AttachmentRef, CancelReceipt, ModelWire, ProviderKind, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

const binary = process.env.LATCH_PI_GATEWAY_BINARY
afterEach(() => vi.unstubAllEnvs())

function toolOutputs(input: unknown): string[] {
  const body = input as {
    input?: Array<{ type?: string; output?: unknown }>
    messages?: Array<{ role?: string; content?: unknown }>
    contents?: Array<{ parts?: Array<{ functionResponse?: { response?: unknown } }> }>
  }
  return [
    ...(body.input ?? []).filter(item => item.type === 'function_call_output').map(item => item.output),
    ...(body.messages ?? []).flatMap(message =>
      message.role === 'tool'
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content
              .filter((item: { type?: string }) => item.type === 'tool_result')
              .map((item: { content?: unknown }) => item.content)
          : [],
    ),
    ...(body.contents ?? []).flatMap(content =>
      (content.parts ?? []).flatMap(part => (part.functionResponse ? [part.functionResponse.response] : [])),
    ),
  ].map(value => JSON.stringify(value))
}

it.skipIf(!binary).each<{
  kind: ProviderKind
  wire: ModelWire
  scenario: 'lifecycle' | 'missing-budget' | 'catalog' | 'bad-payload' | 'unsupported-level'
}>([
  { kind: 'openai-responses', wire: 'responses', scenario: 'lifecycle' },
  { kind: 'openai-compatible', wire: 'chat-completions', scenario: 'lifecycle' },
  { kind: 'anthropic', wire: 'anthropic-messages', scenario: 'lifecycle' },
  { kind: 'gemini', wire: 'gemini', scenario: 'lifecycle' },
  { kind: 'openai-responses', wire: 'responses', scenario: 'missing-budget' },
  { kind: 'openai-responses', wire: 'responses', scenario: 'catalog' },
  { kind: 'gemini', wire: 'gemini', scenario: 'bad-payload' },
  { kind: 'gemini', wire: 'gemini', scenario: 'unsupported-level' },
])(
  'runs a real pi $wire tool through the gateway without exposing the token to its shell ($scenario)',
  async ({ kind, wire, scenario }) => {
    const configured = scenario !== 'missing-budget' && scenario !== 'catalog'
    const levels = scenario === 'unsupported-level' ? ['low', 'xhigh'] : ['low', 'high']
    const initialModel = scenario === 'catalog' ? 'gpt-4-turbo' : 'service-only-model'
    const root = await mkdtemp(join(tmpdir(), 'latch-pi-gateway-live-'))
    for (const [name, directory] of Object.entries({
      HOME: 'home',
      PI_CODING_AGENT_DIR: 'pi-agent',
      XDG_CONFIG_HOME: 'config',
      XDG_DATA_HOME: 'data',
      XDG_CACHE_HOME: 'cache',
      XDG_STATE_HOME: 'state',
    })) {
      const path = join(root, directory)
      await mkdir(path, { recursive: true })
      vi.stubEnv(name, path)
    }
    if (wire === 'gemini')
      await writeFile(join(root, 'pi-agent', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 512 } }))
    const alterPayload = join(root, 'alter-payload.mjs')
    if (scenario === 'bad-payload')
      await writeFile(
        alterPayload,
        `export default function(pi) { pi.on('before_provider_request', event => ({ ...event.payload, model: 'unexpected-model' })); }`,
      )
    const diagnostic = 'if [ -z "$LMG_TOKEN" ]; then printf gateway-token-hidden; else printf gateway-token-present; fi'
    let phase: 'tools' | 'restored' | 'slow' | 'failure' = 'tools'
    let slowSent = false
    const upstream = await startFakeModels({
      replyFor: request => {
        if (phase === 'failure') return { error: { status: 400, message: 'planned gateway refusal' } }
        if (phase === 'slow') {
          if ((request.body as { tools?: unknown[] }).tools?.length) slowSent = true
          return { text: 'late answer must not arrive', delayMs: 5_000 }
        }
        if (phase === 'restored') return { text: 'restored gateway answer' }
        const hasResult = toolOutputs(request.body).length > 0
        return hasResult
          ? { text: 'native gateway done' }
          : {
              tool: { name: /^(shell|bash)$/u, input: { command: diagnostic, description: 'Check temporary gateway environment' } },
              text: 'diagnostic',
            }
      },
    })
    const diagnostics: string[] = []
    const hostOptions = {
      log: (text: string) => diagnostics.push(text),
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'workspace'),
      commandDirectories: () => [dirname(binary!)],
      loginPrograms: (name: string) => (name === 'pi' ? binary : undefined),
      detectPreset: (preset: AgentPreset) => (preset.id === 'pi' ? { found: true, path: binary! } : { found: false }),
    }
    let host = await startTestHost(hostOptions)
    try {
      let owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: 'Temporary service',
          kind,
          baseURL: `${upstream.origin}/${wire === 'gemini' ? 'v1beta' : 'v1'}`,
          apiKey: 'sk-test-pi-gateway-0123456789',
          models: [initialModel, 'service-only-next'],
          defaultModel: initialModel,
          ...(configured
            ? {
                modelCapabilities: {
                  'service-only-model': { vision: true, thinking: levels },
                  'service-only-next': { vision: true, thinking: levels },
                },
              }
            : {}),
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      expect(
        (
          await owner.confirmed('agents', {
            method: 'POST',
            body: {
              id: 'pi',
              name: 'pi',
              presetId: 'pi',
              command: 'pi',
              args: scenario === 'bad-payload' ? ['-e', alterPayload] : [],
              env: configured ? { PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' } : {},
            },
          })
        ).status,
      ).toBe(201)
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      const withImage = scenario === 'lifecycle'
      if (withImage) {
        const probe = await owner.confirmed('agents/pi/probe', { body: { requestId: randomUUID() } })
        expect(probe.status).toBe(200)
        expect(await probe.json()).toMatchObject({ capabilities: { images: true } })
      }
      const attachment = withImage
        ? await owner.json<{ attachment: AttachmentRef }>('attachments', {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-latch-attachment': Buffer.from(
                JSON.stringify({
                  requestId: randomUUID(),
                  name: 'pixel.png',
                  size: png.length,
                  selection: { harnessId: 'pi', model: { providerId: provider.id, model: initialModel } },
                }),
              ).toString('base64url'),
            },
            rawBody: png,
          })
        : undefined
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'pi',
          prompt: 'Run the supplied harmless diagnostic, then answer.',
          ...(scenario === 'unsupported-level' ? { config: [{ configId: 'thought_level', value: 'xhigh' }] } : {}),
          ...(attachment ? { attachmentIds: [attachment.attachment.id] } : {}),
          requestId: randomUUID(),
          model: { providerId: provider.id, model: initialModel },
        },
      })
      let detail: TaskDetail | undefined
      await vi.waitFor(
        async () => {
          detail = await owner.json<TaskDetail>(`tasks/${started.sessionId}`)
          for (const approval of detail.approvals)
            await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
          expect(['running', 'waiting-approval']).not.toContain(detail.summary.status)
        },
        { timeout: 60_000, interval: 100 },
      )
      if (scenario === 'bad-payload' || scenario === 'unsupported-level') {
        expect(detail!.summary.status).toBe('failed')
        expect(upstream.requests).toHaveLength(0)
        if (scenario === 'bad-payload')
          expect(detail!.messages.map(message => message.text).join('\n')).toContain('model payload is unavailable')
        else
          expect(detail!.config?.find(option => option.category === 'thought_level')?.options.map(option => option.value)).toEqual(['low'])
        return
      }
      if (scenario === 'missing-budget') {
        expect(detail!.summary.status).toBe('failed')
        expect(detail!.messages.map(message => message.text).join('\n')).toContain('PI_GATEWAY_CONTEXT_TOKENS')
        expect(upstream.requests).toHaveLength(0)
        return
      }
      if (detail!.summary.status !== 'idle')
        throw new Error(
          detail!.messages
            .filter(message => message.role === 'system')
            .map(message => message.text)
            .join('\n'),
        )
      if (withImage) expect(upstream.requests.some(request => JSON.stringify(request.body).includes(png.toString('base64')))).toBe(true)
      const outputs = upstream.requests.flatMap(request => toolOutputs(request.body))
      expect(outputs.some(output => output.includes('gateway-token-hidden'))).toBe(true)
      expect(outputs.some(output => output.includes('gateway-token-present'))).toBe(false)
      expect(upstream.requests.every(request => request.model === initialModel && request.wire === wire)).toBe(true)
      expect(detail!.config?.find(option => option.category === 'model')?.currentValue).toBe(`latch-gateway/${initialModel}`)
      expect(detail!.usageReport?.contextSize).toBeUndefined()
      expect(detail!.usageReport?.cost).toBeUndefined()
      if (scenario === 'catalog') {
        expect(detail!.config?.find(option => option.category === 'model')?.options.map(option => option.value)).toEqual([
          `latch-gateway/${initialModel}`,
        ])
        return
      }
      const sessionId = started.sessionId
      const modelId = detail!.config!.find(option => option.category === 'model')!.id
      await owner.json(`tasks/${sessionId}/config`, {
        method: 'POST',
        body: { configId: modelId, value: 'latch-gateway/service-only-next', requestId: randomUUID() },
      })
      const changed = await owner.json<TaskDetail>(`tasks/${sessionId}`)
      const thought = changed.config?.find(option => option.category === 'thought_level')
      expect(thought?.options.some(option => option.value === 'low')).toBe(true)
      await owner.json(`tasks/${sessionId}/config`, {
        method: 'POST',
        body: { configId: thought!.id, value: 'low', requestId: randomUUID() },
      })
      await host.close()
      host = await startTestHost(hostOptions)
      owner = await host.enroll({ listener: 'unix' })
      phase = 'restored'
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Continue after recovery.', requestId: randomUUID() },
      })
      const current = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
      await vi.waitFor(async () => expect((await current()).summary.status).toBe('idle'), { timeout: 30_000 })
      expect(upstream.requests.at(-1)).toMatchObject({ model: 'service-only-next', wire })
      expect((await current()).config?.find(option => option.category === 'model')?.currentValue).toBe('latch-gateway/service-only-next')
      expect(toolOutputs(upstream.requests.at(-1)!.body).some(output => output.includes('gateway-token-hidden'))).toBe(true)
      const body = upstream.requests.at(-1)!.body as Record<string, unknown>
      const evidence = {
        wire,
        thought: (await current()).config?.find(option => option.category === 'thought_level')?.currentValue,
        request: {
          reasoning: body.reasoning,
          reasoning_effort: body.reasoning_effort,
          thinking: body.thinking,
          output_config: body.output_config,
          generationConfig: body.generationConfig,
          max_tokens: body.max_tokens,
          max_output_tokens: body.max_output_tokens,
          max_completion_tokens: body.max_completion_tokens,
        },
      }
      expect(evidence.thought).toBe('low')
      if (wire === 'gemini') {
        expect(body).toMatchObject({
          generationConfig: { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true }, maxOutputTokens: 4096 },
        })
        expect((body.generationConfig as { thinkingConfig: object }).thinkingConfig).not.toHaveProperty('thinkingBudget')
      }
      if (process.env.LATCH_GATEWAY_EVIDENCE_DIR) {
        await mkdir(process.env.LATCH_GATEWAY_EVIDENCE_DIR, { recursive: true })
        await writeFile(join(process.env.LATCH_GATEWAY_EVIDENCE_DIR, `${wire}.json`), JSON.stringify(evidence, null, 2))
      }

      if (wire === 'gemini') {
        const beforeCompact = upstream.requests.length
        await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '/compact', requestId: randomUUID() } })
        await vi.waitFor(async () => expect((await current()).summary.status).toBe('idle'), { timeout: 30_000 })
        expect(upstream.requests.length).toBeGreaterThan(beforeCompact)
        const compactRequest = upstream.requests[beforeCompact]!
        expect(compactRequest.body).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } })
        expect(
          (compactRequest.body as { generationConfig: { thinkingConfig: object } }).generationConfig.thinkingConfig,
        ).not.toHaveProperty('thinkingBudget')
      }

      phase = 'slow'
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Wait for a reply we will stop.', requestId: randomUUID() },
      })
      await vi.waitFor(() => expect(slowSent).toBe(true), { timeout: 15_000 })
      const runId = (await current()).summary.runId
      const stopped = await owner.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
        method: 'POST',
        body: { requestId: randomUUID(), runId },
      })
      expect(stopped.receipt).toMatchObject({ outcome: 'stopped', status: 'cancelled' })
      expect((await current()).messages.some(message => message.text.includes('late answer must not arrive'))).toBe(false)

      phase = 'failure'
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Report the service refusal.', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await current()).summary.status).toBe('failed'), { timeout: 30_000 })
      expect((await current()).messages.map(message => message.text).join('\n')).toContain('planned gateway refusal')
      await writeFile(
        join(root, 'result.json'),
        JSON.stringify({ requests: upstream.requests.length, tokenHidden: true, restored: true, stopped: true, failed: true }),
      )
    } finally {
      await host.close()
      await upstream.close()
      if (process.env.LATCH_GATEWAY_EVIDENCE_DIR) {
        await mkdir(process.env.LATCH_GATEWAY_EVIDENCE_DIR, { recursive: true })
        await writeFile(join(process.env.LATCH_GATEWAY_EVIDENCE_DIR, `diagnostic-${wire}-${scenario}.log`), diagnostics.join('\n'))
      }
      try {
        await assertNoGatewayCredentials(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  90_000,
)
