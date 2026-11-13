import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareDshMode, readDshMode } from '../src/profiles/dsh-mode.ts'
import { AcpWire } from '../src/wires/acp.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'latch-dsh-mode-'))
  roots.push(root)
  return root
}

describe('the dsh permission service bridge', () => {
  it('changes through the public service and reports its actual value, while a check never calls its setter', async () => {
    const root = await directory()
    await prepareDshMode(root, 'workspace-write')
    const plugin = (await import(pathToFileURL(join(root, 'latch-permission.mjs')).href)) as {
      apply(context: unknown, config: { mode?: string }): void
    }
    const session = { header: { id: 'session-a' } }
    for (const selected of ['workspace-write', undefined]) {
      let current = 'read-only'
      const handlers = new Map<string, (...args: unknown[]) => void>()
      const set = vi.fn((_session, value: string) => {
        current = value
      })
      const records: unknown[] = []
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
        records.push(JSON.parse(String(chunk)))
        return true
      })
      try {
        plugin.apply(
          {
            permissionPresets: { set, current: () => current },
            on: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler),
          },
          selected === undefined ? {} : { mode: selected },
        )
        handlers.get('agent/created')!({ agent: { session } })
        expect(set).toHaveBeenCalledTimes(selected === undefined ? 0 : 1)
        expect(records).toEqual([{ jsonrpc: '2.0', method: '_latch/permission', params: { sessionId: 'session-a', mode: current } }])
      } finally {
        write.mockRestore()
      }
    }
    expect((await stat(join(root, 'latch-permission.mjs'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'latch-permission.patch.json'))).mode & 0o777).toBe(0o600)
  })

  it('rejects unknown modes before writing a launch patch and ignores malformed reports', async () => {
    await expect(prepareDshMode(await directory(), 'invented')).rejects.toThrow('Unknown')
    expect(readDshMode('_latch/permission', { sessionId: 'session-a', mode: 'read-only' })).toEqual({
      sessionId: 'session-a',
      mode: 'read-only',
    })
    expect(readDshMode('_latch/permission', { sessionId: '', mode: 'read-only' })).toBeUndefined()
    expect(readDshMode('session/update', { sessionId: 'session-a', mode: 'read-only' })).toBeUndefined()
  })
})

// Explicitly enabled for the owner's local installation: isolated home and no prompt or model request.
it.runIf(process.env.LATCH_DSH_BINARY)(
  'reads the real dsh service across a new session, restart with another mode, and a read-only check',
  async () => {
    const root = await directory()
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    await mkdir(home)
    await mkdir(workspace)
    let sessionId: string | undefined
    for (const [mode, expected] of [
      ['read-only', 'read-only'],
      ['workspace-write', 'workspace-write'],
      [undefined, 'workspace-write'],
    ] as const) {
      const launch = await prepareDshMode(join(root, `launch-${mode ?? 'check'}`), mode)
      const readings: Array<{ sessionId: string; mode: string }> = []
      const wire = AcpWire.spawn(
        {
          command: process.env.LATCH_DSH_BINARY!,
          args: ['--profile', 'acp', ...launch.args],
          cwd: workspace,
          env: { HOME: home, DSH_HOME: join(home, '.dsh'), PATH: process.env.PATH ?? '', TMPDIR: root, ...launch.env },
          maxLineBytes: 64 * 1024 * 1024,
          redact: text => text,
        },
        {
          request: async () => ({ outcome: { outcome: 'cancelled' } }),
          notification: (method, params) => {
            const reading = readDshMode(method, params)
            if (reading) readings.push(reading)
          },
          exit: () => {},
        },
      )
      try {
        await wire.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000)
        const result = await wire.request(
          sessionId ? 'session/resume' : 'session/new',
          { ...(sessionId ? { sessionId } : {}), cwd: workspace, mcpServers: [] },
          30_000,
        )
        if (!sessionId) sessionId = (result as { sessionId: string }).sessionId
        expect(sessionId).toBeTruthy()
        await vi.waitFor(() => expect(readings).toContainEqual({ sessionId, mode: expected }), { timeout: 3_000 })
      } finally {
        await wire.stop('stop', 2_000)
      }
    }
  },
  120_000,
)
