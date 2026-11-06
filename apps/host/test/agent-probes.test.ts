import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AgentProbeResult, AgentSettings, HarnessInfo } from '@latch/protocol'
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
  it('keeps the version of the program an adapter drives beside the adapter, and marks a pair it was not built for', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'latch-probe-bin-'))
    onTestFinished(() => rm(bin, { recursive: true, force: true }))
    const scripts = { 'codex-acp': 'export FAKE_ACP_VERSION=2.5.0', codex: 'export FAKE_ACP_CLI_VERSION=0.167.0' }
    for (const [name, line] of Object.entries(scripts)) {
      await writeFile(join(bin, name), ['#!/bin/sh', line, `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`].join('\n'))
      await chmod(join(bin, name), 0o755)
    }
    const t = await startTestHost({
      demo: false,
      // Only this directory: no program installed on the computer running the test is ever found or run.
      commandDirectories: () => [bin],
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
    })
    hosts.push(t)
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.json('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
    })
    const result = await desktop.json<AgentProbeResult>('agents/codex/probe', { method: 'POST', body: { requestId: randomUUID() } })
    expect(result).toMatchObject({
      status: 'ready',
      agent: { version: '2.5.0' },
      program: { name: 'Codex', version: '0.167.0', unchecked: true },
    })
    expect((await HostConfig.open(t.dataDir)).settings().agents[0]!.lastProbe).toEqual(result)
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
describe("a Harness's lists read before a session, and typed model IDs", () => {
  const harnessInfo = async (device: TestDevice) =>
    (await device.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')).catalog.harnesses.find(item => item.id === 'fake')!
  it('reads once on selection from a device that may start sessions, and audits it; a reading device starts nothing', async () => {
    const { t, desktop, log } = await fixture({ FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'delete' })
    const viewer = await t.enroll({ scopes: ['view'] })
    expect(await (await viewer.request('agents/fake/catalogue', { method: 'POST', body: { auto: true } })).json()).toMatchObject({
      error: 'scope-required',
      required: 'run',
    })
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await harnessInfo(viewer)).catalogueRead).toEqual({ when: 'select' })

    const phone = await t.enroll({ scopes: ['view', 'run'] })
    const confirmations = t.presence.requests.length
    expect(await phone.json('agents/fake/catalogue', { method: 'POST', body: { auto: true } })).toMatchObject({
      ran: true,
      catalogueRead: { when: 'select', last: { ok: true } },
    })
    const info = await harnessInfo(viewer)
    expect(info.catalogue).toMatchObject({ source: 'check' })
    expect(await desktop.json('agents/fake/catalogue', { method: 'POST', body: { auto: true } })).toMatchObject({ ran: false })
    const lines = await logs(log)
    expect(lines.filter(line => line.event === 'recv').map(line => line.method)).toEqual(['initialize', 'session/new', 'session/delete'])
    const actions = (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { action: string }).action)
    expect(actions.filter(action => action.startsWith('agent.catalogue'))).toEqual(['agent.catalogue.requested', 'agent.catalogue.read'])
    expect(t.presence.requests).toHaveLength(confirmations)
    expect(
      (await desktop.request('agents/fake/catalogue', { method: 'POST', body: { auto: true, prompt: 'never send this' } })).status,
    ).toBe(400)
  })
  it('finds no installed agent on a test Host: a preset by its bare command is missing, and nothing is read', async () => {
    const t = await startTestHost()
    hosts.push(t)
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.json('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
    })
    const codex = (await desktop.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')).catalog.harnesses.find(
      item => item.id === 'codex',
    )!
    expect(codex).toMatchObject({ status: 'unavailable' })
    expect(codex.login).toBeUndefined()
    expect(await (await desktop.request('agents/codex/catalogue', { method: 'POST', body: { auto: true } })).json()).toMatchObject({
      error: 'harness-unavailable',
    })
  })
  it('does not start the agent when the audit cannot be written', async () => {
    const { t, desktop, log } = await fixture({ FAKE_ACP_CONFIG: 'options' })
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    vi.spyOn(t.host.security.audit, 'append').mockImplementation(event =>
      event.action === 'agent.catalogue.requested' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
    )
    expect((await desktop.request('agents/fake/catalogue', { method: 'POST', body: {} })).status).toBe(503)
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps typed model IDs for the Harness, for every device to see', async () => {
    const { t, desktop } = await fixture()
    const viewer = await t.enroll({ scopes: ['view'] })
    expect((await viewer.request('agents/fake/models', { method: 'PUT', body: { models: ['x'] } })).status).toBe(403)
    expect(await desktop.json('agents/fake/models', { method: 'PUT', body: { models: ['vendor/one', ' vendor/two '] } })).toEqual({
      models: ['vendor/one', 'vendor/two'],
    })
    expect((await harnessInfo(viewer)).customModels).toEqual(['vendor/one', 'vendor/two'])
    expect((await desktop.request('agents/fake/models', { method: 'PUT', body: { models: [''] } })).status).toBe(400)
    expect(await desktop.json('agents/fake/models', { method: 'PUT', body: { models: [] } })).toEqual({ models: [] })
    expect((await harnessInfo(viewer)).customModels).toBeUndefined()
  })
})
