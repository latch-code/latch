import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRecord, AgentSettings } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { createAcpAgentPlugin, forgetCommandLookups } from '@latch/harness-acp'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ADMIN = ['view', 'run', 'approve:standard', 'admin'] as const
/** The Host's own preset: `goose acp`, no variables. */
const GOOSE = { id: 'goose', name: 'Goose', presetId: 'goose', command: 'goose', args: ['acp'], env: {} }

async function folder(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

/** A program named `name` in `bin` that runs the fake ACP agent with its state under `root`. */
async function program(bin: string, name: string, root: string): Promise<string> {
  await mkdir(bin, { recursive: true })
  const path = join(bin, name)
  await writeFile(
    path,
    `#!/bin/sh\nexport FAKE_ACP_STATE='${join(root, `${name}-state.json`)}'\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
  )
  await chmod(path, 0o755)
  return path
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function audit(t: TestHost): Promise<Array<{ action: string; stepup: string; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

async function presetHost(directories: () => readonly string[], dataDir?: string, path?: () => readonly string[]) {
  const t = await startTestHost({
    agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
    commandDirectories: directories,
    ...(path ? { pathDirectories: path } : {}),
    ...(dataDir ? { dataDir } : {}),
  })
  cleanups.push(() => t.close())
  forgetCommandLookups()
  const desktop = await t.enroll({ listener: 'unix' })
  const browser = await t.enroll({ scopes: [...ADMIN] })
  return { t, desktop, browser, asked: t.presence.requests.length }
}

async function startOn(t: TestHost, device: Awaited<ReturnType<TestHost['enroll']>>, harnessId: string, prompt = 'echo hi') {
  const response = await device.request('tasks', { body: { prompt, requestId: randomUUID(), mode: 'agent', harnessId } })
  return { response, result: await body<{ sessionId?: string; error?: string }>(response) }
}

describe("a preset's own command", () => {
  it('is saved on this Mac without a confirmation, bound to the path the Host found, and on record as a preset', async () => {
    const root = await folder('latch-preset-')
    const path = await program(join(root, 'bin'), 'goose', root)
    const { t, desktop, asked } = await presetHost(() => [join(root, 'bin')])
    const saved = await desktop.request('agents', { body: GOOSE })
    expect(saved.status).toBe(201)
    expect(t.presence.requests).toHaveLength(asked)
    const record = JSON.parse(await readFile(join(t.dataDir, 'settings.json'), 'utf8')).agents.find(
      (agent: AgentRecord) => agent.id === 'goose',
    )
    expect(record.confirmedCommand).toBe(path)
    expect((await audit(t)).filter(item => item.action === 'agent.defined')).toMatchObject([
      { stepup: 'preset', detail: { agentId: 'goose', created: true } },
    ])
    const { result } = await startOn(t, desktop, 'goose')
    expect(result.sessionId).toEqual(expect.any(String))
  })

  it('asks the moment the definition differs from the preset, whatever the client calls it', async () => {
    const root = await folder('latch-preset-')
    const path = await program(join(root, 'bin'), 'goose', root)
    await program(join(root, 'bin'), 'pi', root)
    const { t, desktop } = await presetHost(() => [join(root, 'bin')])
    const variants = [
      { ...GOOSE, args: ['acp', '--extra'] },
      { ...GOOSE, args: [] },
      { ...GOOSE, env: { GOOSE_PROVIDER: 'x' } },
      { ...GOOSE, command: path },
      // Another preset's command under this preset's name.
      { ...GOOSE, command: 'pi', args: [] },
      // A preset's command with no preset named is a custom command.
      { id: 'goose', name: 'Goose', command: 'goose', args: ['acp'], env: {} },
    ]
    for (const variant of variants) {
      const before = t.presence.requests.length
      const response = await desktop.request('agents', { body: variant })
      expect.soft(response.status, JSON.stringify(variant)).toBe(403)
      expect.soft(await body(response)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
      expect.soft(t.presence.requests).toHaveLength(before + 1)
    }
    // An edit of a saved preset away from it asks too; a new name changes nothing that runs.
    await desktop.json('agents', { body: GOOSE })
    const edited = await desktop.request('agents/goose', { method: 'PUT', body: { args: ['acp', '--x'] } })
    expect(await body(edited)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
    const renamed = await desktop.request('agents/goose', { method: 'PUT', body: { name: 'Goose 2' } })
    expect(renamed.status).toBe(200)
  })

  it('is refused from any device but this Mac, as every Harness definition is', async () => {
    const root = await folder('latch-preset-')
    await program(join(root, 'bin'), 'goose', root)
    const { t, browser, asked } = await presetHost(() => [join(root, 'bin')])
    expect(await body(await browser.request('agents', { body: GOOSE }))).toMatchObject({ error: 'local-only' })
    const viewer = await t.enroll({ listener: 'unix', scopes: ['view', 'run'] })
    expect(await body(await viewer.request('agents', { body: GOOSE }))).toMatchObject({ error: 'scope-required', required: 'admin' })
    expect(t.presence.requests).toHaveLength(asked + 1)
    expect((await audit(t)).some(item => item.action === 'agent.defined')).toBe(false)
  })

  it('does not run another program found earlier on the lookup path; saving it again asks', async () => {
    const root = await folder('latch-preset-')
    const first = join(root, 'first')
    const earlier = join(root, 'earlier')
    await program(first, 'goose', root)
    let directories = [first]
    const { t, desktop, browser } = await presetHost(() => directories)
    await desktop.json('agents', { body: GOOSE })
    // Another `goose` shadows the one the definition is bound to.
    const shadow = await program(earlier, 'goose', root)
    directories = [earlier, first]
    forgetCommandLookups()
    for (const device of [desktop, browser]) {
      const { response, result } = await startOn(t, device, 'goose')
      expect.soft(response.status).toBe(409)
      // Refused before it starts: as moved, or as unavailable while the catalog says so.
      expect.soft(['harness-command-moved', 'harness-unavailable']).toContain(result.error)
    }
    const again = await desktop.request('agents/goose', { method: 'PUT', body: { command: 'goose' } })
    expect(await body(again)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '命令', value: shadow })
  })

  it('is refused while a full-access session runs or waits, as a confirmation would be', async () => {
    const root = await folder('latch-preset-')
    await program(join(root, 'bin'), 'goose', root)
    const { t, desktop } = await presetHost(() => [join(root, 'bin')])
    const fake = {
      id: 'fake',
      name: 'Fake agent',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_STATE: join(root, 'fake-state.json'), FAKE_ACP_MODES: 'read-only,auto' },
    }
    await desktop.confirmedJson('agents', { body: fake })
    const started = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'delegate stop', requestId: randomUUID(), mode: 'agent', harnessId: 'fake' },
    })
    await expect
      .poll(() => t.host.bridge.approvals().filter(item => item.sessionId === started.sessionId).length, { timeout: 10_000 })
      .toBe(1)
    expect(await body(await desktop.request('agents', { body: GOOSE }))).toMatchObject({
      error: 'presence-blocked',
      blockingTasks: [{ id: started.sessionId }],
    })
    expect((await audit(t)).filter(item => item.action === 'agent.defined')).toHaveLength(1)
    await desktop.json(`tasks/${started.sessionId}/cancel`, { method: 'POST', body: {} })
    await expect
      .poll(async () => (await t.host.bridge.detail(started.sessionId)).summary.status, { timeout: 10_000 })
      .not.toMatch(/running|waiting/u)
    expect((await desktop.request('agents', { body: GOOSE })).status).toBe(201)
  })

  it('binds a preset saved before definitions were bound at its first start on this Mac, without asking', async () => {
    const root = await folder('latch-preset-')
    const path = await program(join(root, 'bin'), 'goose', root)
    const dataDir = join(root, 'data')
    const first = await presetHost(() => [join(root, 'bin')], dataDir)
    await first.desktop.json('agents', { body: GOOSE })
    await first.t.close()
    const file = join(dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8'))
    for (const agent of settings.agents) delete agent.confirmedCommand
    await writeFile(file, JSON.stringify(settings))
    const { t, desktop, browser, asked } = await presetHost(() => [join(root, 'bin')], dataDir)
    expect((await startOn(t, browser, 'goose')).result).toMatchObject({ error: 'harness-unconfirmed' })
    expect((await startOn(t, desktop, 'goose')).result.sessionId).toEqual(expect.any(String))
    expect(t.presence.requests).toHaveLength(asked)
    expect(JSON.parse(await readFile(file, 'utf8')).agents[0].confirmedCommand).toBe(path)
    expect((await audit(t)).filter(item => item.action === 'agent.defined').at(-1)).toMatchObject({ stepup: 'preset' })
  })

  it('removes at start the definition pi saved for its old adapter, and keeps a command of the person’s own', async () => {
    const root = await folder('latch-preset-')
    await program(join(root, 'bin'), 'goose', root)
    const adapter = await program(join(root, 'bin'), 'pi-acp', root)
    const dataDir = join(root, 'data')
    const first = await presetHost(() => [join(root, 'bin')], dataDir)
    await first.desktop.json('agents', { body: GOOSE })
    await first.t.close()
    // As a Host from before pi ran its own program left it: the pi preset bound to the adapter, nothing else set.
    const file = join(dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8'))
    const goose = settings.agents[0] as AgentRecord
    const stale = { ...goose, id: 'pi', name: 'pi', presetId: 'pi', command: adapter, args: [], env: {}, confirmedCommand: adapter }
    const own = { ...stale, id: 'pi-mine', name: 'my pi', args: ['--mine'] }
    settings.agents = [goose, stale, own]
    await writeFile(file, JSON.stringify(settings))
    const { t } = await presetHost(() => [join(root, 'bin')], dataDir)
    const ids = () => readFile(file, 'utf8').then(text => (JSON.parse(text).agents as AgentRecord[]).map(agent => agent.id))
    // The adapter does not answer pi's own protocol: its definition is gone before anything could start it.
    expect(await ids()).toEqual(['goose', 'pi-mine'])
    expect((await audit(t)).filter(item => item.action === 'agent.deleted')).toMatchObject([{ detail: { agentId: 'pi' } }])
    // Nothing was bound in its place.
    expect(JSON.parse(await readFile(file, 'utf8')).agents.some((agent: AgentRecord) => agent.presetId === 'pi' && agent.id === 'pi')).toBe(
      false,
    )
  })

  it("takes the preset's adapter as the preset too", async () => {
    const root = await folder('latch-preset-')
    const path = await program(join(root, 'bin'), 'codex-acp', root)
    const { t, desktop, asked } = await presetHost(() => [join(root, 'bin')])
    const saved = await desktop.json<{ agent: AgentSettings }>('agents', {
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
    })
    expect(saved.agent).toMatchObject({ command: 'codex-acp' })
    expect(t.presence.requests).toHaveLength(asked)
    const record = JSON.parse(await readFile(join(t.dataDir, 'settings.json'), 'utf8')).agents[0] as AgentRecord
    expect(record.confirmedCommand).toBe(path)
  })

  it('asks for a preset found only in the extra install directories, naming the path', async () => {
    const root = await folder('latch-preset-')
    const extra = await program(join(root, 'extra'), 'goose', root)
    const { t, desktop } = await presetHost(
      () => [join(root, 'path'), join(root, 'extra')],
      undefined,
      () => [join(root, 'path')],
    )
    const response = await desktop.request('agents', { body: GOOSE })
    expect(await body(response)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '命令', value: extra })
  })

  it('remembers the bound path after the definition is removed: re-adding it where another program now shadows it asks', async () => {
    const root = await folder('latch-preset-')
    const later = join(root, 'later')
    const earlier = join(root, 'earlier')
    await program(later, 'goose', root)
    let directories = [later]
    const { t, desktop, browser } = await presetHost(() => directories)
    await desktop.json('agents', { body: GOOSE })
    // Removed from another device, which needs only admin.
    expect((await browser.request('agents/goose', { method: 'DELETE' })).status).toBe(200)
    const planted = await program(earlier, 'goose', root)
    directories = [earlier, later]
    forgetCommandLookups()
    const before = t.presence.requests.length
    const again = await desktop.request('agents', { body: GOOSE })
    expect(await body(again)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
    expect(t.presence.requests).toHaveLength(before + 1)
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '命令', value: planted })
    // Back where it was bound, nothing asks.
    directories = [later]
    forgetCommandLookups()
    expect((await desktop.request('agents', { body: GOOSE })).status).toBe(201)
    expect(t.presence.requests).toHaveLength(before + 1)
  })

  it('keeps the pin of a definition saved before pins were kept, once it is removed', async () => {
    const root = await folder('latch-preset-')
    const later = join(root, 'later')
    const earlier = join(root, 'earlier')
    await program(later, 'goose', root)
    let directories = [later]
    const dataDir = join(root, 'data')
    const first = await presetHost(() => directories, dataDir)
    await first.desktop.json('agents', { body: GOOSE })
    await first.t.close()
    // As written by a Host from before: the definition holds its path, and nothing else does.
    const file = join(dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8'))
    delete settings.presetBindings
    expect(settings.agents[0].confirmedCommand).toBe(join(later, 'goose'))
    await writeFile(file, JSON.stringify(settings))
    const { t, desktop, browser } = await presetHost(() => directories, dataDir)
    expect((await browser.request('agents/goose', { method: 'DELETE' })).status).toBe(200)
    const planted = await program(earlier, 'goose', root)
    directories = [earlier, later]
    forgetCommandLookups()
    const again = await desktop.request('agents', { body: GOOSE })
    expect(await body(again)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '命令', value: planted })
  })

  it('asks for a second definition of a preset when its command now finds another program than the first one', async () => {
    const root = await folder('latch-preset-')
    const later = join(root, 'later')
    const earlier = join(root, 'earlier')
    await program(later, 'goose', root)
    let directories = [later]
    const dataDir = join(root, 'data')
    const first = await presetHost(() => directories, dataDir)
    await first.desktop.json('agents', { body: GOOSE })
    await first.t.close()
    const file = join(dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8'))
    delete settings.presetBindings
    await writeFile(file, JSON.stringify(settings))
    const { desktop } = await presetHost(() => directories, dataDir)
    await program(earlier, 'goose', root)
    directories = [earlier, later]
    forgetCommandLookups()
    const second = await desktop.request('agents', { body: { ...GOOSE, id: 'goose-2', name: 'Goose 2' } })
    expect(await body(second)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
  })

  it('lists its definition with the values the Host saved', async () => {
    const root = await folder('latch-preset-')
    await program(join(root, 'bin'), 'goose', root)
    const { desktop } = await presetHost(() => [join(root, 'bin')])
    const saved = await desktop.json<{ agent: AgentSettings }>('agents', { body: GOOSE })
    expect(saved.agent).toMatchObject({ id: 'goose', command: 'goose', args: ['acp'] })
  })
})

describe("a preset model service's key", () => {
  it('waits while a full-access session runs or waits, and an address away from the preset still asks', async () => {
    const root = await folder('latch-preset-')
    const { t, desktop, browser } = await presetHost(() => [])
    await desktop.confirmedJson('agents', {
      body: {
        id: 'fake',
        name: 'Fake agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_STATE: join(root, 'state.json') },
      },
    })
    const deepseek = {
      name: 'DeepSeek',
      kind: 'openai-compatible',
      presetId: 'deepseek',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    }
    const preset = { ...deepseek, baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-preset' }
    // Off this Mac no key at all, preset or not.
    expect(await body(await browser.request('providers', { body: preset }))).toMatchObject({ error: 'scope-required', required: 'secrets' })
    for (const baseURL of ['https://api.deepseek.com.example.net/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1']) {
      const response = await desktop.request('providers', { body: { ...preset, id: `other-${t.presence.requests.length}`, baseURL } })
      expect
        .soft(await body(response), baseURL)
        .toMatchObject({ error: 'stepup-required', confirmation: { action: 'provider.confirm-origin' } })
    }
    const started = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'delegate stop', requestId: randomUUID(), mode: 'agent', harnessId: 'fake' },
    })
    await expect
      .poll(() => t.host.bridge.approvals().filter(item => item.sessionId === started.sessionId).length, { timeout: 10_000 })
      .toBe(1)
    expect(await body(await desktop.request('providers', { body: preset }))).toMatchObject({ error: 'presence-blocked' })
    expect((await audit(t)).some(item => item.action === 'provider.secret.set')).toBe(false)
    await desktop.json(`tasks/${started.sessionId}/cancel`, { method: 'POST', body: {} })
    await expect
      .poll(async () => (await t.host.bridge.detail(started.sessionId)).summary.status, { timeout: 10_000 })
      .not.toMatch(/running|waiting/u)
    const saved = await desktop.request('providers', { body: preset })
    expect(saved.status).toBe(201)
    expect(JSON.stringify(await body(saved))).not.toContain('sk-preset')
  })
})
