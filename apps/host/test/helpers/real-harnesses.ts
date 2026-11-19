/**
 * A test Host with every real Harness whose path is set (the gateway live tests' switches), for live tests that need
 * more than one at once. Recorded: every model request goes to a local recording service through Latch's model services,
 * under temporary HOME and config directories. Real: each Harness runs as the person has it, signed in, on its own model.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, vi } from 'vitest'
import type { AgentPreset, ProviderKind, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './host.ts'
import { startRecordingUpstream, type RecordingUpstream, type UpstreamReply, type UpstreamRequest } from './recording-upstream.ts'

const HOMES = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']

interface Setup {
  binary: string | undefined
  preset: string
  program: string
  command: (binary: string) => string
  args: string[]
  homes: string[]
  /** The service protocol it is given in a recorded run, so the Harnesses cross protocols too. */
  kind: ProviderKind
}

const claude = process.env.LATCH_CLAUDE_GATEWAY_BINARY ?? process.env.LATCH_CLAUDE_DIRECT_BINARY
const HARNESSES: Record<string, Setup> = {
  codex: {
    binary: process.env.LATCH_CODEX_GATEWAY_BINARY,
    preset: 'codex',
    program: 'codex',
    command: binary => binary,
    args: [],
    homes: ['CODEX_HOME'],
    kind: 'openai-responses',
  },
  claude: {
    binary: claude,
    preset: 'claude-agent',
    program: claude?.endsWith('/claude') ? 'claude' : 'claude-agent-acp',
    command: binary => binary,
    args: claude?.endsWith('/claude') ? [] : ['--hide-claude-auth'],
    homes: ['CLAUDE_CONFIG_DIR'],
    kind: 'anthropic',
  },
  opencode: {
    binary: process.env.LATCH_OPENCODE_GATEWAY_BINARY,
    preset: 'opencode',
    program: 'opencode',
    command: () => 'opencode',
    args: ['acp'],
    homes: [],
    kind: 'openai-compatible',
  },
  pi: {
    binary: process.env.LATCH_PI_GATEWAY_BINARY,
    preset: 'pi',
    program: 'pi',
    command: () => 'pi',
    args: [],
    homes: ['PI_CODING_AGENT_DIR'],
    kind: 'anthropic',
  },
  dsh: {
    binary: process.env.LATCH_DSH_GATEWAY_BINARY,
    preset: 'dsh',
    program: 'dsh',
    command: () => 'dsh',
    args: ['--profile', 'acp'],
    homes: ['DSH_HOME'],
    kind: 'openai-compatible',
  },
}

const MODEL = 'live-check-model'

/** The Harnesses whose path is set, by the id each is defined under. */
export const liveHarnesses: string[] = Object.entries(HARNESSES)
  .filter(([, setup]) => setup.binary)
  .map(([id]) => id)

export interface RealHarnessHost {
  host: TestHost
  owner: Awaited<ReturnType<TestHost['enroll']>>
  /** The recording service, in a recorded run. */
  upstream?: RecordingUpstream
  detail(sessionId: string): Promise<TaskDetail>
  /** What a new session of `harness` takes for its model: the recorded service's, or nothing (its own). */
  model(harness: string): { model?: { providerId: string; model: string } }
  /** Waits for the session's first turn to end, allowing every approval. */
  firstTurn(sessionId: string, limitMs?: number): Promise<TaskDetail>
  close(): Promise<void>
}

export async function startRealHarnessHost(options: {
  real: boolean
  plan?: (request: UpstreamRequest) => UpstreamReply
}): Promise<RealHarnessHost> {
  const set = Object.entries(HARNESSES).filter(([, setup]) => setup.binary)
  const root = await mkdtemp(join(tmpdir(), 'latch-live-harnesses-'))
  let upstream: RecordingUpstream | undefined
  if (!options.real) {
    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1')
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(name, 'http://127.0.0.1:9')
    for (const name of new Set([...HOMES, ...set.flatMap(([, setup]) => setup.homes)])) {
      const path = join(root, name.toLowerCase())
      await mkdir(path, { recursive: true })
      vi.stubEnv(name, path)
    }
    let n = 0
    upstream = await startRecordingUpstream({ plan: options.plan ?? (() => ({ text: `Recorded reply MANGO${++n} given.` })), gapMs: 5 })
  }
  const by = (pick: (setup: Setup) => string) => new Map(set.map(([, setup]) => [pick(setup), setup.binary!]))
  const programs = by(setup => setup.program)
  const presets = by(setup => setup.preset)
  const host = await startTestHost({
    demo: false,
    dataDir: join(root, 'host'),
    workspaceRoot: join(root, 'project'),
    commandDirectories: () => [...new Set(set.map(([, setup]) => dirname(setup.binary!)))],
    loginPrograms: (name: string) => programs.get(name),
    detectPreset: (preset: AgentPreset) => (presets.has(preset.id) ? { found: true, path: presets.get(preset.id)! } : { found: false }),
  })
  const owner = await host.enroll({ listener: 'unix' })
  const providers = new Map<ProviderKind, string>()
  if (upstream)
    for (const kind of new Set(set.map(([, setup]) => setup.kind))) {
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: `Live ${kind}`,
          kind,
          baseURL: `${upstream.origin}/v1`,
          apiKey: 'sk-test-live-harnesses-0123456789',
          models: [MODEL],
          defaultModel: MODEL,
          modelCapabilities: { [MODEL]: { contextTokens: 200_000 } },
          confirmOrigin: true,
        },
      })
      expect(added.status, await added.clone().text()).toBe(201)
      providers.set(kind, ((await added.json()) as { provider: ProviderSettings }).provider.id)
    }
  for (const [id, setup] of set) {
    const added = await owner.confirmed('agents', {
      method: 'POST',
      body: { id, name: id, presetId: setup.preset, command: setup.command(setup.binary!), args: setup.args, env: {} },
    })
    expect(added.status, await added.clone().text()).toBe(201)
  }
  const detail = (sessionId: string) => owner.json<TaskDetail>(`tasks/${sessionId}`)
  return {
    host,
    owner,
    ...(upstream ? { upstream } : {}),
    detail,
    model(harness) {
      const provider = providers.get(HARNESSES[harness]!.kind)
      return provider ? { model: { providerId: provider, model: MODEL } } : {}
    },
    async firstTurn(sessionId, limitMs = 150_000) {
      const until = Date.now() + limitMs
      for (;;) {
        const current = await detail(sessionId)
        for (const approval of current.approvals)
          await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
        const opened = current.messages.find(message => message.role === 'user')
        if (opened?.turn?.endedAt && !['running', 'waiting-approval'].includes(current.summary.status)) return current
        if (Date.now() > until) throw new Error(`the session did not settle: ${systemNotes(current)}`)
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    },
    async close() {
      await host.close()
      await upstream?.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** What the Host wrote into the session itself (refusals, failures), for a failing assertion's message. */
export const systemNotes = (current: TaskDetail): string =>
  current.messages
    .filter(message => message.role === 'system')
    .map(message => message.text)
    .join(' | ')
    .slice(0, 500)

export const replies = (current: TaskDetail): string =>
  current.messages
    .filter(message => message.role === 'assistant')
    .map(message => message.text)
    .join('\n')
