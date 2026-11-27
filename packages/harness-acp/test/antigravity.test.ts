import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AttachmentRef, DriverTaskDetail } from '@latch/protocol'
import type { Bridge, HarnessDriver, HarnessPlugin } from '@latch/sdk'
import { createAcpAgentPlugin, forgetCommandLookups, setCommandSearch } from '../src/index.ts'
import { replayTranscript } from './helpers/replay.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  forgetCommandLookups()
})

// Frames recorded from Antigravity CLI 1.5.8 on 2026-11-15 and reduced; the transcript's header says how.
const RESUME = resolve(import.meta.dirname, 'fixtures/antigravity-resume.ndjson')

it('sets the model and thinking a session ran on again when Antigravity opens it with its defaults', async () => {
  const { detail, status, pending, marks } = await replayTranscript(RESUME, cleanups)
  // Every frame was played in order: after session/resume answered with the defaults, the driver set both again
  // before it sent the prompt.
  expect(status?.failure).toBeUndefined()
  expect(status).toMatchObject({ cursor: status?.total })
  expect(pending).toEqual([])
  expect(marks).toEqual([])
  expect(detail.summary.status).toBe('idle')
  expect(detail.config?.find(option => option.category === 'model')?.currentValue).toBe('gemini-4-hydrogen')
  expect(detail.config?.find(option => option.category === 'thought_level')?.currentValue).toBe('low')
  expect(detail.summary.model).toBe('Gemini 4 Hydrogen')
  expect(detail.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Hello.', 'Hello again.'])
  expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Say hello', 'And again'])
  // agy reports each turn's own count with cached input outside `inputTokens`: each turn puts cached reads back into input, and the session sums both turns.
  const perTurn = { inputTokens: 19_034, outputTokens: 91, cacheReadTokens: 7375, cacheWriteTokens: 0, reasoningTokens: 15 }
  expect(detail.messages.filter(message => message.role === 'user').map(message => message.turn?.usage)).toEqual([perTurn, perTurn])
  expect(detail.summary.usage).toEqual({
    inputTokens: 38_068,
    outputTokens: 182,
    cacheReadTokens: 14_750,
    cacheWriteTokens: 0,
    reasoningTokens: 30,
  })
})

const FAKE_AGY = `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')

if (process.argv.includes('--version')) {
  process.stdout.write('1.5.17\\n')
  process.exit(0)
}

const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
let mode = 'default'
let active = null
let openPermId = null
let nextServerId = 100
const pendingServer = new Map()
const logPath = process.env.FAKE_AGY_LOG

const record = entry => {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n')
}

const configOptions = () => [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: mode,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept edits' },
      { value: 'auto', name: 'Auto' },
      { value: 'plan', name: 'Plan' },
    ],
  },
]

const finishActive = (stopReason, usage) => {
  if (!active) return
  const current = active
  active = null
  send({ jsonrpc: '2.0', id: current.id, result: { stopReason, usage } })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === undefined && msg.id !== undefined) {
    const waiter = pendingServer.get(msg.id)
    if (waiter) {
      pendingServer.delete(msg.id)
      waiter(msg)
    }
    return
  }
  record({ method: msg.method, id: msg.id ?? null, params: msg.params })
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'antigravity', version: '1.5.17' },
        agentCapabilities: {
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { resume: {}, list: {} },
        },
      },
    })
    return
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'agy-ses-1', configOptions: configOptions() } })
    return
  }
  if (msg.method === 'session/set_config_option') {
    mode = msg.params.value
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } },
    })
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: configOptions() } })
    return
  }
  if (msg.method === 'session/cancel') {
    finishActive('cancelled', { inputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1, thoughtTokens: 0 })
    return
  }
  if (msg.method === 'session/prompt') {
    const blocks = msg.params.prompt || []
    const text = blocks.map(b => b.text || (b.type === 'image' ? '[image]' : '')).join(' ')
    if (active) {
      if (openPermId !== null || text.includes('refuse-steer')) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32603,
            message: "Can't add this prompt to session agy-ses-1: the running prompt is waiting for a permission or question answer",
          },
        })
        return
      }
      const prev = active
      active = { id: msg.id, step: prev.step + 1 }
      const hand = () => {
        // The superseded answer and the first words of the reply in one write, so they reach Latch in the same read.
        process.stdout.write(
          [
            {
              jsonrpc: '2.0',
              id: prev.id,
              result: {
                stopReason: text.includes('prior-max') ? 'max_tokens' : 'end_turn',
                usage: { inputTokens: 1000, cachedReadTokens: 400, cachedWriteTokens: 0, outputTokens: 30, thoughtTokens: 5 },
              },
            },
            {
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: msg.params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Steered: ' + text } },
              },
            },
          ]
            .map(message => JSON.stringify(message) + '\\n')
            .join(''),
        )
        if (text.includes('finish-now')) {
          setTimeout(() => {
            finishActive('end_turn', { inputTokens: 1500, cachedReadTokens: 600, cachedWriteTokens: 0, outputTokens: 50, thoughtTokens: 10 })
          }, 20)
        }
      }
      if (text.includes('slow-handoff')) setTimeout(hand, Number(process.env.FAKE_AGY_HANDOFF_MS))
      else hand()
      return
    }
    active = { id: msg.id, step: 1 }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working.' } },
      },
    })
    if (text.includes('ask-perm')) {
      const reqId = ++nextServerId
      openPermId = reqId
      pendingServer.set(reqId, () => {
        openPermId = null
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Approved.' } },
          },
        })
      })
      send({
        jsonrpc: '2.0',
        id: reqId,
        method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: 'call-1', title: 'Run echo', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      })
    }
  }
})
`

async function activateDriver(plugin: HarnessPlugin): Promise<HarnessDriver> {
  let driver!: HarnessDriver
  const disposers: Array<() => void | Promise<void>> = []
  await plugin.activate({
    registerHarness: registered => {
      driver = registered
    },
    registerProvider: () => {},
    registerTool: () => {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: () => {},
    onDispose: dispose => {
      disposers.push(dispose)
    },
  })
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) await dispose()
  })
  return driver
}

async function openFakeAntigravity(options: { requestTimeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ bridge: Bridge }> {
  const root = await mkdtemp(join(tmpdir(), 'latch-agy-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const binDir = join(root, 'bin')
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const tmpRoot = join(root, 'tmp')
  await mkdir(binDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(tmpRoot, { mode: 0o700 })
  const bin = join(binDir, 'agy')
  await writeFile(bin, FAKE_AGY)
  await chmod(bin, 0o755)
  setCommandSearch(() => [binDir])
  forgetCommandLookups()
  const driver = await activateDriver(
    createAcpAgentPlugin(
      {
        id: 'antigravity',
        presetId: 'antigravity',
        name: 'Antigravity',
        command: 'agy',
        args: ['acp'],
        env: options.env ?? {},
        enabled: true,
      },
      { cancelGraceMs: 300, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: options.requestTimeoutMs ?? 5_000 },
    ),
  )
  const bridge = driver.create({
    dataDir,
    workspaceRoot: workspace,
    tmpRoot,
    providerId: 'unused',
    registry: {
      acquire() {
        throw new Error('ACP sessions do not lease Host providers')
      },
    },
    readAttachment: async () => ({ type: 'image', data: 'cG5n', mimeType: 'image/png' }),
  })
  cleanups.push(() => bridge.close())
  await bridge.start()
  const create = bridge.createTask.bind(bridge)
  bridge.createTask = async input =>
    'expectedLaunchHash' in input
      ? create(input)
      : create({ ...input, expectedLaunchHash: (await bridge.launchPreview!({ cwd: input.cwd ?? workspace })).launchHash })
  return { bridge }
}

async function waitForDetail(
  bridge: Bridge,
  sessionId: string,
  predicate: (detail: DriverTaskDetail) => boolean,
): Promise<DriverTaskDetail> {
  let latest!: DriverTaskDetail
  await vi.waitFor(
    async () => {
      latest = await bridge.detail(sessionId)
      expect(predicate(latest)).toBe(true)
    },
    { timeout: 5_000 },
  )
  return latest
}

it('steers a running Antigravity turn via concurrent session/prompt (from queue and with attachments) and sums superseded usage', async () => {
  const { bridge } = await openFakeAntigravity()
  const { sessionId } = await bridge.createTask({ prompt: 'start work', requestId: 'req-1' })
  const running = await waitForDetail(bridge, sessionId, detail => detail.steer === true && detail.liveText.includes('Working.'))
  expect(running.steerAttachments).toBe(true)

  const queuedAt = '2026-11-27T10:00:00.000Z'
  expect(
    await bridge.steerQueued!(sessionId, 'from queue', 'req-2', {
      runId: running.summary.runId!,
      queuedAt,
      authorize: async () => {},
    }),
  ).toBe('injected')

  await waitForDetail(bridge, sessionId, detail => detail.liveText.includes('Steered: from queue'))
  // The superseded first session/prompt answered end_turn, yet the Latch turn stays active on the second session/prompt.
  expect((await bridge.detail(sessionId)).summary.status).toBe('running')

  const image: AttachmentRef = {
    id: 'abcdefghijklmnopqrstuv',
    kind: 'image',
    name: 'shot.png',
    mime: 'image/png',
    size: 3,
    sha256: 'a'.repeat(64),
  }
  expect(await bridge.steerWithAttachments!(sessionId, 'finish-now', 'req-3', [image])).toBe('injected')

  const done = await waitForDetail(bridge, sessionId, detail => detail.summary.status === 'idle')
  expect(done.messages.filter(m => m.role === 'user').map(m => ({ text: m.text, steered: m.steered, queuedAt: m.queuedAt }))).toEqual([
    { text: 'start work', steered: undefined, queuedAt: undefined },
    { text: 'from queue', steered: true, queuedAt },
    { text: 'finish-now', steered: true, queuedAt: undefined },
  ])
  expect(done.messages.filter(m => m.role === 'assistant').map(m => m.text)).toEqual([
    'Working.',
    'Steered: from queue',
    'Steered: finish-now [image]',
  ])
  // Three chained prompts: two superseded (1000+400 input, 30 output, 5 thought each) + final (1500+600 input, 50 output, 10 thought).
  const expectedUsage = {
    inputTokens: 4900,
    outputTokens: 110,
    cacheReadTokens: 1400,
    cacheWriteTokens: 0,
    reasoningTokens: 20,
  }
  expect(done.messages.find(m => m.role === 'user' && !m.steered)?.turn?.usage).toEqual(expectedUsage)
  expect(done.summary.usage).toEqual(expectedUsage)
})

it('hides Antigravity steering while a permission waits and keeps the turn running if agy refuses a concurrent prompt', async () => {
  const { bridge } = await openFakeAntigravity()
  const { sessionId } = await bridge.createTask({ prompt: 'ask-perm', requestId: 'perm-1' })
  const waiting = await waitForDetail(bridge, sessionId, detail => detail.approvals.length === 1)
  expect(waiting.steer).toBeUndefined()
  expect(
    await bridge.steerQueued!(sessionId, 'queued while waiting', 'perm-q1', {
      runId: waiting.summary.runId!,
      queuedAt: '2026-11-27T10:00:00.000Z',
      authorize: async () => {},
    }),
  ).toBe('prompt-required')

  expect(await bridge.decide(waiting.approvals[0]!.id, 'allow')).toBe(true)
  await waitForDetail(bridge, sessionId, detail => detail.steer === true && detail.liveText.includes('Approved.'))

  await expect(bridge.steer!(sessionId, 'refuse-steer', 'perm-refused')).rejects.toMatchObject({
    status: 409,
    code: 'steer-failed',
  })
  expect((await bridge.detail(sessionId)).summary.status).toBe('running')

  expect(await bridge.steer!(sessionId, 'finish-now', 'perm-finish')).toBe('injected')
  const done = await waitForDetail(bridge, sessionId, detail => detail.summary.status === 'idle')
  expect(done.messages.filter(m => m.steered).map(m => m.text)).toEqual(['finish-now'])
})

it('marks the reply a steer superseded failed when agy ended it otherwise than end_turn, and goes on with the turn', async () => {
  const { bridge } = await openFakeAntigravity()
  const { sessionId } = await bridge.createTask({ prompt: 'start work', requestId: 'max-1' })
  await waitForDetail(bridge, sessionId, detail => detail.steer === true && detail.liveText.includes('Working.'))
  expect(await bridge.steer!(sessionId, 'prior-max finish-now', 'max-2')).toBe('injected')
  const done = await waitForDetail(bridge, sessionId, detail => detail.summary.status === 'idle')
  expect(done.messages.map(m => [m.role, m.text, m.state])).toEqual([
    ['user', 'start work', undefined],
    ['assistant', 'Working.', 'failed'],
    ['user', 'prior-max finish-now', undefined],
    ['assistant', 'Steered: prior-max finish-now', 'completed'],
    ['system', 'Antigravity 接上追加之前的那段回复达到模型输出长度上限，可能不完整。', undefined],
  ])
})

it('records an addition agy took after the steer timed out, so the same request then reads injected', async () => {
  const { bridge } = await openFakeAntigravity({ requestTimeoutMs: 1_000, env: { FAKE_AGY_HANDOFF_MS: '1500' } })
  const { sessionId } = await bridge.createTask({ prompt: 'start work', requestId: 'late-1' })
  await waitForDetail(bridge, sessionId, detail => detail.steer === true && detail.liveText.includes('Working.'))
  await expect(bridge.steer!(sessionId, 'slow-handoff finish-now', 'late-2')).rejects.toMatchObject({ code: 'steer-unknown' })
  // The handoff agy answered late is the Host's evidence: the addition is recorded where the turn split.
  const done = await waitForDetail(bridge, sessionId, detail => detail.summary.status === 'idle')
  expect(done.messages.map(m => [m.role, m.text, m.steered])).toEqual([
    ['user', 'start work', undefined],
    ['assistant', 'Working.', undefined],
    ['user', 'slow-handoff finish-now', true],
    ['assistant', 'Steered: slow-handoff finish-now', undefined],
  ])
  expect(await bridge.steer!(sessionId, 'slow-handoff finish-now', 'late-2')).toBe('injected')
})
