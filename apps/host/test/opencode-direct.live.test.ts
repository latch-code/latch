import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPreset, CancelReceipt, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

/** The installed OpenCode on its own server (`opencode serve`), through Latch's gateway to a local fake model. */
const binary = process.env.LATCH_OPENCODE_GATEWAY_BINARY
afterEach(() => vi.unstubAllEnvs())

function listing(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('/bin/ps', args, { env: {}, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  )
}

/** The `opencode serve` processes below this test's own process. */
async function servers(): Promise<number[]> {
  const rows = (await listing(['-A', '-ww', '-o', 'pid=,ppid=,args='])).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]! }] : []
  })
  const below = new Set([process.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows)
      if (below.has(row.ppid) && !below.has(row.pid)) {
        below.add(row.pid)
        grew = true
      }
  }
  return rows
    .filter(row => below.has(row.pid) && row.pid !== process.pid && /\bserve --hostname 127\.0\.0\.1 --port 0\b/u.test(row.args))
    .map(row => row.pid)
}

/** Every process, anywhere, running exactly this command: a command orphaned by a stop is no longer below the test. */
async function commands(command: string): Promise<number[]> {
  return (await listing(['-A', '-ww', '-o', 'pid=,args='])).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    return match && match[2]!.trim() === command ? [Number(match[1])] : []
  })
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function toolOutputs(input: unknown): string[] {
  const body = input as { messages?: Array<{ role?: string; content?: unknown }> }
  return (body.messages ?? []).filter(message => message.role === 'tool').map(message => JSON.stringify(message.content))
}

it.skipIf(!binary)(
  'runs a real OpenCode on its own server: a reply, a call denied and one allowed, a stop, and a resume after the process stopped',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-opencode-direct-live-')))
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
    const denied = join(root, 'denied.txt')
    const allowed = join(root, 'allowed.txt')
    const secrets = `found=; for name in OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD LMG_TOKEN; do eval value=\\$$name; [ -n "$value" ] && found="$found$name "; done; if [ -z "$found" ]; then printf secrets-hidden > ${allowed}; else printf "secrets-present: $found" > ${allowed}; fi; cat ${allowed}`
    let phase: 'reply' | 'deny' | 'allow' | 'slow' | 'sleep' | 'restored' = 'reply'
    let sleepFor = ''
    let slowSent = false
    const upstream = await startFakeModels({
      replyFor: request => {
        const body = request.body as { tools?: unknown[] }
        // Title and summary calls offer no tools; only the session's own turns do.
        if (!body.tools?.length) return { text: 'Title' }
        // This turn's call has run once the conversation ends with its result.
        const answered = (request.body as { messages?: Array<{ role?: string }> }).messages?.at(-1)?.role === 'tool'
        if (phase === 'reply') return { reasoning: 'thinking about it', text: 'direct hello' }
        if (phase === 'deny')
          return answered
            ? { text: 'after deny' }
            : { tool: { name: /^(shell|bash)$/u, input: { command: `touch ${denied}`, description: 'Create a file' } } }
        if (phase === 'allow')
          return answered
            ? { text: 'allowed done' }
            : { tool: { name: /^(shell|bash)$/u, input: { command: secrets, description: 'Check secrets' } } }
        if (phase === 'sleep')
          return answered
            ? { text: 'slept' }
            : { tool: { name: /^(shell|bash)$/u, input: { command: `sleep ${sleepFor}`, description: 'Wait' } } }
        if (phase === 'slow') {
          slowSent = true
          return { text: 'late answer must not arrive', delayMs: 8_000 }
        }
        return { text: 'restored answer' }
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
    const seenServers = new Set<number>()
    try {
      let owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: 'Temporary service',
          kind: 'openai-compatible',
          baseURL: `${upstream.origin}/v1`,
          apiKey: 'sk-test-opencode-direct-0123456789',
          models: ['fake-model'],
          defaultModel: 'fake-model',
          modelCapabilities: { 'fake-model': { vision: false, thinking: ['low', 'high'] } },
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      const saved = await owner.confirmed('agents', {
        method: 'POST',
        body: { id: 'opencode', name: 'OpenCode', presetId: 'opencode', command: 'opencode', args: [], env: {} },
      })
      expect(saved.status).toBe(201)
      // 2.2.6 or later stays on its own server; an older one would be saved on `opencode acp`.
      expect(((await saved.json()) as { agent: { args: string[] } }).agent.args).toEqual([])

      const current = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
      const settle = async (id: string, decision?: 'allow' | 'reject') => {
        await vi.waitFor(
          async () => {
            const detail = await current(id)
            if (decision)
              for (const approval of detail.approvals)
                await owner.json(`approvals/${approval.id}`, { body: { decision, requestId: randomUUID() } })
            for (const pid of await servers()) seenServers.add(pid)
            expect(['running', 'waiting-approval']).not.toContain(detail.summary.status)
          },
          { timeout: 90_000, interval: 100 },
        )
        return current(id)
      }
      const said = (detail: TaskDetail) => detail.messages.map(message => message.text).join('\n')

      // 1. A reply, with its thinking.
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'opencode',
          prompt: 'Say hello.',
          requestId: randomUUID(),
          model: { providerId: provider.id, model: 'fake-model' },
        },
      })
      const sessionId = started.sessionId
      let detail = await settle(sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(said(detail)).toContain('direct hello')
      expect(detail.config?.find(option => option.category === 'mode')?.currentValue).toBe('build')

      // The server's password is in its environment only: no process shows it among its arguments.
      const [pid] = await servers()
      expect(pid).toBeDefined()
      const environment = await listing(['-E', '-ww', '-o', 'command=', '-p', String(pid)])
      const password = /\bOPENCODE_PASSWORD=(\S+)/u.exec(environment)?.[1]
      expect(password).toMatch(/^[\w-]{40,}$/u)
      expect(await listing(['-A', '-ww', '-o', 'args='])).not.toContain(password!)

      // 2. A call asked and refused: it does not run.
      phase = 'deny'
      await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Create the file.', requestId: randomUUID() } })
      detail = await settle(sessionId, 'reject')
      expect(existsSync(denied)).toBe(false)
      expect(detail.messages.some(message => message.role === 'tool' || message.tool !== undefined)).toBe(true)

      // 3. A call allowed: it runs, and its shell sees neither the server's password nor the gateway's token.
      phase = 'allow'
      await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Check the secrets.', requestId: randomUUID() } })
      detail = await settle(sessionId, 'allow')
      console.log(
        JSON.stringify(
          detail.messages.slice(-8).map(m => ({ role: m.role, text: m.text.slice(0, 300), tool: (m as { tool?: unknown }).tool })),
          null,
          1,
        ),
        JSON.stringify(upstream.requests.slice(-3).map(r => toolOutputs(r.body))),
      )
      expect(detail.summary.status).toBe('idle')
      expect(await readFile(allowed, 'utf8')).toBe('secrets-hidden')
      expect(said(detail)).toContain('allowed done')
      expect(upstream.requests.flatMap(request => toolOutputs(request.body)).some(output => output.includes('secrets-hidden'))).toBe(true)

      // 4. A stop, confirmed only once OpenCode ended the run.
      phase = 'slow'
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Wait for a reply we will stop.', requestId: randomUUID() },
      })
      await vi.waitFor(() => expect(slowSent).toBe(true), { timeout: 30_000 })
      const runId = (await current(sessionId)).summary.runId
      const stopped = await owner.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
        method: 'POST',
        body: { requestId: randomUUID(), runId },
      })
      expect(stopped.receipt).toMatchObject({ outcome: 'stopped', status: 'cancelled' })
      expect(said(await current(sessionId))).not.toContain('late answer must not arrive')

      // 5. A stop while a command runs: the command is gone once the stop is confirmed.
      const sleeping = async (seconds: string) => {
        sleepFor = seconds
        phase = 'sleep'
        await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Wait a while.', requestId: randomUUID() } })
        await vi.waitFor(
          async () => {
            for (const approval of (await current(sessionId)).approvals)
              await owner.json(`approvals/${approval.id}`, { body: { decision: 'allow', requestId: randomUUID() } })
            for (const found of await servers()) seenServers.add(found)
            expect(await commands(`sleep ${seconds}`)).not.toEqual([])
          },
          { timeout: 60_000, interval: 100 },
        )
      }
      await sleeping('131.7')
      const sleepRun = (await current(sessionId)).summary.runId
      const sleepStopped = await owner.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
        method: 'POST',
        body: { requestId: randomUUID(), runId: sleepRun },
      })
      expect(sleepStopped.receipt).toMatchObject({ outcome: 'stopped', status: 'cancelled' })
      expect(await commands('sleep 131.7')).toEqual([])

      // 6. The Host stops while a command runs, and neither the server nor the command outlives it.
      await sleeping('133.7')
      expect(seenServers.size).toBeGreaterThan(0)
      await host.close()
      await vi.waitFor(() => expect([...seenServers].filter(alive)).toEqual([]), { timeout: 10_000 })
      await vi.waitFor(async () => expect(await commands('sleep 133.7')).toEqual([]), { timeout: 10_000 })

      // 7. A new Host resumes the session on a new server process.
      host = await startTestHost(hostOptions)
      owner = await host.enroll({ listener: 'unix' })
      phase = 'restored'
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'Continue after recovery.', requestId: randomUUID() },
      })
      detail = await settle(sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(said(detail)).toContain('restored answer')
      const resumedRequest = upstream.requests.findLast(request => (request.body as { tools?: unknown[] }).tools?.length)
      expect(JSON.stringify(resumedRequest?.body)).toContain('direct hello')
      for (const found of await servers()) seenServers.add(found)
    } finally {
      await host.close()
      await upstream.close()
      await vi.waitFor(() => expect([...seenServers].filter(alive)).toEqual([]), { timeout: 10_000 })
      try {
        await assertNoGatewayCredentials(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  240_000,
)
