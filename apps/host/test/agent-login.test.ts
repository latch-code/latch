// The login routes in a real Host, with a fake program; nothing here can reach one installed on this computer.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(options: TestHostOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'latch-agent-login-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  const loginFile = join(directory, 'login')
  for (const name of ['codex', 'codex-acp']) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nexport FAKE_ACP_LOGIN_FILE='${loginFile}'\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
    )
    await chmod(join(bin, name), 0o755)
  }
  const scripts: string[] = []
  const t: TestHost = await startTestHost({
    tls: true,
    demo: false,
    detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
    loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
    commandDirectories: () => [bin],
    loginTerminal: script => {
      scripts.push(script)
      return Promise.resolve()
    },
    ...options,
  })
  cleanups.push(() => t.close())
  return { t, scripts, loginFile, bin }
}

const reply = async (response: Response) => [response.status, await response.json()] as const
const audited = async (t: TestHost, action: string) =>
  (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; detail: unknown })
    .filter(entry => entry.action === action)

describe('harness login routes', () => {
  it('answers in three states from the program, and remembers only for a moment', async () => {
    const { t, loginFile } = await fixture()
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    expect(await reply(await desktop.request('harnesses/codex/login-status', { body: {} }))).toEqual([200, { status: 'unauthenticated' }])
    await writeFile(loginFile, 'yes')
    // Asked again without `fresh`, the cached answer stands; after logging in, the page asks for a fresh one.
    expect((await reply(await desktop.request('harnesses/codex/login-status', { body: {} })))[1]).toEqual({ status: 'unauthenticated' })
    await new Promise(resolve => setTimeout(resolve, 2100))
    expect((await reply(await desktop.request('harnesses/codex/login-status', { body: { fresh: true } })))[1]).toEqual({
      status: 'authenticated',
    })
    expect((await audited(t, 'agent.login.checked')).map(entry => entry.detail)).toEqual([
      { agentId: 'codex', status: 'unauthenticated' },
      { agentId: 'codex', status: 'authenticated' },
    ])
  })

  it('needs `run`, and a preset with no saved definition needs a device that could save one', async () => {
    const { t } = await fixture()
    const viewer = await t.enroll({ listener: 'unix', name: 'Viewer', scopes: ['view'] })
    expect((await viewer.request('harnesses/codex/login-status', { body: {} })).status).toBe(403)
    const runner = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run'] })
    expect((await runner.request('harnesses/codex/login-status', { body: {} })).status).toBe(404)
    const owner = await t.enroll({ listener: 'tls', name: 'Tablet', scopes: ['view', 'run', 'admin'] })
    expect((await owner.request('harnesses/codex/login-status', { body: {} })).status).toBe(200)
    expect((await owner.request('harnesses/nothing/login-status', { body: {} })).status).toBe(404)
  })

  it('opens a terminal only for this computer, records it, and says so through the flag', async () => {
    const { t, scripts, bin } = await fixture()
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    const browser = await t.enroll({ name: 'Browser', scopes: ['view', 'run', 'admin'] })
    for (const remote of [phone, browser]) {
      expect(await reply(await remote.request('harnesses/codex/login-terminal', { body: {} }))).toMatchObject([
        403,
        { error: 'local-only' },
      ])
      expect(
        (await remote.json<{ catalog: { features: Record<string, unknown> } }>('snapshot')).catalog.features.loginTerminal,
      ).toBeUndefined()
    }
    expect(scripts).toEqual([])
    expect((await desktop.json<{ catalog: { features: Record<string, unknown> } }>('snapshot')).catalog.features.loginTerminal).toBe(true)
    expect(await reply(await desktop.request('harnesses/codex/login-terminal', { body: {} }))).toEqual([200, { opened: true }])
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain(`'${join(bin, 'codex')}' 'login'`)
    expect(await audited(t, 'agent.login.opened')).toHaveLength(1)
  })

  it('runs no real program and offers no login in a Host that did not ask for it', async () => {
    const { t, loginFile } = await fixture({ loginPrograms: undefined })
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    expect(await reply(await desktop.request('harnesses/codex/login-status', { body: {} }))).toEqual([200, { status: 'unknown' }])
    expect((await desktop.request('harnesses/codex/login-terminal', { body: {} })).status).toBe(404)
    await expect(stat(loginFile)).rejects.toThrow()
    await expect(readFile(loginFile)).rejects.toThrow()
  })
})
