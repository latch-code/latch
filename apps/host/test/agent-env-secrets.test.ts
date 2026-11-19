import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSettings } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { redactKnownSecrets, setKnownSecrets } from '@latch/core/node-kit'
import { HostConfig } from '../src/config.ts'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Built here so the file holds no key-shaped literal; Cursor documents no shape for its keys. */
const KEY = ['key', 'c'.repeat(48)].join('_')
const CURSOR = { id: 'cursor', name: 'Cursor', command: process.execPath, args: [FAKE_ACP_AGENT], env: { CURSOR_API_KEY: KEY } }

describe("a Harness definition's key", () => {
  it('is saved only on this Mac, kept 0600, never returned to a device and masked in what the Host writes', async () => {
    const t = await startTestHost()
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
    expect(await (await browser.request('agents', { body: CURSOR })).json()).toMatchObject({ error: 'local-only' })
    await desktop.confirmedJson('agents', { body: CURSOR })

    const file = join(t.dataDir, 'settings.json')
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    for (const device of [browser, desktop]) {
      const listed = await device.request('agents')
      const text = await listed.text()
      expect(text).not.toContain(KEY)
      const agents = (JSON.parse(text) as { agents: AgentSettings[] }).agents
      expect(agents.find(agent => agent.id === 'cursor')?.envKeys).toEqual(['CURSOR_API_KEY'])
    }
    expect(await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')).not.toContain(KEY)
    expect(redactKnownSecrets(`failed with ${KEY}`)).toBe('failed with [redacted]')

    await desktop.json('agents/cursor', { method: 'DELETE' })
    expect(redactKnownSecrets(`failed with ${KEY}`)).toBe(`failed with ${KEY}`)
  })

  it('is masked again from the moment a Host opens its settings', async () => {
    const dataDir = join(await mkdtemp(join(tmpdir(), 'latch-agent-env-')), 'data')
    cleanups.push(() => rm(join(dataDir, '..'), { recursive: true, force: true }))
    const t = await startTestHost({ dataDir })
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.confirmedJson('agents', { body: { ...CURSOR, env: { CURSOR_API_KEY: KEY, PLAIN_SETTING: 'visible-value' } } })
    await t.close()
    // As a fresh process: nothing registered until the settings are read.
    setKnownSecrets('agent-env', [])
    expect(redactKnownSecrets(KEY)).toBe(KEY)
    const config = await HostConfig.open(dataDir)
    expect(config.settings().agents).toHaveLength(1)
    expect(redactKnownSecrets(`${KEY} visible-value`)).toBe('[redacted] visible-value')
    await config.updateSettings(draft => {
      draft.agents = []
    })
    expect(redactKnownSecrets(KEY)).toBe(KEY)
  })
})
