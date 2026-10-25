import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProbeResult, AgentSettings, ConfirmationTicket } from '@latch/protocol'
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
async function ticket(desktop: TestDevice, input: { requestId: string }, headers = {}) {
  const response = await desktop.request('agents/fake/probe', { method: 'POST', body: input, headers })
  expect(response.status).toBe(403)
  const result = (await response.json()) as { confirmation: ConfirmationTicket }
  await expect
    .poll(
      async () => (await desktop.json<{ confirmation: ConfirmationTicket }>(`confirmations/${result.confirmation.id}`)).confirmation.status,
    )
    .toBe('approved')
  return result.confirmation
}
async function logs(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { event: string; method?: string; pid: number })
}
describe('Agent probe HTTP boundary', () => {
  it('requires OS confirmation before executing and replays the same request without another process or confirmation', async () => {
    const { t, desktop, log } = await fixture({ FAKE_ACP_CAPS: 'images,resume,dirs', FAKE_ACP_AUTH: 'new' })
    const input = { requestId: randomUUID() }
    const confirmation = await ticket(desktop, input, { 'x-latch-shell-confirmation': '1' })
    expect(confirmation).toMatchObject({ action: 'agent.probe', form: 'agent.probe', reason: expect.stringContaining('不发送提示词') })
    expect(confirmation.confirmationMethod).toBeUndefined()
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' })
    const copies = await Promise.all(
      [0, 1].map(() => desktop.json<AgentProbeResult>('agents/fake/probe', { method: 'POST', body: input, confirmation: confirmation.id })),
    )
    const response = copies[0]!
    expect(copies[1]).toEqual(response)
    expect(response).toMatchObject({
      status: 'ready',
      capabilities: { images: true, resume: true, additionalDirectories: true },
      authMethods: [{ name: 'Fake login' }],
    })
    expect(await desktop.json('agents/fake/probe', { method: 'POST', body: input, confirmation: confirmation.id })).toEqual(response)
    expect((await logs(log)).filter(line => line.event === 'start')).toHaveLength(1)
    expect((await logs(log)).filter(line => line.event === 'recv').map(line => line.method)).toEqual(['initialize'])
    const { agents } = await desktop.json<{ agents: AgentSettings[] }>('agents')
    expect(agents[0]!.lastProbe).toEqual(response)
    expect((await HostConfig.open(t.dataDir)).settings().agents[0]!.lastProbe).toEqual(response)
    expect(agents[0]!.started).toBe(false)
    await desktop.json('agents/fake', { method: 'PUT', body: { args: [FAKE_ACP_AGENT, '--changed'] } })
    expect((await desktop.json<{ agents: AgentSettings[] }>('agents')).agents[0]!.lastProbe).toBeUndefined()
    expect(t.presence.requests.filter(request => request.preview.action === 'agent.probe')).toHaveLength(1)
  })
  it('refuses browsers, missing run scope, disallowed full access and prompt injection into the endpoint', async () => {
    const { t, desktop } = await fixture()
    const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
    const restricted = await t.enroll({ listener: 'unix', scopes: ['admin'] })
    const send = (device: TestDevice, body = { requestId: randomUUID() }) => device.request('agents/fake/probe', { method: 'POST', body })
    expect(await (await send(browser)).json()).toMatchObject({ error: 'local-only' })
    expect(await (await send(restricted)).json()).toMatchObject({ error: 'scope-required', required: 'run' })
    expect(
      (await desktop.request('agents/fake/probe', { method: 'POST', body: { requestId: randomUUID(), prompt: 'never send this' } })).status,
    ).toBe(400)
    await desktop.json('policy', { method: 'PATCH', body: { local: { allowL3: false } } })
    expect(await (await send(desktop)).json()).toMatchObject({ error: 'ceiling-exceeded' })
  })
  it('redacts diagnostics before returning or persisting a failed handshake', async () => {
    const secret = 'test-only-agent-probe-value'
    const { t, desktop } = await fixture({ FAKE_SECRET: secret, FAKE_ACP_INIT_ERROR: '1' })
    const input = { requestId: randomUUID() }
    const confirmation = await ticket(desktop, input)
    const result = await desktop.json<AgentProbeResult>('agents/fake/probe', { method: 'POST', body: input, confirmation: confirmation.id })
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
    const confirmation = await ticket(desktop, input)
    expect((await desktop.request('agents/fake/probe', { method: 'POST', body: input, confirmation: confirmation.id })).status).toBe(503)
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('stops an initialize-only process before Host shutdown completes', async () => {
    const { t, desktop, log } = await fixture({ FAKE_ACP_INIT_DELAY: '10000' })
    const input = { requestId: randomUUID() }
    const confirmation = await ticket(desktop, input)
    const pending = desktop.request('agents/fake/probe', { method: 'POST', body: input, confirmation: confirmation.id }).then(
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
