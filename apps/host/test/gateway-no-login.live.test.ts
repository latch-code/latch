import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_PRESETS, type AgentPreset, type ModelWire, type ProviderKind, type ProviderSettings, type TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

/**
 * A real Harness with no login of its own, on a model of a Latch service: one tiny turn through the gateway to a local
 * fake service. Opt-in per Harness by `LATCH_NO_LOGIN_<ID>` naming its binary (`LATCH_NO_LOGIN_CODEX=/path/to/codex`).
 * Every home the program may read is an empty temporary directory, so no login exists and none of the person's is read.
 */
const KINDS: Record<ModelWire, ProviderKind> = {
  responses: 'openai-responses',
  'chat-completions': 'openai-compatible',
  'anthropic-messages': 'anthropic',
}
type Wire = keyof typeof KINDS

const ROWS: Array<{ id: string; wires: Wire[]; homes: string[]; env?: Record<string, string> }> = [
  { id: 'codex', wires: ['responses'], homes: ['CODEX_HOME', 'CODEX_SQLITE_HOME'] },
  // A model its catalogue does not know needs the operating bounds its gateway extension asks for.
  {
    id: 'pi',
    wires: ['chat-completions'],
    homes: ['PI_CODING_AGENT_DIR'],
    env: { PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' },
  },
  { id: 'opencode', wires: ['chat-completions'], homes: [] },
  { id: 'dsh', wires: ['chat-completions'], homes: ['DSH_HOME'] },
  { id: 'qwen', wires: ['chat-completions', 'responses', 'anthropic-messages'], homes: ['QWEN_HOME', 'QWEN_RUNTIME_DIR'] },
  // Its key store is the system keyring, which is not under any home: switched off, so the person's is never asked.
  {
    id: 'goose',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    homes: ['GOOSE_PATH_ROOT'],
    env: { GOOSE_DISABLE_KEYRING: '1' },
  },
  { id: 'grok', wires: ['chat-completions', 'responses', 'anthropic-messages'], homes: ['GROK_HOME'] },
]

const binaryOf = (id: string) => process.env[`LATCH_NO_LOGIN_${id.toUpperCase()}`]
const cases = ROWS.flatMap(row => (binaryOf(row.id) ? row.wires.map(wire => ({ ...row, wire, binary: binaryOf(row.id)! })) : []))

afterEach(() => vi.unstubAllEnvs())

it.skipIf(cases.length === 0).each(cases)(
  'runs a real $id turn over $wire through the gateway with no login of its own',
  async ({ id, wire, binary, homes, env }) => {
    const preset = AGENT_PRESETS.find(item => item.id === id)!
    const root = await mkdtemp(join(tmpdir(), `latch-no-login-${id}-`))
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', ...homes]) {
      const path = join(root, 'homes', name.toLowerCase())
      await mkdir(path, { recursive: true })
      vi.stubEnv(name, path)
    }
    const upstream = await startFakeModels({ replies: [{ text: 'answer without a login' }] })
    const evidence: Record<string, unknown> = { harness: id, wire, binary, at: new Date().toISOString() }
    const save = async () => {
      const directory = process.env.LATCH_GATEWAY_EVIDENCE_DIR
      if (!directory) return
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${id}-${wire}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
    }
    // The Host's own log, already redacted: where a Harness's last words go when it fails.
    const logged: string[] = []
    const host = await startTestHost({
      demo: false,
      log: text => void logged.push(text),
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'workspace'),
      commandDirectories: () => [dirname(binary)],
      loginPrograms: (name: string) => (name === preset.command ? binary : undefined),
      detectPreset: (item: AgentPreset) => (item.id === id ? { found: true, path: binary } : { found: false }),
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: 'Temporary service',
          kind: KINDS[wire],
          baseURL: `${upstream.origin}/v1`,
          apiKey: 'sk-test-no-login-0123456789abcdef',
          models: ['fake-model'],
          defaultModel: 'fake-model',
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      const saved = await owner.confirmed('agents', {
        method: 'POST',
        body: { id, name: preset.name, presetId: id, command: preset.command, args: preset.args, env: env ?? {} },
      })
      expect(saved.status).toBe(201)
      const started = await owner.request('tasks', {
        method: 'POST',
        body: {
          harnessId: id,
          prompt: 'Reply with one short sentence.',
          requestId: randomUUID(),
          model: { providerId: provider.id, model: 'fake-model' },
        },
      })
      evidence.start = started.status
      if (started.status >= 300) {
        evidence.refused = await started.json()
        await save()
        throw new Error(`the start was refused: ${JSON.stringify(evidence.refused)}`)
      }
      const { sessionId } = (await started.json()) as { sessionId: string }
      let detail: TaskDetail | undefined
      await vi.waitFor(
        async () => {
          detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
          for (const approval of detail.approvals)
            await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
          expect(['running', 'waiting-approval']).not.toContain(detail.summary.status)
        },
        { timeout: 120_000, interval: 200 },
      )
      const said = (role: string) =>
        detail!.messages
          .filter(message => message.role === role)
          .map(message => message.text.slice(0, 400))
          .join('\n')
      Object.assign(evidence, {
        status: detail!.summary.status,
        runEnd: detail!.summary.runEnd?.reason,
        route: detail!.summary.modelRoute,
        assistant: said('assistant'),
        system: said('system'),
        upstream: upstream.requests.map(request => ({ wire: request.wire, model: request.model })),
        models: detail!.config?.find(option => option.category === 'model')?.options.map(option => option.value),
        ...(detail!.summary.status === 'idle' ? {} : { hostLog: logged.slice(-12).map(line => line.slice(0, 1200)) }),
      })
      await save()
      expect(detail!.summary.runEnd?.reason).not.toBe('login-required')
      expect(evidence.system).not.toContain('还没登录')
      expect(detail!.summary.status).toBe('idle')
      expect(evidence.assistant).toContain('answer without a login')
      expect(upstream.requests.length).toBeGreaterThan(0)
      expect(upstream.requests.every(request => request.wire === wire && request.model === 'fake-model')).toBe(true)
      expect(detail!.summary.modelRoute).toMatchObject({ providerId: provider.id, model: 'fake-model' })
      expect(detail!.summary.modelRoute).not.toHaveProperty('bypassed')
    } finally {
      await host.close()
      await upstream.close()
      await assertNoGatewayCredentials(root).finally(() => rm(root, { recursive: true, force: true }))
    }
  },
  180_000,
)
