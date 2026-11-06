import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { redactSecrets } from '@latch/core/node-kit'
import { FAKE_ACP_AGENT, recordHarness, type RecordInput } from '@latch/testkit'
import { createAcpAgentPlugin, forgetCommandLookups, setCommandSearch } from '../src/index.ts'
import { activate, openBridge, replayTranscript } from './helpers/replay.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  forgetCommandLookups()
})

const sandboxed = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

/** Records from the fake ACP agent, never a real one, with a stand-in for the person's home whose logins it must not read. */
async function record(scenario: string, extra: Partial<RecordInput> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-record-test-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const realHome = join(root, 'person')
  await mkdir(join(realHome, 'Library/Keychains'), { recursive: true })
  await writeFile(join(realHome, 'Library/Keychains/login.keychain-db'), 'not a keychain')
  const agentLog = join(root, 'agent.log')
  const outDir = join(root, 'out')
  const recorded = await recordHarness({
    harness: 'dsh',
    scenario,
    command: process.execPath,
    args: [FAKE_ACP_AGENT],
    env: {
      FAKE_ACP_LOG: agentLog,
      FAKE_ACP_STATE: join(root, 'agent-state.json'),
      FAKE_ACP_DUMP_ENV: '1',
      FAKE_ACP_CAPS: 'resume',
      FAKE_MODEL: '{{MODEL_ORIGIN}}/v1',
    },
    keep: ['DSH_PERMISSION_MODE'],
    outDir,
    realHome,
    redact: redactSecrets,
    open: async ({ definition, dataDir, workspace, tmpRoot }) => {
      const plugin = createAcpAgentPlugin({ id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', enabled: true, ...definition })
      return openBridge(await activate(plugin, cleanups), { dataDir, workspace, tmpRoot }, cleanups)
    },
    ...extra,
  })
  const agentLines = (await readFile(agentLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; env?: Record<string, string>; [key: string]: unknown })
  return { ...recorded, root, outDir, agentLines }
}

describe.runIf(sandboxed)('recording a harness', () => {
  it('records the fake agent in the sandbox with a home of its own, and the result replays', async () => {
    process.env.OPENAI_API_KEY = 'sk-from-the-person-environment-1234567890'
    cleanups.push(() => {
      delete process.env.OPENAI_API_KEY
    })
    const { path, transcript, root, agentLines } = await record('resume')
    const env = agentLines.find(line => line.event === 'env')!.env!
    // Its own home and directories, none of the person's keys, and the fake model's address it was given.
    expect(env.HOME).toMatch(/latch-record-[^/]+\/home$/u)
    expect(env.HOME.startsWith(homedir())).toBe(false)
    expect(env.XDG_CONFIG_HOME).toBe(join(env.HOME, '.config'))
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost')
    expect(env.FAKE_MODEL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u)
    expect(env.DSH_PERMISSION_MODE).toBe('read-only')
    // The agent ran twice: once before the reopen and once after.
    expect(agentLines.filter(line => line.event === 'start')).toHaveLength(2)

    expect(transcript.header).toMatchObject({ harness: 'dsh', scenario: 'resume', source: 'recorded', agent: { version: '1.2.3' } })
    const text = await readFile(path, 'utf8')
    expect(text).toContain('<workspace>')
    expect(text).not.toContain(root)
    expect(text).not.toContain(tmpdir())
    expect(
      text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu)?.every(id => id.startsWith('00000000-0000-4000-8000-')),
    ).toBe(true)
    expect(transcript.entries.filter(entry => entry.type === 'runtime_exit')).toHaveLength(1)

    // What was recorded plays back through the same driver as a fixture would.
    const replayed = await replayTranscript(path, cleanups)
    expect(replayed.status?.failure).toBeUndefined()
    expect(replayed.status?.cursor).toBe(replayed.status?.total)
    expect(replayed.detail.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual([
      'echo: Say hello',
      'echo: And again',
    ])
  })

  it("keeps the agent off the network and away from the person's keychain files, and refuses without that", async () => {
    const probe = join(tmpdir(), `latch-record-probe-${process.pid}.mjs`)
    cleanups.push(() => rm(probe, { force: true }))
    const { sandboxProfile } = await import('@latch/testkit')
    const home = await realpath(await mkdtemp(join(tmpdir(), 'latch-record-home-')))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    await mkdir(join(home, 'Library/Keychains'), { recursive: true })
    await writeFile(join(home, 'Library/Keychains/login.keychain-db'), 'x')
    await writeFile(
      probe,
      `import net from 'node:net'; import { readFileSync } from 'node:fs'
const server = net.createServer(socket => socket.end()).listen(0, '127.0.0.1', async () => {
  const reach = (host, port) => new Promise(done => { const s = net.connect(port, host); s.setTimeout(3000, () => { s.destroy(); done('timeout') }); s.on('connect', () => { s.destroy(); done('connected') }); s.on('error', e => done(e.code)) })
  let read; try { readFileSync(process.argv[2]); read = 'read' } catch (e) { read = e.code }
  const model = Number(process.argv[3])
  console.log(JSON.stringify({ model: await reach('127.0.0.1', model), modelByName: await reach('localhost', model), otherPort: await reach('127.0.0.1', server.address().port), away: await reach('192.0.2.1', 9), read }))
  server.close()
})`,
    )
    // Only the fake model's port: any other port on this computer may be a proxy that leads off it.
    const model = net.createServer(socket => socket.end())
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => model.close(() => resolve())))
    const port = (model.address() as net.AddressInfo).port
    const { spawnSync } = await import('node:child_process')
    const run = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', sandboxProfile(home, port), process.execPath, probe, join(home, 'Library/Keychains/login.keychain-db'), String(port)],
      {
        encoding: 'utf8',
      },
    )
    expect(JSON.parse(run.stdout)).toEqual({
      model: 'connected',
      modelByName: 'connected',
      otherPort: 'EPERM',
      away: 'EPERM',
      read: 'EPERM',
    })

    // A "sandbox" that lets the connection through: the agent is never started.
    const bin = await realpath(await mkdtemp(join(tmpdir(), 'latch-record-bin-')))
    cleanups.push(() => rm(bin, { recursive: true, force: true }))
    await writeFile(join(bin, 'sandbox-exec'), '#!/bin/sh\nshift 2\nexec "$@"\n')
    await chmod(join(bin, 'sandbox-exec'), 0o755)
    await expect(record('simple', { sandboxExec: join(bin, 'sandbox-exec') })).rejects.toThrow(
      /the agent was not started: the sandbox did not block/u,
    )
    await expect(record('simple', { sandboxExec: join(bin, 'missing') })).rejects.toThrow(/needs the macOS sandbox/u)
    // One that blocks hosts elsewhere but every port on this computer, where a local proxy may listen: refused too.
    await writeFile(
      join(bin, 'loopback-sandbox'),
      `#!/bin/sh\nshift 2\nexec /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))' "$@"\n`,
    )
    await chmod(join(bin, 'loopback-sandbox'), 0o755)
    await expect(record('simple', { sandboxExec: join(bin, 'loopback-sandbox') })).rejects.toThrow(
      /the agent was not started: the sandbox did not block a connection to another port on this computer/u,
    )
  })
})
