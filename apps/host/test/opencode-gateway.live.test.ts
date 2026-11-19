import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPreset, AttachmentRef, CancelReceipt, ModelWire, ProviderKind, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

const binary = process.env.LATCH_OPENCODE_GATEWAY_BINARY
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

/** Both routes: OpenCode's own server (the preset, `opencode serve`) and `opencode acp`, which definitions saved with it keep. */
it.skipIf(!binary).each<{ kind: ProviderKind; wire: ModelWire; route: 'direct' | 'acp' }>(
  (['direct', 'acp'] as const).flatMap(route => [
    { kind: 'openai-responses' as const, wire: 'responses' as const, route },
    { kind: 'openai-compatible' as const, wire: 'chat-completions' as const, route },
    { kind: 'anthropic' as const, wire: 'anthropic-messages' as const, route },
  ]),
)(
  'runs a real OpenCode $wire tool through the gateway on the $route route without exposing the token to its shell',
  async ({ kind, wire, route }) => {
    const root = await mkdtemp(join(tmpdir(), 'latch-opencode-gateway-live-'))
    for (const [name, directory] of Object.entries({
      HOME: 'home',
      XDG_CONFIG_HOME: 'config',
      XDG_DATA_HOME: 'data',
      XDG_CACHE_HOME: 'cache',
      XDG_STATE_HOME: 'state',
    })) {
      const path = join(root, directory)
      await mkdir(path, { recursive: true })
      vi.stubEnv(name, path)
    }
    const diagnostic = 'if [ -z "$LMG_TOKEN" ]; then printf gateway-token-hidden; else printf gateway-token-present; fi'
    const mark = async (stage: string) => {
      if (!process.env.LATCH_GATEWAY_EVIDENCE_DIR) return
      await mkdir(process.env.LATCH_GATEWAY_EVIDENCE_DIR, { recursive: true })
      await appendFile(
        join(process.env.LATCH_GATEWAY_EVIDENCE_DIR, `${route}-${wire}-stages.jsonl`),
        `${JSON.stringify({ stage, at: new Date().toISOString() })}\n`,
      )
    }
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
    const hostOptions = {
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'workspace'),
      commandDirectories: () => [dirname(binary!)],
      loginPrograms: (name: string) => (name === 'opencode' ? binary : undefined),
      detectPreset: (preset: AgentPreset) => (preset.id === 'opencode' ? { found: true, path: binary! } : { found: false }),
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
          apiKey: 'sk-test-opencode-gateway-0123456789',
          models: ['service-only-model', 'service-only-next'],
          defaultModel: 'service-only-model',
          modelCapabilities: {
            'service-only-model': { vision: true, thinking: ['low', 'high'] },
            'service-only-next': { vision: true, thinking: ['low', 'high'] },
          },
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
              id: 'opencode',
              name: 'OpenCode',
              presetId: 'opencode',
              command: 'opencode',
              args: route === 'acp' ? ['acp'] : [],
              env: {},
            },
          })
        ).status,
      ).toBe(201)
      await mark('agent-configured')
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      const withImage = true
      if (withImage) {
        const probe = await owner.confirmed('agents/opencode/probe', { body: { requestId: randomUUID() } })
        expect(probe.status).toBe(200)
        expect(await probe.json()).toMatchObject({ capabilities: { images: true } })
      }
      await mark('probed')
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
                  selection: { harnessId: 'opencode', model: { providerId: provider.id, model: 'service-only-model' } },
                }),
              ).toString('base64url'),
            },
            rawBody: png,
          })
        : undefined
      await mark('image-uploaded')
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'opencode',
          prompt: 'Run the supplied harmless diagnostic, then answer.',
          ...(attachment ? { attachmentIds: [attachment.attachment.id] } : {}),
          requestId: randomUUID(),
          model: { providerId: provider.id, model: 'service-only-model' },
        },
      })
      await mark('task-started')
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
      await mark('first-settled')
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
      expect(upstream.requests.every(request => request.model === 'service-only-model' && request.wire === wire)).toBe(true)
      expect(detail!.config?.find(option => option.category === 'model')?.currentValue).toBe('latch/service-only-model')
      const sessionId = started.sessionId
      const modelId = detail!.config!.find(option => option.category === 'model')!.id
      await owner.json(`tasks/${sessionId}/config`, {
        method: 'POST',
        body: { configId: modelId, value: 'latch/service-only-next', requestId: randomUUID() },
      })
      const changed = await owner.json<TaskDetail>(`tasks/${sessionId}`)
      const thought = changed.config?.find(option => option.category === 'thought_level')
      expect(thought?.options.some(option => option.value === 'low')).toBe(true)
      await owner.json(`tasks/${sessionId}/config`, {
        method: 'POST',
        body: { configId: thought!.id, value: 'low', requestId: randomUUID() },
      })
      await mark('thinking-selected')
      await host.close()
      await mark('host-closed')
      host = await startTestHost(hostOptions)
      owner = await host.enroll({ listener: 'unix' })
      await mark('host-restored')
      phase = 'restored'
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Continue after recovery.', requestId: randomUUID() },
      })
      const current = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
      await vi.waitFor(async () => expect((await current()).summary.status).toBe('idle'), { timeout: 30_000 })
      const restoredRequest = upstream.requests.findLast(
        request => request.model === 'service-only-next' && (request.body as { tools?: unknown[] }).tools?.length,
      )
      expect(restoredRequest).toMatchObject({ model: 'service-only-next', wire })
      expect((await current()).config?.find(option => option.category === 'model')?.currentValue).toBe('latch/service-only-next')
      expect(toolOutputs(restoredRequest!.body).some(output => output.includes('gateway-token-hidden'))).toBe(true)
      const body = restoredRequest!.body as Record<string, unknown>
      const evidence = {
        wire,
        thought: (await current()).config?.find(option => option.category === 'thought_level')?.currentValue,
        request: {
          reasoning: body.reasoning,
          reasoning_effort: body.reasoning_effort,
          thinking: body.thinking,
          output_config: body.output_config,
          generationConfig: body.generationConfig,
        },
      }
      expect(evidence.thought).toBe('low')
      expect(body).toMatchObject(
        wire === 'responses'
          ? { reasoning: { effort: 'low' } }
          : wire === 'chat-completions'
            ? { reasoning_effort: 'low' }
            : wire === 'anthropic-messages'
              ? { output_config: { effort: 'low' } }
              : { generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } },
      )
      if (process.env.LATCH_GATEWAY_EVIDENCE_DIR) {
        await mkdir(process.env.LATCH_GATEWAY_EVIDENCE_DIR, { recursive: true })
        await writeFile(join(process.env.LATCH_GATEWAY_EVIDENCE_DIR, `${route}-${wire}.json`), JSON.stringify(evidence, null, 2))
      }

      await mark('reply-restored')
      phase = 'slow'
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Wait for a reply we will stop.', requestId: randomUUID() },
      })
      await vi.waitFor(() => expect(slowSent).toBe(true), { timeout: 15_000 })
      await mark('slow-request-seen')
      const runId = (await current()).summary.runId
      const stopped = await owner.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
        method: 'POST',
        body: { requestId: randomUUID(), runId },
      })
      expect(stopped.receipt).toMatchObject({ outcome: 'stopped', status: 'cancelled' })
      expect((await current()).messages.some(message => message.text.includes('late answer must not arrive'))).toBe(false)

      await mark('stopped')
      phase = 'failure'
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Report the service refusal.', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await current()).summary.status).toBe('failed'), { timeout: 30_000 })
      expect((await current()).messages.map(message => message.text).join('\n')).toContain('planned gateway refusal')
      await mark('failure-settled')
      await writeFile(
        join(root, 'result.json'),
        JSON.stringify({ requests: upstream.requests.length, tokenHidden: true, restored: true, stopped: true, failed: true }),
      )
    } finally {
      await host.close()
      await upstream.close()
      try {
        await assertNoGatewayCredentials(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  90_000,
)
