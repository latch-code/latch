import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

interface Release {
  version: string
  notes: { 'zh-CN': string; en: string }
  minHostProtocol: number
  host: { version: string; protocol: number }
  pluginApi: { formats: number[] }
  assets: Array<{ platform: string; arch: string; url: string; sha512: string; size: number }>
  publishedAt: string
  expiresAt: string
}
interface HostStatus {
  open: boolean
  version: string
  protocol: number
  busy: { running: number; waiting: number; unknown: number; queued: number; terminals: number; services: number }
  plugins: Array<{ id: string; name: string; formatVersion: number; enabled: boolean }>
  held: Array<{ id: string; name: string }>
}
interface View {
  state: string
  appVersion: string
  autoDownload: boolean
  installAtQuit: boolean
  reason?: string
  release?: {
    version: string
    plan: 'app' | 'host'
    incompatiblePlugins: Array<{ id: string; name: string }>
    notes: Record<string, string>
  }
  progress?: { received: number; total: number }
  waiting?: { count: number; running: number; waiting: number; unknown: number }
  failure?: { stage: string; code: string }
  heldPlugins: Array<{ id: string; name: string }>
}
interface Updater {
  view(): View
  check(): Promise<View>
  download(): Promise<View>
  install(when?: 'now' | 'at-quit'): Promise<View>
  cancelWaiting(): Promise<View>
  setAutoDownload(on: boolean): Promise<View>
  holdsQuit(input: { system: boolean }): boolean
  quitting(): Promise<boolean>
  start(): void
  resume(): void
  stop(): void
}
type Get = (url: string, options?: { signal?: AbortSignal }) => Promise<{ status: number; body: AsyncIterable<Buffer> }>
interface UpdaterModule {
  UpdateError: new (stage: string, code: string) => Error & { stage: string; code: string }
  FIRST_CHECK_MS: number
  CHECK_EVERY_MS: number
  WAIT_POLL_MS: number
  compareVersions(a: string, b: string): number
  verifyFeed(
    text: string,
    options: { publicKey: KeyObject; platform: string; arch: string; feedOrigin: string },
  ): { ok: true; release: Release & { asset: Release['assets'][number] } } | { ok: false; code: string }
  publicKeyFrom(base64: string): KeyObject
  createFeedSource(options: { feedUrl: string; publicKey: string; platform: string; arch: string; cacheDir: string; get: Get }): {
    latest(): Promise<Release & { asset: Release['assets'][number] }>
    download(
      release: unknown,
      options: { onProgress(received: number, total: number): void; signal?: AbortSignal },
    ): Promise<{ file: string }>
    sweep(keep: string): Promise<void>
  }
  readUpdatePreferences(directory: string): Promise<{ autoDownload: boolean }>
  writeUpdatePreferences(directory: string, value: { autoDownload: boolean }): Promise<void>
  planFor(release: Release, host: HostStatus | undefined): 'app' | 'host'
  incompatiblePlugins(release: Release, host: HostStatus | undefined): Array<{ id: string; name: string }>
  parseHostStatus(value: unknown): HostStatus | undefined
  createUpdater(options: Record<string, unknown>): Updater
  INSTALLER_TIMEOUT_MS: number
  createElectronInstaller(options: Record<string, unknown>): {
    install(input: { file: string; plan: 'app' | 'host'; version: string }): Promise<void>
  }
  unsupportedReason(input: {
    packaged: boolean
    platform: string
    source: { feedUrl: string | null; publicKey: string | null; signed: boolean }
  }): string | undefined
}
interface MenuModule {
  menuTemplate(input: { packaged: boolean; onCheckForUpdates(): void }): Array<{ label: string; submenu: Array<Record<string, unknown>> }>
}

const updates = require('../src/updater.cjs') as UpdaterModule
const menus = require('../src/menu.cjs') as MenuModule

const FEED = 'https://updates.example.test/latch/feed.json'
const ORIGIN = 'https://updates.example.test'
const keys = generateKeyPairSync('ed25519')
const PUBLIC_KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const ASSET = Buffer.from('a verified update archive')
const SHA = createHash('sha512').update(ASSET).digest('hex')

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-updater-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

function release(overrides: Partial<Release> = {}): Release {
  return {
    version: '0.2.0',
    notes: { 'zh-CN': '修复了一些问题。', en: 'Fixes.' },
    minHostProtocol: 1,
    host: { version: '0.1.0', protocol: 1 },
    pluginApi: { formats: [1] },
    assets: [{ platform: 'darwin', arch: 'arm64', url: `${ORIGIN}/latch/Latch-0.2.0-arm64.zip`, sha512: SHA, size: ASSET.length }],
    publishedAt: '2026-11-12T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  }
}

function signed(value: unknown, key: KeyObject = keys.privateKey): string {
  const payload = Buffer.from(JSON.stringify(value))
  return JSON.stringify({ payload: payload.toString('base64'), sig: sign(null, payload, key).toString('base64') })
}

const verify = (text: string) =>
  updates.verifyFeed(text, { publicKey: updates.publicKeyFrom(PUBLIC_KEY), platform: 'darwin', arch: 'arm64', feedOrigin: ORIGIN })

function body(...chunks: Buffer[]): AsyncIterable<Buffer> {
  return Readable.from(chunks)
}

describe('the signed feed', () => {
  it('accepts a release signed with the fixed key for this platform and architecture', () => {
    const result = verify(signed(release()))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.release.asset).toMatchObject({ platform: 'darwin', arch: 'arm64', sha512: SHA })
  })

  it('refuses another key, a changed payload, other fields and assets it should not fetch', () => {
    const other = generateKeyPairSync('ed25519').privateKey
    expect(verify(signed(release(), other))).toEqual({ ok: false, code: 'signature' })
    const document = JSON.parse(signed(release())) as { payload: string; sig: string }
    const changed = Buffer.from(JSON.stringify({ ...release(), version: '9.9.9' })).toString('base64')
    expect(verify(JSON.stringify({ ...document, payload: changed }))).toEqual({ ok: false, code: 'signature' })
    expect(verify(JSON.stringify({ ...document, extra: 1 }))).toEqual({ ok: false, code: 'feed-format' })
    expect(verify('not json')).toEqual({ ok: false, code: 'feed-format' })
    expect(verify(signed({ ...release(), url: FEED }))).toEqual({ ok: false, code: 'feed-format' })
    expect(verify(signed(release({ version: '0.2.0-beta.1' })))).toEqual({ ok: false, code: 'feed-format' })
    const asset = release().assets[0]!
    expect(verify(signed(release({ assets: [{ ...asset, arch: 'x64' }] })))).toEqual({ ok: false, code: 'no-asset' })
    expect(verify(signed(release({ assets: [{ ...asset, url: 'https://elsewhere.test/Latch.zip' }] })))).toEqual({
      ok: false,
      code: 'asset-url',
    })
    expect(verify(signed(release({ assets: [{ ...asset, url: 'http://updates.example.test/Latch.zip' }] })))).toEqual({
      ok: false,
      code: 'asset-url',
    })
    expect(verify(signed(release({ assets: [{ ...asset, sha512: 'abc' }] })))).toEqual({ ok: false, code: 'feed-format' })
  })

  it('refuses a feed past its own expiry, so an old signed feed cannot be replayed forever', () => {
    expect(verify(signed(release({ expiresAt: '2026-01-01T00:00:00.000Z' })))).toEqual({ ok: false, code: 'feed-expired' })
    const { expiresAt: _expiresAt, ...withoutExpiry } = release()
    expect(verify(signed(withoutExpiry))).toEqual({ ok: false, code: 'feed-format' })
  })

  it('keeps release notes plain text', () => {
    const result = verify(signed(release({ notes: { 'zh-CN': '说明‮\u0007', en: 'Notes\u0000\nnext' } })))
    expect(result.ok && result.release.notes).toEqual({ 'zh-CN': '说明', en: 'Notes\nnext' })
  })

  it('compares stable versions only', () => {
    expect(updates.compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(updates.compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(() => updates.compareVersions('1.0', '1.0.0')).toThrow()
  })
})

describe('downloads', () => {
  async function source(get: Get) {
    const cacheDir = join(await directory(), 'updates')
    return {
      cacheDir,
      feed: updates.createFeedSource({ feedUrl: FEED, publicKey: PUBLIC_KEY, platform: 'darwin', arch: 'arm64', cacheDir, get }),
    }
  }

  it('keeps a verified file only, private to this user', async () => {
    const { cacheDir, feed } = await source(async url =>
      url === FEED
        ? { status: 200, body: body(Buffer.from(signed(release()))) }
        : { status: 200, body: body(ASSET.subarray(0, 5), ASSET.subarray(5)) },
    )
    const latest = await feed.latest()
    const progress: number[] = []
    const { file } = await feed.download(latest, { onProgress: received => progress.push(received) })
    expect(await readFile(file)).toEqual(ASSET)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(progress.at(-1)).toBe(ASSET.length)
    expect(await readdir(cacheDir)).toEqual(['Latch-0.2.0-darwin-arm64.zip'])
  })

  it('refuses a file whose hash or size does not match and leaves nothing behind', async () => {
    const tampered = Buffer.from(ASSET)
    tampered[0] = tampered[0]! ^ 1
    const { cacheDir, feed } = await source(async url =>
      url === FEED ? { status: 200, body: body(Buffer.from(signed(release()))) } : { status: 200, body: body(tampered) },
    )
    const latest = await feed.latest()
    await expect(feed.download(latest, { onProgress: () => {} })).rejects.toMatchObject({ stage: 'verify', code: 'hash-mismatch' })
    expect(await readdir(cacheDir)).toEqual([])

    const long = await source(async url =>
      url === FEED ? { status: 200, body: body(Buffer.from(signed(release()))) } : { status: 200, body: body(ASSET, Buffer.from('more')) },
    )
    await expect(long.feed.download(await long.feed.latest(), { onProgress: () => {} })).rejects.toMatchObject({
      stage: 'verify',
      code: 'size-mismatch',
    })
    expect(await readdir(long.cacheDir)).toEqual([])
  })

  it('says a download was interrupted', async () => {
    async function* broken() {
      yield ASSET.subarray(0, 4)
      throw new Error('socket hang up')
    }
    const { cacheDir, feed } = await source(async url =>
      url === FEED ? { status: 200, body: body(Buffer.from(signed(release()))) } : { status: 200, body: broken() },
    )
    await expect(feed.download(await feed.latest(), { onProgress: () => {} })).rejects.toMatchObject({
      stage: 'download',
      code: 'interrupted',
    })
    expect(await readdir(cacheDir)).toEqual([])
  })

  it('reports a feed it cannot reach or trust as a failed check', async () => {
    const offline = await source(async () => {
      throw new Error('ENOTFOUND')
    })
    await expect(offline.feed.latest()).rejects.toMatchObject({ stage: 'check', code: 'offline' })
    const missing = await source(async () => ({ status: 404, body: body() }))
    await expect(missing.feed.latest()).rejects.toMatchObject({ stage: 'check', code: 'http-404' })
    const forged = await source(async () => ({
      status: 200,
      body: body(Buffer.from(signed(release(), generateKeyPairSync('ed25519').privateKey))),
    }))
    await expect(forged.feed.latest()).rejects.toMatchObject({ stage: 'check', code: 'signature' })
  })
})

/** Timers the test runs by hand. */
function clock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimer: (id: number | undefined) => {
      if (id !== undefined) timers.delete(id)
    },
    pending: () => [...timers.values()].map(timer => timer.at - now),
    async advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.run()
        }
      }
      await flush()
    },
  }
}

const flush = () => new Promise(done => setTimeout(done, 0))

function hostStatus(overrides: Partial<Omit<HostStatus, 'busy'>> & { busy?: Partial<HostStatus['busy']> } = {}): HostStatus {
  const { busy, ...rest } = overrides
  return {
    open: false,
    version: '0.1.0',
    protocol: 1,
    plugins: [],
    held: [],
    ...rest,
    busy: { running: 0, waiting: 0, unknown: 0, queued: 0, terminals: 0, services: 0, ...busy },
  }
}

function fixture(
  options: {
    latest?: () => Promise<unknown>
    autoDownload?: boolean
    host?: () => HostStatus
    download?: () => Promise<{ file: string }>
    /** The window could not be entered (no credential, an older Host, an error). */
    noWindow?: boolean
  } = {},
) {
  const time = clock()
  const latest = vi.fn(options.latest ?? (async () => ({ ...release(), asset: release().assets[0] })))
  const download = vi.fn(options.download ?? (async () => ({ file: '/cache/Latch.zip' })))
  const installs: Array<{ file: string; plan: string; version: string }> = []
  const install = vi.fn(async (input: { file: string; plan: string; version: string }) => {
    installs.push(input)
  })
  let host = options.host ?? (() => hostStatus())
  const window: string[] = []
  let commitAnswer: 'committed' | 'busy' | 'unavailable' = 'committed'
  const gate = {
    status: vi.fn(async () => host()),
    enter: vi.fn(async (formats: number[], version: string) => {
      window.push(`enter:${formats.join(',')}@${version}`)
      return options.noWindow ? undefined : host()
    }),
    commit: vi.fn(async () => {
      window.push(`commit:${commitAnswer}`)
      return commitAnswer
    }),
    leave: vi.fn(async (reason: string) => {
      window.push(`leave:${reason}`)
    }),
  }
  const saved: unknown[] = []
  const views: View[] = []
  const updater = updates.createUpdater({
    appVersion: '0.1.0',
    platform: 'darwin',
    source: { latest, download, sweep: async () => {} },
    installer: { install },
    gate,
    preferences: { autoDownload: options.autoDownload ?? true },
    savePreferences: async (value: unknown) => {
      saved.push(value)
    },
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onChange: (view: View) => views.push(view),
  })
  return {
    updater,
    time,
    latest,
    download,
    install,
    installs,
    gate,
    window,
    saved,
    views,
    setHost(next: () => HostStatus) {
      host = next
    },
    setCommit(answer: typeof commitAnswer) {
      commitAnswer = answer
    },
  }
}

describe('the updater', () => {
  it('merges background and manual checks into one request', async () => {
    let finish!: () => void
    const f = fixture({
      autoDownload: false,
      latest: () =>
        new Promise(done => {
          finish = () => done({ ...release(), asset: release().assets[0] })
        }),
    })
    const first = f.updater.check()
    const second = f.updater.check()
    expect(f.updater.view().state).toBe('checking')
    finish()
    expect((await first).state).toBe('available')
    expect(await second).toEqual(await first)
    expect(f.latest).toHaveBeenCalledTimes(1)
    expect(f.views.map(view => view.state)).toEqual(['checking', 'available'])
  })

  it('is up to date with the same or an older version and never offers a downgrade', async () => {
    const same = fixture({ latest: async () => ({ ...release({ version: '0.1.0' }), asset: release().assets[0] }) })
    expect((await same.updater.check()).state).toBe('up-to-date')
    const older = fixture({ latest: async () => ({ ...release({ version: '0.0.9' }), asset: release().assets[0] }) })
    const view = await older.updater.check()
    expect(view.state).toBe('up-to-date')
    expect(view.release).toBeUndefined()
  })

  it('downloads by itself when the preference is on, and only on request when off', async () => {
    const auto = fixture()
    await auto.updater.check()
    await vi.waitFor(() => expect(auto.updater.view().state).toBe('ready'))
    expect(auto.download).toHaveBeenCalledTimes(1)

    const manual = fixture({ autoDownload: false })
    await manual.updater.check()
    expect(manual.updater.view().state).toBe('available')
    expect(manual.download).not.toHaveBeenCalled()
    const [a, b] = await Promise.all([manual.updater.download(), manual.updater.download()])
    expect(a.state).toBe('ready')
    expect(b.state).toBe('ready')
    expect(manual.download).toHaveBeenCalledTimes(1)
    // A check while ready changes nothing.
    await manual.updater.check()
    expect(manual.latest).toHaveBeenCalledTimes(1)
  })

  it('keeps the current version working after a failed check or download, and retries', async () => {
    let attempts = 0
    const f = fixture({
      autoDownload: false,
      download: async () => {
        attempts++
        if (attempts === 1) throw new updates.UpdateError('download', 'interrupted')
        return { file: '/cache/Latch.zip' }
      },
    })
    await f.updater.check()
    expect((await f.updater.download()).failure).toEqual({ stage: 'download', code: 'interrupted' })
    expect((await f.updater.download()).state).toBe('ready')

    const offline = fixture({
      latest: async () => {
        throw new updates.UpdateError('check', 'offline')
      },
    })
    expect((await offline.updater.check()).failure).toEqual({ stage: 'check', code: 'offline' })
    expect(offline.install).not.toHaveBeenCalled()
  })

  it('persists the auto-download preference through main', async () => {
    const f = fixture({ autoDownload: false })
    await f.updater.check()
    await f.updater.setAutoDownload(true)
    expect(f.saved).toEqual([{ autoDownload: true }])
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
  })

  it('checks ten minutes after start, then every six hours, and after a long sleep', async () => {
    const f = fixture({ autoDownload: false, latest: async () => ({ ...release({ version: '0.1.0' }), asset: release().assets[0] }) })
    f.updater.start()
    await f.time.advance(updates.FIRST_CHECK_MS - 1)
    expect(f.latest).toHaveBeenCalledTimes(0)
    await f.time.advance(1)
    expect(f.latest).toHaveBeenCalledTimes(1)
    await f.time.advance(updates.CHECK_EVERY_MS)
    expect(f.latest).toHaveBeenCalledTimes(2)
    f.updater.resume()
    await flush()
    expect(f.latest).toHaveBeenCalledTimes(2)
    await f.time.advance(updates.CHECK_EVERY_MS - 1)
    f.updater.resume()
    await flush()
    expect(f.latest).toHaveBeenCalledTimes(2)
    f.updater.stop()
  })
})

describe('the install gate', () => {
  it('restarts only the App when the bundled Host is the running one', async () => {
    const f = fixture()
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    expect(f.updater.view().release?.plan).toBe('app')
    f.setHost(() => hostStatus({ busy: { running: 2, waiting: 0, unknown: 0 } }))
    await f.updater.install()
    expect(f.installs).toEqual([{ file: '/cache/Latch.zip', plan: 'app', version: '0.2.0' }])
    expect(f.window).toEqual([])
  })

  it('waits for sessions in the Host’s install window when the Host changes, and installs once they settle', async () => {
    let busy: Partial<HostStatus['busy']> = { running: 1, waiting: 1, unknown: 1 }
    const f = fixture({
      latest: async () => ({ ...release({ host: { version: '0.2.0', protocol: 2 }, minHostProtocol: 2 }), asset: release().assets[0] }),
      host: () => hostStatus({ busy }),
    })
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    expect(f.updater.view().release?.plan).toBe('host')
    const installing = f.updater.install()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('waiting'))
    expect(f.updater.view().waiting).toEqual({ count: 3, running: 1, waiting: 1, unknown: 1, queued: 0, terminals: 0, services: 0 })
    expect(f.install).not.toHaveBeenCalled()
    // Queued messages and terminals running a command hold it too; local services alone do not.
    busy = { queued: 1, terminals: 1, services: 3 }
    await f.time.advance(updates.WAIT_POLL_MS)
    expect(f.updater.view().waiting?.count).toBe(2)
    // Nothing busy at the poll, but something started before the Host's last word: it waits again.
    busy = { services: 3 }
    f.setCommit('busy')
    await f.time.advance(updates.WAIT_POLL_MS)
    expect(f.install).not.toHaveBeenCalled()
    f.setCommit('committed')
    await f.time.advance(updates.WAIT_POLL_MS)
    await installing
    expect(f.installs).toEqual([{ file: '/cache/Latch.zip', plan: 'host', version: '0.2.0' }])
    expect(f.window.filter(entry => entry.startsWith('enter:')).every(entry => entry === 'enter:1@0.2.0')).toBe(true)
    expect(f.window).toContain('commit:busy')
    expect(f.window.at(-1)).toBe('commit:committed')
  })

  it('leaves the window when the wait is cancelled, and when the install fails', async () => {
    const f = fixture({
      latest: async () => ({ ...release({ host: { version: '0.2.0', protocol: 1 } }), asset: release().assets[0] }),
      host: () => hostStatus({ busy: { running: 1, waiting: 0, unknown: 0 } }),
    })
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    const installing = f.updater.install()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('waiting'))
    expect((await f.updater.cancelWaiting()).state).toBe('ready')
    await installing
    expect(f.window.at(-1)).toBe('leave:cancelled')
    expect(f.install).not.toHaveBeenCalled()

    f.setHost(() => hostStatus())
    f.install.mockRejectedValueOnce(new updates.UpdateError('install', 'installer-failed'))
    const failed = await f.updater.install()
    expect(failed.failure).toEqual({ stage: 'install', code: 'installer-failed' })
    expect(f.window.at(-1)).toBe('leave:failed')
    // Retrying the install is allowed from there.
    expect((await f.updater.install()).state).toBe('installing')
  })

  it('lists plugins the coming version will turn off and treats that as a Host change', async () => {
    const f = fixture({
      latest: async () => ({ ...release({ pluginApi: { formats: [2] } }), asset: release().assets[0] }),
      host: () =>
        hostStatus({
          plugins: [
            { id: 'old', name: 'Old', formatVersion: 1, enabled: true },
            { id: 'off', name: 'Off', formatVersion: 1, enabled: false },
          ],
          held: [{ id: 'earlier', name: 'Earlier' }],
        }),
    })
    const view = await f.updater.check()
    expect(view.release?.incompatiblePlugins).toEqual([{ id: 'old', name: 'Old' }])
    expect(view.release?.plan).toBe('host')
    expect(view.heldPlugins).toEqual([{ id: 'earlier', name: 'Earlier' }])
  })

  it('applies the same gate to a quit the user starts, and never holds the system’s', async () => {
    const f = fixture({ latest: async () => ({ ...release({ host: { version: '0.2.0', protocol: 1 } }), asset: release().assets[0] }) })
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    expect(f.updater.holdsQuit({ system: false })).toBe(false)
    await f.updater.install('at-quit')
    expect(f.updater.view().installAtQuit).toBe(true)
    expect(f.updater.holdsQuit({ system: true })).toBe(false)
    expect(f.updater.holdsQuit({ system: false })).toBe(true)
    // Busy: the quit goes on without installing; the update stays ready for next time.
    f.setHost(() => hostStatus({ busy: { running: 0, waiting: 1, unknown: 0 } }))
    expect(await f.updater.quitting()).toBe(false)
    expect(f.install).not.toHaveBeenCalled()
    expect(f.updater.view().state).toBe('ready')
    // Idle: it enters the window and installs.
    f.setHost(() => hostStatus())
    expect(await f.updater.quitting()).toBe(true)
    expect(f.installs.map(item => item.plan)).toEqual(['host'])
    expect(f.window).toEqual(['enter:1@0.2.0', 'commit:committed'])
  })

  it('never installs a Host change without the Host’s window', async () => {
    const f = fixture({
      latest: async () => ({ ...release({ host: { version: '0.2.0', protocol: 1 } }), asset: release().assets[0] }),
      noWindow: true,
    })
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    expect((await f.updater.install()).failure).toEqual({ stage: 'gate', code: 'window-unavailable' })
    expect(f.install).not.toHaveBeenCalled()
    // At quit too: the quit goes on and nothing is installed.
    const at = fixture({ latest: f.latest.getMockImplementation()!, noWindow: true })
    await at.updater.check()
    await vi.waitFor(() => expect(at.updater.view().state).toBe('ready'))
    await at.updater.install('at-quit')
    expect(await at.updater.quitting()).toBe(false)
    expect(at.install).not.toHaveBeenCalled()
    // A commit the Host cannot give fails the same way.
    const unavailable = fixture({ latest: f.latest.getMockImplementation()! })
    unavailable.setCommit('unavailable')
    await unavailable.updater.check()
    await vi.waitFor(() => expect(unavailable.updater.view().state).toBe('ready'))
    expect((await unavailable.updater.install()).failure).toEqual({ stage: 'gate', code: 'window-unavailable' })
    expect(unavailable.window.at(-1)).toBe('leave:failed')
  })

  it('does not install when the wait is cancelled while the Host commits, and leaves the window again', async () => {
    let busy: Partial<HostStatus['busy']> = { running: 1 }
    const f = fixture({
      latest: async () => ({ ...release({ host: { version: '0.2.0', protocol: 1 } }), asset: release().assets[0] }),
      host: () => hostStatus({ busy }),
    })
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    const installing = f.updater.install()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('waiting'))
    let commit!: () => void
    f.gate.commit.mockImplementationOnce(
      () =>
        new Promise(done => {
          commit = () => done('committed')
        }),
    )
    busy = {}
    await f.time.advance(updates.WAIT_POLL_MS)
    await vi.waitFor(() => expect(f.gate.commit).toHaveBeenCalled())
    await f.updater.cancelWaiting()
    commit()
    await installing
    await flush()
    expect(f.install).not.toHaveBeenCalled()
    expect(f.window.at(-1)).toBe('leave:cancelled')
    expect(f.updater.view().state).toBe('ready')
  })

  it('runs one install at a time', async () => {
    const f = fixture({
      latest: async () => ({ ...release({ host: { version: '0.2.0', protocol: 1 } }), asset: release().assets[0] }),
      host: () => hostStatus({ busy: { running: 1 } }),
    })
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    const first = f.updater.install()
    const second = await f.updater.install()
    expect(second.state).toBe('ready')
    await vi.waitFor(() => expect(f.updater.view().state).toBe('waiting'))
    expect(f.gate.enter).toHaveBeenCalledTimes(1)
    expect(f.window).not.toContain('leave:cancelled')
    await f.updater.cancelWaiting()
    await first
  })

  it('does not touch the Host’s window at start when this build cannot update', async () => {
    const leave = vi.fn(async () => {})
    const updater = updates.createUpdater({
      appVersion: '0.1.0',
      unsupported: 'development',
      preferences: { autoDownload: true },
      gate: { status: async () => undefined, enter: async () => undefined, commit: async () => 'unavailable', leave },
    })
    updater.start()
    await flush()
    expect(leave).not.toHaveBeenCalled()
  })

  it('leaves a window an earlier run of the app left open when it starts', async () => {
    const f = fixture({ autoDownload: false })
    f.updater.start()
    await flush()
    expect(f.window[0]).toBe('leave:cancelled')
    f.updater.stop()
  })

  it('leaves the window again when the wait was cancelled while entering it', async () => {
    let enter!: () => void
    const f = fixture({
      latest: async () => ({ ...release({ host: { version: '0.2.0', protocol: 1 } }), asset: release().assets[0] }),
      host: () => hostStatus({ busy: { running: 1 } }),
    })
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    const installing = f.updater.install()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('waiting'))
    f.gate.enter.mockImplementationOnce(
      () =>
        new Promise(done => {
          enter = () => done(hostStatus({ busy: { running: 1 } }))
        }),
    )
    await f.time.advance(updates.WAIT_POLL_MS)
    await f.updater.cancelWaiting()
    enter()
    await installing
    await flush()
    expect(f.window.slice(-1)).toEqual(['leave:cancelled'])
    expect(f.window.filter(entry => entry === 'leave:cancelled')).toHaveLength(2)
  })

  it('gives up a waiting install when the user quits', async () => {
    const f = fixture({
      latest: async () => ({ ...release({ host: { version: '0.2.0', protocol: 1 } }), asset: release().assets[0] }),
      host: () => hostStatus({ busy: { running: 1, waiting: 0, unknown: 0 } }),
    })
    await f.updater.check()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('ready'))
    void f.updater.install()
    await vi.waitFor(() => expect(f.updater.view().state).toBe('waiting'))
    expect(f.updater.holdsQuit({ system: false })).toBe(true)
    expect(await f.updater.quitting()).toBe(false)
    expect(f.window.at(-1)).toBe('leave:cancelled')
  })
})

describe('plans and Host answers', () => {
  it('needs the same Host version and protocol, and a protocol the new App speaks', () => {
    expect(updates.planFor(release(), hostStatus())).toBe('app')
    expect(updates.planFor(release(), hostStatus({ version: '0.1.1' }))).toBe('host')
    expect(updates.planFor(release({ minHostProtocol: 2 }), hostStatus())).toBe('host')
    expect(updates.planFor(release(), undefined)).toBe('host')
  })

  it('reads only well-formed Host answers', () => {
    const answer = {
      window: { open: false },
      version: '0.1.0',
      protocol: 1,
      busy: { running: 0, waiting: 0, unknown: 0 },
      plugins: [],
      held: [],
    }
    expect(updates.parseHostStatus(answer)).toMatchObject({ protocol: 1 })
    expect(updates.parseHostStatus({ ...answer, busy: { running: -1, waiting: 0, unknown: 0 } })).toBeUndefined()
    expect(updates.parseHostStatus({ ...answer, plugins: [{ id: '../x', name: 'x' }] })).toBeUndefined()
  })

  it('is unsupported in a development run, without a feed, unsigned or on another system', () => {
    const source = { feedUrl: FEED, publicKey: PUBLIC_KEY, signed: true }
    expect(updates.unsupportedReason({ packaged: false, platform: 'darwin', source })).toBe('development')
    expect(updates.unsupportedReason({ packaged: true, platform: 'linux', source })).toBe('platform')
    expect(updates.unsupportedReason({ packaged: true, platform: 'darwin', source: { ...source, feedUrl: null } })).toBe('not-configured')
    expect(updates.unsupportedReason({ packaged: true, platform: 'darwin', source: { ...source, signed: false } })).toBe('unsigned')
    expect(updates.unsupportedReason({ packaged: true, platform: 'darwin', source })).toBeUndefined()
    const view = updates.createUpdater({ appVersion: '0.1.0', unsupported: 'development', preferences: { autoDownload: true } }).view()
    expect(view).toMatchObject({ state: 'unsupported', reason: 'development' })
  })
})

describe('preferences and the menu', () => {
  it('keeps the auto-download preference in a private file, on by default', async () => {
    const dir = await directory()
    expect(await updates.readUpdatePreferences(dir)).toEqual({ autoDownload: true })
    await updates.writeUpdatePreferences(dir, { autoDownload: false })
    expect(await updates.readUpdatePreferences(dir)).toEqual({ autoDownload: false })
    expect((await stat(join(dir, 'updates.json'))).mode & 0o777).toBe(0o600)
    await writeFile(join(dir, 'updates.json'), '{"version":1,"autoDownload":"no"}', { mode: 0o600 })
    expect(await updates.readUpdatePreferences(dir)).toEqual({ autoDownload: true })
  })

  it('puts 「检查更新…」 in the app menu, and the developer tools only in a development run', () => {
    let checked = 0
    const packaged = menus.menuTemplate({ packaged: true, onCheckForUpdates: () => checked++ })
    const item = packaged[0]!.submenu.find(entry => entry.id === 'check-for-updates') as { label: string; click(): void }
    expect(item.label).toBe('检查更新…')
    item.click()
    expect(checked).toBe(1)
    expect(JSON.stringify(packaged)).not.toContain('toggleDevTools')
    expect(JSON.stringify(menus.menuTemplate({ packaged: false, onCheckForUpdates: () => {} }))).toContain('toggleDevTools')
  })
})

describe('the Electron installer', () => {
  /** autoUpdater as Squirrel.Mac drives it, answering a check with the event the test names. */
  function fakeUpdater(answer: 'update-downloaded' | 'update-not-available' | 'error' | 'nothing') {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const calls: string[] = []
    const autoUpdater = {
      once(event: string, listener: (...args: unknown[]) => void) {
        const set = listeners.get(event) ?? new Set()
        set.add(listener)
        listeners.set(event, set)
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(listener)
      },
      setFeedURL(options: Record<string, unknown>) {
        calls.push(`feed:${JSON.stringify(options)}`)
      },
      checkForUpdates() {
        calls.push('check')
        if (answer !== 'nothing') for (const listener of listeners.get(answer) ?? []) listener(new Error('fixture'))
      },
      quitAndInstall() {
        calls.push('quit')
      },
    }
    return { autoUpdater, calls, listening: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0) }
  }

  function installer(answer: Parameters<typeof fakeUpdater>[0], options: { serve?: () => Promise<{ url: string; close(): void }> } = {}) {
    const fake = fakeUpdater(answer)
    const time = clock()
    const host: string[] = []
    let closed = 0
    const value = updates.createElectronInstaller({
      autoUpdater: fake.autoUpdater,
      stopHost: async () => {
        host.push('stop')
        return { ok: true }
      },
      restartHost: async () => {
        host.push('restart')
      },
      serve:
        options.serve
        ?? (async () => ({
          url: 'http://127.0.0.1:1/token/feed.json',
          close: () => {
            closed++
          },
        })),
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    })
    return { value, fake, time, host, closed: () => closed }
  }

  it('hands Squirrel the file in its default feed format and installs once it has it', async () => {
    const f = installer('update-downloaded')
    await f.value.install({ file: '/cache/Latch.zip', plan: 'host', version: '0.2.0' })
    expect(f.fake.calls).toEqual(['feed:{"url":"http://127.0.0.1:1/token/feed.json"}', 'check', 'quit'])
    expect(f.host).toEqual(['stop'])
    expect(f.closed()).toBe(1)
    expect(f.fake.listening()).toBe(0)
  })

  it('fails and starts the Host again when Squirrel finds nothing, errs, takes too long or the file cannot be served', async () => {
    for (const [answer, code] of [
      ['update-not-available', 'installer-refused'],
      ['error', 'installer-failed'],
    ] as const) {
      const f = installer(answer)
      await expect(f.value.install({ file: '/cache/Latch.zip', plan: 'host', version: '0.2.0' })).rejects.toMatchObject({
        stage: 'install',
        code,
      })
      expect(f.host).toEqual(['stop', 'restart'])
      expect(f.fake.calls).not.toContain('quit')
      expect(f.closed()).toBe(1)
    }
    const slow = installer('nothing')
    const pending = slow.value.install({ file: '/cache/Latch.zip', plan: 'host', version: '0.2.0' })
    const outcome = expect(pending).rejects.toMatchObject({ stage: 'install', code: 'installer-timeout' })
    await flush()
    await slow.time.advance(updates.INSTALLER_TIMEOUT_MS)
    await outcome
    expect(slow.host).toEqual(['stop', 'restart'])
    const unserved = installer('update-downloaded', {
      serve: async () => {
        throw new Error('EADDRINUSE')
      },
    })
    await expect(unserved.value.install({ file: '/cache/Latch.zip', plan: 'host', version: '0.2.0' })).rejects.toMatchObject({
      stage: 'install',
      code: 'installer-failed',
    })
    expect(unserved.host).toEqual(['stop', 'restart'])
    // A Host that did not stop in time is started again too, and the install fails with that reason.
    const fake = fakeUpdater('update-downloaded')
    const host: string[] = []
    const stuck = updates.createElectronInstaller({
      autoUpdater: fake.autoUpdater,
      stopHost: async () => {
        host.push('stop')
        return { ok: false, error: 'host-stop-timeout' }
      },
      restartHost: async () => {
        host.push('restart')
      },
      serve: async () => ({ url: 'http://127.0.0.1:1/token/feed.json', close: () => {} }),
    })
    await expect(stuck.install({ file: '/cache/Latch.zip', plan: 'host', version: '0.2.0' })).rejects.toMatchObject({
      stage: 'install',
      code: 'host-stop-timeout',
    })
    expect(host).toEqual(['stop', 'restart'])
    expect(fake.calls).toEqual([])
    // An App-only install never stops or starts the Host.
    const app = installer('error')
    await expect(app.value.install({ file: '/cache/Latch.zip', plan: 'app', version: '0.2.0' })).rejects.toMatchObject({ stage: 'install' })
    expect(app.host).toEqual([])
  })
})
