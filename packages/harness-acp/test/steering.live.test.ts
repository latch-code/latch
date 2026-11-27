import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startFakeModels, type FakeModelRequest, type FakeReply } from '@latch/testkit'
import { agentEnvironment } from '../src/environment.ts'
import { opencodeProfile } from '../src/profiles/opencode.ts'
import { clientCapabilities, STEER_METHOD } from '../src/protocol.ts'
import { ClaudeWire } from '../src/wires/claude.ts'
import { openWire } from '../src/wires/index.ts'
import type { AgentWire, WireHandlers } from '../src/wires/types.ts'

/**
 * Adding to a running turn with the installed `claude` and `opencode`, each on a temporary home and a local fake model:
 * no login, no paid model. Opt-in with the programs' paths.
 */
const claude = process.env.LATCH_CLAUDE_DIRECT_BINARY
const opencode = process.env.LATCH_OPENCODE_GATEWAY_BINARY

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const MARK = 'STEER-MARK-7f3a'
const said = (request: FakeModelRequest, text: string) => JSON.stringify(request.body).includes(text)
/** The newest message of a model request: what the harness just sent, apart from the history before it. */
const last = (request: FakeModelRequest) => {
  const message = ((request.body as { messages?: Array<{ role?: string }> }).messages ?? []).at(-1)
  return { role: message?.role, says: (text: string) => JSON.stringify(message ?? null).includes(text) }
}

async function home(prefix: string): Promise<{ root: string; cwd: string; env: Record<string, string> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const user = join(root, 'home')
  const cwd = join(root, 'workspace')
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: user,
    XDG_CONFIG_HOME: join(user, '.config'),
    XDG_DATA_HOME: join(user, '.local/share'),
    XDG_STATE_HOME: join(user, '.local/state'),
    XDG_CACHE_HOME: join(user, '.cache'),
    CLAUDE_CONFIG_DIR: join(user, '.claude'),
    // Nothing leaves this machine: the fake model is on the loopback, every other address goes to a closed port.
    NO_PROXY: '127.0.0.1,localhost,::1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
  }
  for (const path of [
    cwd,
    ...['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR'].map(name => env[name]!),
  ])
    await mkdir(path, { recursive: true })
  return { root, cwd, env }
}

function handlers(updates: Array<Record<string, unknown>>, permission?: () => Promise<unknown>): WireHandlers {
  return {
    request: async method =>
      method === 'session/request_permission'
        ? permission
          ? permission()
          : { outcome: { outcome: 'selected', optionId: 'allow-once' } }
        : {},
    notification: (method, params) => {
      if (method === 'session/update') updates.push((params as { update: Record<string, unknown> }).update)
    },
    exit: () => {},
  }
}

const text = (updates: Array<Record<string, unknown>>) =>
  updates
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
    .map(update => (update.content as { text?: string } | undefined)?.text ?? '')
    .join('')

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

it.skipIf(!claude)(
  'steers a running Claude turn: `now` interrupts the model call, `later` waits behind an open permission',
  async () => {
    const { cwd, env, root } = await home('latch-claude-steer-')
    const slowMs = 20_000
    const asked: number[] = []
    const upstream = await startFakeModels({
      replyFor: request => {
        if (request.wire !== 'anthropic-messages' || !request.stream) return { text: 'ok' }
        asked.push(Date.now())
        const newest = last(request)
        if (newest.says(MARK)) return { text: `steered answer ${MARK}` }
        if (newest.says('tool_result')) return { text: 'tool done' }
        if (newest.says('with a tool'))
          return { tool: { name: /^Bash$/u, input: { command: 'touch latch-steer.txt', description: 'Make a file' } } }
        if (newest.says('take your time')) return { text: 'first answer', delayMs: slowMs } satisfies FakeReply
        return { text: 'ok' }
      },
    })
    cleanups.push(() => upstream.close())
    const updates: Array<Record<string, unknown>> = []
    let allow!: () => void
    const permissionAsked: Array<() => void> = []
    const wire: AgentWire = ClaudeWire.spawn(
      {
        command: claude!,
        args: [],
        cwd,
        env: agentEnvironment({
          resolvedCommand: claude!,
          definitionEnv: { ANTHROPIC_BASE_URL: upstream.origin, ANTHROPIC_API_KEY: 'fake-key' },
          sessionTmpDir: root,
          hostEnv: env,
        }),
        maxLineBytes: 16 * 1024 * 1024,
        redact: value => value,
      },
      handlers(
        updates,
        () =>
          new Promise(resolve => {
            allow = () => resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
            for (const waiter of permissionAsked.splice(0)) waiter()
          }),
      ),
    )
    cleanups.push(async () => void (await wire.stop('stop', 5_000).catch(() => {})))
    expect(await wire.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60_000)).toMatchObject({
      _meta: { steering: { supported: true, attachments: true } },
    })
    const { sessionId } = (await wire.request('session/new', { cwd, mcpServers: [] }, 60_000)) as { sessionId: string }

    // `now`: the slow call is cut short, the addition answered in the same turn.
    const began = Date.now()
    const first = wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'take your time' }] }, 120_000)
    first.catch(() => {})
    await until(() => upstream.requests.some(request => request.stream && last(request).says('take your time')))
    expect(await wire.request(STEER_METHOD, { sessionId, prompt: [{ type: 'text', text: `also ${MARK}` }] }, 30_000)).toEqual({
      outcome: 'injected',
    })
    const ended = (await first) as { stopReason: string }
    expect(ended.stopReason).toBe('end_turn')
    expect(Date.now() - began).toBeLessThan(slowMs)
    expect(text(updates)).toContain(`steered answer ${MARK}`)

    // `later`: while the permission waits, the addition queues; the answer still reaches the tool.
    updates.length = 0
    const asking = new Promise<void>(resolve => permissionAsked.push(resolve))
    const second = wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run it with a tool' }] }, 120_000)
    second.catch(() => {})
    await asking
    expect(await wire.request(STEER_METHOD, { sessionId, prompt: [{ type: 'text', text: `then ${MARK} again` }] }, 30_000)).toEqual({
      outcome: 'injected',
    })
    allow()
    expect(((await second) as { stopReason: string }).stopReason).toBe('end_turn')
    // The tool ran on the answer (`echo` alone would be allowed without asking, so it writes a file in the workspace).
    expect(existsSync(join(cwd, 'latch-steer.txt'))).toBe(true)
    expect(upstream.requests.some(request => request.stream && said(request, `then ${MARK} again`))).toBe(true)
    expect(asked.length).toBeGreaterThan(0)
  },
  180_000,
)

it.skipIf(!opencode)(
  'steers a running OpenCode run, and leaves nothing for the next turn when the run ended first',
  async () => {
    const { root, cwd, env } = await home('latch-opencode-steer-')
    const upstream = await startFakeModels({
      replyFor: request => {
        if (request.model === 'fake-model-large') return { text: 'Title' }
        const newest = last(request)
        if (newest.says(MARK)) return { text: `steered answer ${MARK}` }
        if (newest.role === 'tool') return { text: 'tool done' }
        if (newest.says('use the tool'))
          return { tool: { name: /^(shell|bash)$/u, input: { command: 'sleep 3; echo latch-steer', description: 'Wait' } } }
        if (newest.says('answer slowly')) return { text: 'slow answer', delayMs: 3_000 }
        return { text: 'plain answer' }
      },
    })
    cleanups.push(() => upstream.close())
    const config = {
      ...(JSON.parse(opencodeProfile.permission.defaultEnv.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>),
      model: 'latch/fake-model',
      small_model: 'latch/fake-model-large',
      providers: {
        latch: {
          name: 'Latch',
          env: ['LMG_TOKEN'],
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `${upstream.origin}/v1`, encoding: 'none' },
          models: {
            'fake-model': { name: 'fake-model', capabilities: { input: ['text'], output: ['text'], reasoning: { supported: false } } },
            'fake-model-large': {
              name: 'fake-model-large',
              capabilities: { input: ['text'], output: ['text'], reasoning: { supported: false } },
            },
          },
        },
      },
    }
    const tmp = join(root, 'tmp')
    mkdirSync(tmp, { mode: 0o700 })
    const updates: Array<Record<string, unknown>> = []
    const wire = openWire(
      'opencode',
      {
        command: opencode!,
        args: [],
        cwd,
        env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), LMG_TOKEN: 'fake-token', TMPDIR: tmp },
        maxLineBytes: 8 * 1024 * 1024,
        redact: value => value,
      },
      handlers(updates, async () => ({ outcome: { outcome: 'selected', optionId: 'once' } })),
    )
    cleanups.push(async () => void (await wire.stop('kill', 2_000)))
    expect(
      await wire.request(
        'initialize',
        { protocolVersion: 1, clientCapabilities: clientCapabilities(true), clientInfo: { name: 'latch', version: '0' } },
        60_000,
      ),
    ).toMatchObject({ _meta: { steering: { supported: true, attachments: true } } })
    const { sessionId } = (await wire.request('session/new', { cwd, mcpServers: [] }, 60_000)) as { sessionId: string }

    // Added while a tool runs: delivered at the next step, answered in the same turn.
    const first = wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'use the tool' }] }, 120_000)
    first.catch(() => {})
    await until(() => updates.some(update => update.sessionUpdate === 'tool_call'))
    expect(await wire.request(STEER_METHOD, { sessionId, prompt: [{ type: 'text', text: `also ${MARK}` }] }, 30_000)).toEqual({
      outcome: 'injected',
    })
    expect(((await first) as { stopReason: string }).stopReason).toBe('end_turn')
    expect(text(updates)).toContain(`steered answer ${MARK}`)

    // Added during the run's last model call: whether the run takes it or ends first, the next turn never runs it.
    updates.length = 0
    const late = `late ${MARK}-2`
    const second = wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'answer slowly' }] }, 120_000)
    second.catch(() => {})
    await until(() => upstream.requests.some(request => last(request).says('answer slowly')))
    const outcome = (await wire.request(STEER_METHOD, { sessionId, prompt: [{ type: 'text', text: late }] }, 30_000)) as { outcome: string }
    expect(['injected', 'promptRequired']).toContain(outcome.outcome)
    expect(((await second) as { stopReason: string }).stopReason).toBe('end_turn')
    const taken = upstream.requests.some(request => last(request).says(late))
    const notices = updates.filter(update => update.sessionUpdate === 'notice')
    // Taken in this turn, or said to be withdrawn: never both, never silently lost when Latch said `injected`.
    if (outcome.outcome === 'injected') expect(taken || notices.length === 1).toBe(true)
    if (taken) expect(notices).toEqual([])
    const before = upstream.requests.length
    expect(
      (
        (await wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'next turn' }] }, 120_000)) as {
          stopReason: string
        }
      ).stopReason,
    ).toBe('end_turn')
    const nextTurn = upstream.requests.slice(before).filter(request => request.model !== 'fake-model-large')
    if (!taken) expect(nextTurn.some(request => said(request, late))).toBe(false)
  },
  180_000,
)
