import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeSettings } from '../src/native-settings.ts'
import { AuditLog } from '../src/audit.ts'
import { RelayProfiles, type NativeDirect } from '../src/relay/profiles.ts'
import type { HostRelayController } from '../src/relay/controller.ts'
import type { NativeNetworkSnapshot } from '../src/native-network-backend.ts'
import type { startNativeHost } from '../src/native.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})
const snapshot: NativeNetworkSnapshot = {
  epoch: randomUUID(),
  interfaces: [{ name: 'en0', index: 3, address: '192.168.1.4', prefixLength: 24, kind: 'wifi', gateway: '192.168.1.1' }],
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'latch-auto-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const profiles = await RelayProfiles.open(directory),
    audit = await AuditLog.open(directory)
  cleanup.push(() => audit.close())
  let bound: NativeDirect | null = null
  const canceled = vi.fn(),
    committed = vi.fn(),
    prepare = vi.fn(),
    ensure = vi.fn(),
    changed = vi.fn()
  const native: Awaited<ReturnType<typeof startNativeHost>> = {
    origin: 'https://native.invalid',
    get enabled() {
      return Boolean(bound)
    },
    get port() {
      return bound?.port
    },
    get direct() {
      return bound && { ...bound }
    },
    async prepareBind(next) {
      prepare(next)
      if (next?.host === 'auto') throw new Error('Logical auto reached socket')
      return {
        commit() {
          committed(next)
          bound = next ? { host: next.host, port: next.port || 54321 } : null
        },
        async cancel() {
          canceled(next)
        },
      }
    },
    async ensureTransport() {
      ensure()
    },
    async invite() {
      throw new Error('unused')
    },
    async acceptRelay(stream: Duplex) {
      stream.destroy()
    },
    closeRelay() {},
    async close() {},
  }
  const resolve = vi.fn(async () => ({ host: snapshot.interfaces[0]!.address, port: 0 }))
  const settings = new NativeSettings({
    profiles,
    audit,
    native,
    controller: { status: () => [], reconcile() {} } as unknown as HostRelayController,
    inputsPaused: () => false,
    changed,
    resolveDirect: resolve,
  })
  return { directory, profiles, audit, native, settings, prepare, canceled, committed, ensure, resolve, changed }
}
const actor = { listener: 'unix' as const }
const input = (profiles: RelayProfiles, direct: NativeDirect | null) => ({
  requestId: randomUUID(),
  configHash: profiles.configHash(),
  direct,
  relays: [],
})
it('persists logical auto only after Mac consent and audit while binding a concrete address', async () => {
  const s = await setup(),
    plan = s.settings.plan(input(s.profiles, { host: 'auto', port: 0 }))
  expect(plan.lowering).toBe(false)
  await expect(s.settings.apply(plan, actor, 'none', () => {})).rejects.toMatchObject({ code: 'stepup-required' })
  expect(s.prepare).not.toHaveBeenCalled()
  const audit = s.audit.append.bind(s.audit)
  const written = vi.spyOn(s.audit, 'append').mockImplementation(async event => {
    expect(s.prepare).not.toHaveBeenCalled()
    return audit(event)
  })
  await s.settings.apply(plan, actor, 'lpc-local', () => {})
  expect(written).toHaveBeenCalled()
  expect(s.ensure).toHaveBeenCalledTimes(1)
  expect(s.settings.info().direct).toEqual({ host: 'auto', port: 0 })
  expect(s.settings.info().listening).toEqual({ host: '192.168.1.4', port: 54321 })
  expect((await RelayProfiles.open(s.directory)).snapshot().direct).toEqual({ host: 'auto', port: 0 })
})
it('automatically follows a new physical network without changing logical configuration or reopening to tunnels', async () => {
  const s = await setup()
  await s.settings.apply(s.settings.plan(input(s.profiles, { host: 'auto', port: 0 })), actor, 'lpc-local', () => {})
  const hash = s.profiles.configHash()
  await s.settings.syncNetwork(
    { ...snapshot, epoch: randomUUID(), interfaces: [{ ...snapshot.interfaces[0]!, address: '192.168.2.4' }] },
    () => true,
  )
  expect(s.native.direct).toEqual({ host: '192.168.2.4', port: 54321 })
  expect(s.profiles.configHash()).toBe(hash)
  await s.settings.syncNetwork({ ...snapshot, interfaces: [{ ...snapshot.interfaces[0]!, name: 'utun5', kind: 'tunnel' }] }, () => true)
  expect(s.native.direct).toBeNull()
  expect(s.profiles.snapshot().direct?.host).toBe('auto')
})
it('cancels a late prepared listener after a network epoch changes and serializes a free disable behind it', async () => {
  const s = await setup()
  await s.settings.apply(s.settings.plan(input(s.profiles, { host: 'auto', port: 0 })), actor, 'lpc-local', () => {})
  const prepare = s.native.prepareBind.bind(s.native)
  let release!: () => void,
    current = true
  vi.spyOn(s.native, 'prepareBind').mockImplementationOnce(async next => {
    const result = await prepare(next)
    await new Promise<void>(resolve => {
      release = resolve
    })
    return result
  })
  const sync = s.settings.syncNetwork({ ...snapshot, interfaces: [{ ...snapshot.interfaces[0]!, address: '192.168.2.4' }] }, () => current)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const disabling = s.settings.apply(s.settings.plan(input(s.profiles, null)), actor, 'none', () => {})
  current = false
  release()
  await sync
  await disabling
  expect(s.canceled).toHaveBeenCalledWith({ host: '192.168.2.4', port: 54321 })
  expect(s.native.direct).toBeNull()
  expect(s.profiles.snapshot().direct).toBeNull()
  await s.settings.syncNetwork(snapshot, () => true)
  expect(s.native.direct).toBeNull()
})
it('keeps reductions free when the network component or audit is unavailable', async () => {
  const s = await setup()
  await s.settings.apply(s.settings.plan(input(s.profiles, { host: 'auto', port: 0 })), actor, 'lpc-local', () => {})
  s.resolve.mockRejectedValueOnce(new Error('component unavailable'))
  vi.spyOn(s.audit, 'append').mockRejectedValue(new Error('audit unavailable'))
  const unchanged = await s.settings.apply(s.settings.plan(input(s.profiles, { host: 'auto', port: 0 })), actor, 'none', () => {})
  expect(unchanged.audited).toBe(false)
  expect(s.resolve).toHaveBeenCalledTimes(1)
  const disabled = await s.settings.apply(s.settings.plan(input(s.profiles, null)), actor, 'none', () => {})
  expect(disabled.audited).toBe(false)
  expect(s.native.direct).toBeNull()
})
