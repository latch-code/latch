import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot, AttachmentRef, CancelReceipt, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

const binary = process.env.LATCH_CLAUDE_GATEWAY_BINARY
afterEach(() => vi.unstubAllEnvs())
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

it.skipIf(!binary).each(['anthropic', 'openai-compatible'] as const)(
  'runs Claude through the %s gateway without giving its token to Bash, hooks or MCP',
  async kind => {
    const root = await mkdtemp(join(tmpdir(), 'latch-claude-gateway-boundary-'))
    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1')
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(name, 'http://127.0.0.1:9')
    for (const [key, leaf] of Object.entries({
      HOME: 'home',
      XDG_CONFIG_HOME: 'xdg-config',
      XDG_DATA_HOME: 'xdg-data',
      XDG_CACHE_HOME: 'xdg-cache',
      XDG_STATE_HOME: 'xdg-state',
    })) {
      const path = join(root, leaf)
      await mkdir(path, { recursive: true })
      vi.stubEnv(key, path)
    }
    const fakeValue = 'sk-test-claude-upstream-0123456789'
    let observed: 'TOKEN_PRESENT' | 'TOKEN_ABSENT' | undefined
    let extra: boolean | undefined
    let control: boolean | undefined
    let thoughtReplayed = false
    let phase: 'tools' | 'followup' | 'slow' | 'failure' = 'tools'
    const model = await startFakeModels({
      replyFor: request => {
        if (phase === 'followup') return { text: 'restored gateway answer' }
        if (phase === 'slow') return { text: 'late answer must not arrive', delayMs: 5000 }
        if (phase === 'failure') return { error: { status: 400, message: 'planned gateway refusal' } }
        const body = request.body as {
          messages?: Array<{ role: string; content?: unknown; reasoning_content?: string }>
          tools?: unknown[]
        }
        if (body.messages?.some(message => message.reasoning_content === 'Gateway source reasoning')) thoughtReplayed = true
        const outputs = (body.messages ?? []).flatMap(message =>
          message.role === 'tool'
            ? [JSON.stringify(message.content)]
            : message.role === 'user' && Array.isArray(message.content)
              ? message.content.filter(block => block.type === 'tool_result').map(block => JSON.stringify(block.content))
              : [],
        )
        if (outputs.length) {
          const present = outputs.some(value => value.includes('TOKEN_PRESENT'))
          const absent = outputs.some(value => value.includes('TOKEN_ABSENT'))
          if (present !== absent) observed = present ? 'TOKEN_PRESENT' : 'TOKEN_ABSENT'
          extra = outputs.some(value => value.includes('EXTRA_PRESENT'))
          control = outputs.some(value => value.includes('CONTROL_PRESENT'))
          return { text: 'boundary probe complete' }
        }
        if (!body.tools?.length) return { text: 'boundary probe' }
        return {
          ...(kind === 'openai-compatible' ? { reasoning: 'Gateway source reasoning' } : {}),
          tool: {
            name: /^Bash$/u,
            input: {
              command: `if [ -n "\${ANTHROPIC_AUTH_TOKEN:-}" ]; then printf '%s%s' TOKEN_ PRESENT; else printf '%s%s' TOKEN_ ABSENT; fi; if [ -n \"\${PROBE_SECRET:-}\" ]; then printf '%s%s' EXTRA_ PRESENT; else printf '%s%s' EXTRA_ ABSENT; fi; if [ -n \"\${PROBE_BOUNDARY:-}\" ]; then printf '%s%s' CONTROL_ PRESENT; else printf '%s%s' CONTROL_ ABSENT; fi`,
              description: 'Check only whether the supplied fake value exists.',
            },
          },
        }
      },
    })
    const trap = await startFakeModels({ replyFor: () => ({ text: 'route should not reach this service' }) })
    const diagnosticScript = join(root, 'diagnostic.mjs')
    const hookOutput = join(root, 'hook.json')
    const mcpOutput = join(root, 'mcp.json')
    await writeFile(
      diagnosticScript,
      `import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(process.argv[2], JSON.stringify({ token: Boolean(process.env.ANTHROPIC_AUTH_TOKEN), extra: Boolean(process.env.PROBE_SECRET), control: Boolean(process.env.PROBE_BOUNDARY) }));
if (process.argv[3] !== 'hook') createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'boundary-probe', version: '1.0.0' } } : request.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
    )
    await mkdir(join(root, 'project'), { recursive: true })
    await writeFile(
      join(root, 'project', '.mcp.json'),
      JSON.stringify({ mcpServers: { boundary: { command: process.execPath, args: [diagnosticScript, mcpOutput] } } }),
    )
    const config = join(root, 'claude-config')
    await mkdir(config)
    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({
        enableAllProjectMcpServers: true,
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: [process.execPath, diagnosticScript, hookOutput, 'hook'].map(shellQuote).join(' '),
                },
              ],
            },
          ],
        },
        env: {
          ANTHROPIC_BASE_URL: trap.origin,
          ANTHROPIC_AUTH_TOKEN: 'fake-project-override',
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
        },
      }),
      { mode: 0o600 },
    )
    const hostOptions = {
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [dirname(binary!)],
      loginPrograms: (name: string) => (name === 'claude-agent-acp' ? binary : undefined),
      detectPreset: (preset: { id: string }) => (preset.id === 'claude-agent' ? { found: true, path: binary! } : { found: false }),
    }
    let host = await startTestHost(hostOptions)
    try {
      let owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: 'Temporary Claude service',
          kind,
          baseURL: `${model.origin}/v1`,
          apiKey: fakeValue,
          models: ['fake-model', 'service-only-next'],
          modelCapabilities: Object.fromEntries(
            ['fake-model', 'service-only-next'].map(model => [
              model,
              { vision: true, thinking: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
            ]),
          ),
          defaultModel: 'fake-model',
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      const saved = await owner.confirmed('agents', {
        method: 'POST',
        body: {
          id: 'probe-claude',
          name: 'Claude Code',
          presetId: 'claude-agent',
          command: binary!,
          args: ['--hide-claude-auth'],
          env: { PROBE_SECRET: 'fake-other-credential', PROBE_BOUNDARY: 'public-probe-value' },
        },
      })
      expect(saved.status).toBe(201)
      const catalog = (await owner.json<AppSnapshot>('snapshot')).catalog
      expect(catalog?.harnesses.find(harness => harness.id === 'probe-claude')?.capabilities.models.wires).toEqual(['anthropic-messages'])
      const probe = await owner.confirmed('agents/probe-claude/probe', { body: { requestId: randomUUID() } })
      expect(probe.status).toBe(200)
      expect(await probe.json()).toMatchObject({ capabilities: { images: true } })
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      const attachment = await owner.json<{ attachment: AttachmentRef }>('attachments', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(
            JSON.stringify({
              requestId: randomUUID(),
              name: 'pixel.png',
              size: png.length,
              selection: { harnessId: 'probe-claude', model: { providerId: provider.id, model: 'fake-model' } },
            }),
          ).toString('base64url'),
        },
        rawBody: png,
      })
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'probe-claude',
          model: { providerId: provider.id, model: 'fake-model' },
          attachmentIds: [attachment.attachment.id],
          prompt: 'Run the supplied environment presence diagnostic and reply once.',
          requestId: randomUUID(),
          config: [{ configId: '~mode', value: 'bypassPermissions' }],
        },
      })
      const detail = () => owner.json<TaskDetail>(`tasks/${started.sessionId}`)
      await vi.waitFor(async () => expect(['idle', 'failed']).toContain((await detail()).summary.status), { timeout: 60_000 })
      const current = await detail()
      const diagnostic = current.messages
        .filter(message => message.role === 'system')
        .map(message => message.text.replaceAll(fakeValue, '[redacted]'))
        .join('\n')
      expect(current.summary.status, diagnostic).toBe('idle')
      expect(JSON.stringify(current).includes(fakeValue)).toBe(false)
      expect(current.usageReport?.contextSize).toBeUndefined()
      expect(current.usageReport?.cost).toBeUndefined()
      expect(control).toBe(true)
      expect({ observed, extra }).toEqual({ observed: 'TOKEN_ABSENT', extra: true })
      expect(JSON.parse(await readFile(hookOutput, 'utf8'))).toEqual({ token: false, extra: true, control: true })
      expect(JSON.parse(await readFile(mcpOutput, 'utf8'))).toEqual({ token: false, extra: true, control: true })
      expect(trap.requests).toHaveLength(0)
      expect(model.requests.length > 1).toBe(true)
      expect(model.requests.every(request => request.model === 'fake-model')).toBe(true)
      expect(model.requests.some(request => JSON.stringify(request.body).includes(png.toString('base64')))).toBe(true)
      if (kind === 'openai-compatible') expect(thoughtReplayed).toBe(true)
      expect(current.config?.find(option => option.category === 'model')?.currentValue).toBe('fake-model')
      expect(
        model.requests.every(
          request => request.wire === (kind === 'anthropic' ? 'anthropic-messages' : 'chat-completions') && request.key === fakeValue,
        ),
      ).toBe(true)
      const modelOption = current.config!.find(option => option.category === 'model')!
      expect(modelOption.options.some(option => option.value === 'service-only-next')).toBe(true)
      await owner.json(`tasks/${started.sessionId}/config`, {
        method: 'POST',
        body: { configId: modelOption.id, value: 'service-only-next', requestId: randomUUID() },
      })
      phase = 'followup'
      await owner.json(`tasks/${started.sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Continue on the selected model.', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 30_000 })
      expect(model.requests.at(-1)?.model).toBe('service-only-next')
      await host.close()
      host = await startTestHost(hostOptions)
      owner = await host.enroll({ listener: 'unix' })
      await owner.json(`tasks/${started.sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Continue after Host recovery.', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 30_000 })
      expect(model.requests.at(-1)?.model).toBe('service-only-next')
      expect((await detail()).config?.find(option => option.category === 'model')?.currentValue).toBe('service-only-next')

      phase = 'slow'
      const beforeSlow = model.requests.length
      await owner.json(`tasks/${started.sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Wait for a response we will stop.', requestId: randomUUID() },
      })
      await vi.waitFor(() => expect(model.requests.length).toBeGreaterThan(beforeSlow), { timeout: 15_000 })
      const runId = (await detail()).summary.runId
      const stopped = await owner.json<{ receipt: CancelReceipt }>(`tasks/${started.sessionId}/cancel`, {
        method: 'POST',
        body: { requestId: randomUUID(), runId },
      })
      expect(stopped.receipt).toMatchObject({ outcome: 'stopped', status: 'cancelled' })
      expect((await detail()).messages.some(message => message.text.includes('late answer must not arrive'))).toBe(false)

      phase = 'failure'
      await owner.json(`tasks/${started.sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Report the service refusal.', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('failed'), { timeout: 30_000 })
      expect((await detail()).messages.map(message => message.text).join('\n')).toContain('planned gateway refusal')
      expect(trap.requests).toHaveLength(0)
    } finally {
      await host.close()
      await model.close()
      await trap.close()
      try {
        await assertNoGatewayCredentials(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  90_000,
)

it.skipIf(!binary).each([false, true])(
  'uses the user API key helper only on the native Claude route (gateway=%s)',
  async routed => {
    const root = await mkdtemp(join(tmpdir(), 'latch-claude-helper-'))
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR']) {
      const directory = join(root, name.toLowerCase())
      await mkdir(directory)
      vi.stubEnv(name, directory)
    }
    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1')
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(name, 'http://127.0.0.1:9')
    const helperKey = 'sk-test-claude-helper-0123456789'
    const serviceKey = 'sk-test-claude-service-0123456789'
    const marker = join(root, 'helper-count')
    const helper = join(root, 'helper.mjs')
    await writeFile(
      helper,
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, '1\\n', { mode: 0o600 }); process.stdout.write(${JSON.stringify(helperKey)});`,
      { mode: 0o600 },
    )
    const model = await startFakeModels({ replies: [{ text: 'helper route complete' }] })
    await writeFile(
      join(root, 'claude_config_dir', 'settings.json'),
      JSON.stringify({
        apiKeyHelper: [process.execPath, helper].map(shellQuote).join(' '),
        env: { ANTHROPIC_BASE_URL: model.origin, ANTHROPIC_MODEL: 'helper-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      }),
      { mode: 0o600 },
    )
    const host = await startTestHost({
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [dirname(binary!)],
      loginPrograms: name => (name === 'claude-agent-acp' ? binary : undefined),
      detectPreset: preset => (preset.id === 'claude-agent' ? { found: true, path: binary! } : { found: false }),
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        body: {
          name: 'Temporary helper service',
          kind: 'anthropic',
          baseURL: `${model.origin}/v1`,
          apiKey: serviceKey,
          models: ['helper-model'],
          defaultModel: 'helper-model',
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      expect(
        (
          await owner.confirmed('agents', {
            body: {
              id: 'helper-claude',
              name: 'Claude Code',
              presetId: 'claude-agent',
              command: binary!,
              args: ['--hide-claude-auth'],
              env: {},
            },
          })
        ).status,
      ).toBe(201)
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'helper-claude',
          prompt: 'Reply once.',
          requestId: randomUUID(),
          ...(routed ? { model: { providerId: provider.id, model: 'helper-model' } } : {}),
        },
      })
      const detail = () => owner.json<TaskDetail>(`tasks/${started.sessionId}`)
      await vi.waitFor(async () => expect(['idle', 'failed']).toContain((await detail()).summary.status), { timeout: 30_000 })
      const current = await detail()
      expect(
        current.summary.status,
        current.messages
          .filter(message => message.role === 'system')
          .map(message => message.text)
          .join('\n'),
      ).toBe('idle')
      expect(model.requests.length).toBeGreaterThan(0)
      expect(model.requests.every(request => request.key === (routed ? serviceKey : helperKey))).toBe(true)
      if (routed) await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      else expect((await readFile(marker, 'utf8')).trim().length).toBeGreaterThan(0)
      expect(JSON.stringify(current)).not.toContain(helperKey)
      expect(JSON.stringify(current)).not.toContain(serviceKey)
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
  60_000,
)
