import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProbeResult, AgentSettings } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { HostConfig } from '../src/config.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
})
async function fixture(env: Record<string, string> = {}) {
  const t = await startTestHost()
  hosts.push(t)
  const desktop = await t.enroll({ listener: 'unix' })
  const log = join(t.root, 'probe.jsonl')
  await desktop.json('agents', {
    method: 'POST',
    body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: log, ...env } },
  })
  return { t, desktop, log }
}
async function logs(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { event: string; method?: string; pid: number })
}
describe('Agent probe HTTP boundary', () => {
  it('runs at once and replays the same request without another process', async () => {
    const { t, desktop, log } = await fixture({ FAKE_ACP_CAPS: 'images,resume,dirs', FAKE_ACP_AUTH: 'new' })
    const input = { requestId: randomUUID() }
    const copies = await Promise.all([0, 1].map(() => desktop.json<AgentProbeResult>('agents/fake/probe', { method: 'POST', body: input })))
    const response = copies[0]!
    expect(copies[1]).toEqual(response)
    expect(response).toMatchObject({
      status: 'ready',
      capabilities: { images: true, resume: true, additionalDirectories: true },
      authMethods: [{ name: 'Fake login' }],
    })
    expect(await desktop.json('agents/fake/probe', { method: 'POST', body: input })).toEqual(response)
    expect((await logs(log)).filter(line => line.event === 'start')).toHaveLength(1)
    expect((await logs(log)).filter(line => line.event === 'recv').map(line => line.method)).toEqual(['initialize'])
    const { agents } = await desktop.json<{ agents: AgentSettings[] }>('agents')
    expect(agents[0]!.lastProbe).toEqual(response)
    expect((await HostConfig.open(t.dataDir)).settings().agents[0]!.lastProbe).toEqual(response)
    expect(agents[0]!.started).toBe(false)
    await desktop.json('agents/fake', { method: 'PUT', body: { args: [FAKE_ACP_AGENT, '--changed'] } })
    expect((await desktop.json<{ agents: AgentSettings[] }>('agents')).agents[0]!.lastProbe).toBeUndefined()
    expect(t.presence.requests).toHaveLength(0)
  })
  it('runs from any device with admin and run, and takes no prompt into the endpoint', async () => {
    const { t, desktop } = await fixture()
    const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
    const restricted = await t.enroll({ scopes: ['view', 'admin'] })
    const send = (device: TestDevice, body = { requestId: randomUUID() }) => device.request('agents/fake/probe', { method: 'POST', body })
    expect(await (await send(browser)).json()).toMatchObject({ status: 'ready' })
    expect(await (await send(restricted)).json()).toMatchObject({ error: 'scope-required', required: 'run' })
    expect(
      (await desktop.request('agents/fake/probe', { method: 'POST', body: { requestId: randomUUID(), prompt: 'never send this' } })).status,
    ).toBe(400)
  })
  it('redacts diagnostics before returning or persisting a failed handshake', async () => {
    const secret = 'test-only-agent-probe-value'
    const { t, desktop } = await fixture({ FAKE_SECRET: secret, FAKE_ACP_INIT_ERROR: '1' })
    const input = { requestId: randomUUID() }
    const result = await desktop.json<AgentProbeResult>('agents/fake/probe', { method: 'POST', body: input })
    expect(result.status).toBe('failed')
    expect(result.diagnostic).toContain('[redacted]')
    expect(JSON.stringify(result)).not.toContain(secret)
    const settings = JSON.parse(await readFile(join(t.dataDir, 'settings.json'), 'utf8')) as {
      agents: Array<{ lastProbe: AgentProbeResult }>
    }
    expect(JSON.stringify(settings.agents[0]!.lastProbe)).not.toContain(secret)
  })
  it('does not spawn when the execution-intent audit cannot be written', async () => {
    const { t, desktop, log } = await fixture()
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    vi.spyOn(t.host.security.audit, 'append').mockImplementation(event =>
      event.action === 'agent.probe.requested' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
    )
    const input = { requestId: randomUUID() }
    expect((await desktop.request('agents/fake/probe', { method: 'POST', body: input })).status).toBe(503)
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('stops an initialize-only process before Host shutdown completes', async () => {
    const { t, desktop, log } = await fixture({ FAKE_ACP_INIT_DELAY: '10000' })
    const input = { requestId: randomUUID() }
    const pending = desktop.request('agents/fake/probe', { method: 'POST', body: input }).then(
      response => response.status,
      () => 0,
    )
    await expect.poll(async () => (await logs(log)).filter(line => line.event === 'recv').map(line => line.method)).toContain('initialize')
    const pid = (await logs(log))[0]!.pid
    await t.close()
    await pending
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
