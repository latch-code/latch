import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRecord } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { agentProbePreview, probeAgent } from '../src/probe.ts'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(env: Record<string, string> = {}, overrides: Partial<AgentRecord> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-probe-')))
  roots.push(root)
  const dataDir = join(root, 'data')
  await mkdir(dataDir)
  const log = join(root, 'agent.jsonl')
  const agent: AgentRecord = {
    id: 'fake',
    name: 'Fake',
    command: process.execPath,
    args: [FAKE_ACP_AGENT],
    env: { FAKE_ACP_LOG: log, ...env },
    enabled: true,
    ...overrides,
  }
  const options = { dataDir, cwd: root }
  const preview = await agentProbePreview(agent, options)
  const logs = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { pid: number; event: string; method?: string })
  return { agent, options, preview, logs }
}
describe('initialize-only Agent probes', () => {
  it('reports capabilities without sending a session or prompt and waits for process exit', async () => {
    const t = await fixture({ FAKE_ACP_CAPS: 'images,resume,load,dirs', FAKE_ACP_AUTH: 'new' })
    const result = await probeAgent(t.agent, { ...t.options, expectedLaunchHash: t.preview.launchHash })
    expect(result).toMatchObject({
      status: 'ready',
      agent: { name: 'Fake ACP' },
      capabilities: { images: true, resume: true, load: true, additionalDirectories: true },
      authMethods: [{ name: 'Fake login' }],
    })
    const logs = await t.logs()
    expect(logs.filter(line => line.event === 'recv').map(line => line.method)).toEqual(['initialize'])
    expect(() => process.kill(logs[0]!.pid, 0)).toThrow()
  })
  it('asks Antigravity whether it is logged in with a session/list that opens no session', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-probe-login-')))
    roots.push(root)
    const login = join(root, 'login')
    const t = await fixture({ FAKE_ACP_CAPS: 'list,load', FAKE_ACP_LOGIN_FILE: login }, { presetId: 'antigravity' })
    expect(await probeAgent(t.agent, { ...t.options, expectedLaunchHash: t.preview.launchHash })).toMatchObject({
      status: 'ready',
      login: 'unauthenticated',
    })
    await writeFile(login, 'yes')
    expect((await probeAgent(t.agent, { ...t.options, expectedLaunchHash: t.preview.launchHash })).login).toBe('authenticated')
    const methods = (await t.logs()).filter(line => line.event === 'recv').map(line => line.method)
    expect(methods).toEqual(['initialize', 'session/list', 'initialize', 'session/list'])
  })
  it('labels only an explicit authentication-required error as requiring login', async () => {
    const t = await fixture({ FAKE_ACP_INIT_AUTH: '1' })
    expect(await probeAgent(t.agent, { ...t.options, expectedLaunchHash: t.preview.launchHash })).toMatchObject({
      status: 'authentication-required',
    })
  })
  it.each(['test-only-private-probe-value', 'q!7'])(
    'redacts configured secrets (%s) before returning the final 4 KiB of diagnostics',
    async secret => {
      const shaped = `sk-${'a'.repeat(32)}`
      const t = await fixture({
        FAKE_ACP_INIT_ERROR: '1',
        FAKE_SECRET: secret,
        FAKE_ACP_INIT_DIAGNOSTIC: shaped,
        FAKE_ACP_INIT_DIAGNOSTIC_SIZE: '10000',
      })
      const result = await probeAgent(t.agent, { ...t.options, expectedLaunchHash: t.preview.launchHash })
      expect(result.status).toBe('failed')
      expect(Buffer.byteLength(result.diagnostic!)).toBe(4096)
      expect(result.diagnostic).not.toContain(secret)
      expect(result.diagnostic).not.toContain(shaped)
      expect(result.diagnostic).toContain('[redacted]')
    },
  )
  it('refuses a changed fingerprint before spawning', async () => {
    const t = await fixture()
    t.agent.args.push('--changed')
    await expect(probeAgent(t.agent, { ...t.options, expectedLaunchHash: t.preview.launchHash })).rejects.toMatchObject({
      code: 'agent-definition-changed',
    })
    await expect(t.logs()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('stops the process after a handshake timeout and after Host cancellation', async () => {
    const t = await fixture({ FAKE_ACP_INIT_DELAY: '10000' })
    const result = await probeAgent(t.agent, { ...t.options, expectedLaunchHash: t.preview.launchHash, timeoutMs: 200 })
    expect(result.status).toBe('failed')
    const pid = (await t.logs())[0]!.pid
    expect(() => process.kill(pid, 0)).toThrow()
    const controller = new AbortController()
    const pending = probeAgent(t.agent, { ...t.options, expectedLaunchHash: t.preview.launchHash, signal: controller.signal })
    await expect.poll(async () => (await t.logs()).filter(line => line.event === 'start').length).toBe(2)
    controller.abort()
    expect((await pending).status).toBe('failed')
  })
})
