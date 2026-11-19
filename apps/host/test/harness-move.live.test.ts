import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { AgentPreset, ProviderKind, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { startRecordingUpstream, type RecordingUpstream } from './helpers/recording-upstream.ts'

/**
 * A conversation that goes on with another Harness, between real ones: every ordered pair of the Harnesses whose path is
 * set (the same switches as the gateway live tests). The conversation starts on the first, moves to the second, and
 * comes back to the first.
 *
 * Two ways to run it. By default every model request goes to a local recording service through Latch's model services,
 * under temporary HOME and config directories, and the test reads what each Harness actually sent: the second must be
 * sent what was said on the first, and the first, back again, what was said on the second. With `LATCH_RELAY_REAL=1`
 * each Harness runs as the person has it, signed in, on its own model, with one-line prompts: each is told a code word
 * and the next must say it back. `LATCH_RELAY_EVIDENCE_DIR` collects one JSON line per pair.
 */

const REAL = process.env.LATCH_RELAY_REAL === '1'
const HOMES = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']

interface Setup {
  binary: string | undefined
  preset: string
  program: string
  command: (binary: string) => string
  args: string[]
  homes: string[]
  /** The service protocol it is given in the recorded run, so the pairs cross protocols as well as Harnesses. */
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

const MODEL = 'relay-check-model'
const set = Object.entries(HARNESSES).filter(([, setup]) => setup.binary)
const only = process.env.LATCH_RELAY_PAIRS?.split(',')
const pairs = set
  .flatMap(([from]) => set.filter(([to]) => to !== from).map(([to]) => ({ from, to })))
  .filter(pair => !only || only.includes(`${pair.from}-${pair.to}`))

let root = ''
let host: TestHost
let upstream: RecordingUpstream | undefined
let owner: Awaited<ReturnType<TestHost['enroll']>>
const providers = new Map<ProviderKind, string>()
const evidenceDir = process.env.LATCH_RELAY_EVIDENCE_DIR

beforeAll(async () => {
  if (pairs.length === 0) return
  root = await mkdtemp(join(tmpdir(), 'latch-relay-live-'))
  if (!REAL) {
    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1')
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(name, 'http://127.0.0.1:9')
    for (const name of new Set([...HOMES, ...set.flatMap(([, setup]) => setup.homes)])) {
      const path = join(root, name.toLowerCase())
      await mkdir(path, { recursive: true })
      vi.stubEnv(name, path)
    }
    let n = 0
    upstream = await startRecordingUpstream({ plan: () => ({ text: `Relay reply MANGO${++n} given.` }), gapMs: 5 })
  }
  const by = (pick: (setup: Setup) => string) => new Map(set.map(([, setup]) => [pick(setup), setup.binary!]))
  const programs = by(setup => setup.program)
  const presets = by(setup => setup.preset)
  host = await startTestHost({
    demo: false,
    dataDir: join(root, 'host'),
    workspaceRoot: join(root, 'project'),
    commandDirectories: () => [...new Set(set.map(([, setup]) => dirname(setup.binary!)))],
    loginPrograms: (name: string) => programs.get(name),
    detectPreset: (preset: AgentPreset) => (presets.has(preset.id) ? { found: true, path: presets.get(preset.id)! } : { found: false }),
  })
  owner = await host.enroll({ listener: 'unix' })
  if (upstream)
    for (const kind of new Set(set.map(([, setup]) => setup.kind))) {
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: `Relay ${kind}`,
          kind,
          baseURL: `${upstream.origin}/v1`,
          apiKey: 'sk-test-relay-live-0123456789',
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
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
}, 120_000)

afterAll(async () => {
  await host?.close()
  await upstream?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)

/** Starts a session and waits for its first turn; every approval is allowed (none is expected: the prompts ask for words only). */
async function start(harness: string, prompt: string, forkOf?: { taskId: string; upToMessageId: string }): Promise<TaskDetail> {
  const provider = providers.get(HARNESSES[harness]!.kind)
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: {
      harnessId: harness,
      prompt,
      requestId: randomUUID(),
      ...(provider ? { model: { providerId: provider, model: MODEL } } : {}),
      ...(forkOf ? { forkOf: { ...forkOf, moved: true } } : {}),
    },
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  const until = Date.now() + 150_000
  for (;;) {
    const current = await detail(sessionId)
    for (const approval of current.approvals)
      await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
    const opened = current.messages.find(message => message.role === 'user')
    if (opened?.turn?.endedAt && !['running', 'waiting-approval'].includes(current.summary.status)) return current
    if (Date.now() > until) throw new Error(`${harness} did not settle: ${notes(current)}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

const notes = (current: TaskDetail) =>
  current.messages
    .filter(message => message.role === 'system')
    .map(message => message.text)
    .join(' | ')
    .slice(0, 500)
const reply = (current: TaskDetail) =>
  current.messages
    .filter(message => message.role === 'assistant')
    .map(message => message.text)
    .join('\n')
const end = (current: TaskDetail) => ({ taskId: current.summary.id, upToMessageId: current.messages.at(-1)!.id })
/** Everything the Harness sent the service in the request that asked `mark`, as one text. */
const sent = (mark: string) => {
  const request = upstream!.requests.findLast(item => JSON.stringify(item.body).includes(mark))
  return request ? JSON.stringify(request.body) : ''
}

if (pairs.length === 0) it.skip('moves a conversation between real Harnesses (fewer than two Harness switches set)', () => {})
else
  it.each(pairs)(
    `moves a conversation from $from to $to and back (${REAL ? 'their own models' : 'recorded service'})`,
    async ({ from, to }) => {
      const tag = `${from}-${to}-${randomUUID().slice(0, 6)}`.toUpperCase()
      const [kiwi, pear] = [`KIWI-${tag}`, `PEAR-${tag}`]
      const first = await start(from, `The code word is ${kiwi}. Reply with only: noted.`)
      expect(first.summary.status, notes(first)).toBe('idle')
      const second = await start(
        to,
        `Say the code word you were told earlier, then remember a second one: ${pear}. Reply in one line.`,
        end(first),
      )
      expect(second.summary.status, notes(second)).toBe('idle')
      expect(second.summary.forkOf?.moved).toEqual({ from })
      const back = await start(from, 'Reply with both code words from this conversation, in one line.', end(second))
      expect(back.summary.status, notes(back)).toBe('idle')
      const opening = back.messages.find(message => message.role === 'user')
      const native = opening?.nativeFork === true
      const evidence: Record<string, unknown> = { from, to, real: REAL, resumedOwnSession: native, notes: notes(back) || undefined }
      if (upstream) {
        // What the second was sent holds the first's turn; what the first was sent, back again, holds both.
        const [toSecond, toBack] = [sent(pear), sent('Reply with both code words')]
        evidence.secondSentFirstTurn = toSecond.includes(kiwi)
        evidence.backSentBoth = toBack.includes(kiwi) && toBack.includes(pear)
        // Its own record of the first turn, not the Host's text record of it, when it went on from its own session.
        evidence.backSentTextRecord = toBack.includes('以下是会话')
        expect(toSecond).toContain(kiwi)
        expect(toBack).toContain(kiwi)
        expect(toBack).toContain(pear)
        if (native) expect(toBack).not.toContain('以下是会话')
      } else {
        evidence.second = reply(second).slice(0, 200)
        evidence.back = reply(back).slice(0, 200)
        expect(reply(second)).toContain(kiwi)
        expect(reply(back)).toContain(kiwi)
        expect(reply(back)).toContain(pear)
      }
      if (evidenceDir)
        await writeFile(join(evidenceDir, `relay-${REAL ? 'real' : 'recorded'}-${from}-${to}.json`), `${JSON.stringify(evidence)}\n`)
    },
    480_000,
  )
