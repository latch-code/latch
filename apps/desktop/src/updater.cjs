'use strict'
// The desktop app's own updates. Main checks one fixed HTTPS feed compiled into a packaged build,
// verifies its ed25519 signature with a fixed public key, downloads the asset for this platform and architecture to its
// own cache and checks size and SHA-512 before anything can install it. Installing goes through the same gate for the
// explicit button, a normal quit and macOS quitting the app: an update that changes the Host waits until no session on
// this Mac's Host runs, waits for an approval or has a write whose outcome is unknown, with the Host refusing new starts
// meanwhile. The page only sees the view below: never a URL, a path or a key.
const { createHash, createPublicKey, randomUUID, verify: verifySignature } = require('node:crypto')
const { constants } = require('node:fs')
const { mkdir, open, readdir, rename, unlink } = require('node:fs/promises')
const { request: httpsRequest } = require('node:https')
const { join } = require('node:path')
const { readOwnFile, writePrivateFile } = require('./lifecycle.cjs')
const SOURCE = require('./update-source.cjs')

/** Main to renderer: the view changed, or 「检查更新…」 asked the page to show the update area. Others are requests. */
const UPDATE_CHANNELS = Object.freeze({
  get: 'latch:updates',
  check: 'latch:updates:check',
  download: 'latch:updates:download',
  install: 'latch:updates:install',
  cancelWaiting: 'latch:updates:cancel-waiting',
  setAutoDownload: 'latch:updates:auto-download',
  changed: 'latch:updates:changed',
  show: 'latch:updates:show',
})

/** The first background check after start, then one every six hours; a wake after longer checks at once. */
const FIRST_CHECK_MS = 10 * 60_000
const CHECK_EVERY_MS = 6 * 60 * 60_000
/** While an install waits for sessions, the Host is asked again (and its install window renewed) this often. */
const WAIT_POLL_MS = 2_000
const FEED_LIMIT = 256 * 1024
const NOTES_LIMIT = 4_000
const ASSET_LIMIT = 2 * 1024 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const PROGRESS_EVERY_MS = 250
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const PLATFORMS = new Set(['darwin', 'win32', 'linux'])
const ARCHS = new Set(['arm64', 'x64'])
const SHA512 = /^[0-9a-f]{128}$/
const PLUGIN_ID = /^[A-Za-z0-9_-]{1,64}$/

class UpdateError extends Error {
  /** @param {'check' | 'download' | 'verify' | 'install' | 'gate'} stage @param {string} code */
  constructor(stage, code) {
    super(`${stage}: ${code}`)
    this.stage = stage
    this.code = code
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false
  const keys = Object.keys(value)
  return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key))
}

/** A stable release version `major.minor.patch`; pre-releases are never offered (no silent switch to a preview channel). */
function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION.exec(text) : null
  return match ? match.slice(1, 4).map(Number) : undefined
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) throw new TypeError('Invalid version')
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}

/** Release notes as plain text: no control characters but line breaks, at most 4000 characters. */
function cleanNotes(value) {
  if (typeof value !== 'string' || value.length > NOTES_LIMIT) return undefined
  return value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, '')
}

/** The fixed public key: base64 SPKI DER of an Ed25519 key. */
function publicKeyFrom(base64) {
  const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('The update key must be Ed25519')
  return key
}

/**
 * The signed feed: `{ payload, sig }`, both base64; the signature is Ed25519 over the payload's bytes, which are the
 * release as JSON. Every field is checked; the asset must be for this platform and architecture and come from the feed's
 * own origin over HTTPS. Returns `{ ok: true, release }` or `{ ok: false, code }`.
 */
function verifyFeed(text, { publicKey, platform, arch, feedOrigin, now = Date.now() }) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return { ok: false, code: 'feed-format' }
  }
  if (!exactKeys(document, ['payload', 'sig']) || typeof document.payload !== 'string' || typeof document.sig !== 'string')
    return { ok: false, code: 'feed-format' }
  const payload = Buffer.from(document.payload, 'base64')
  const signature = Buffer.from(document.sig, 'base64')
  let signed = false
  try {
    signed = signature.length === 64 && verifySignature(null, payload, publicKey, signature)
  } catch {
    signed = false
  }
  if (!signed) return { ok: false, code: 'signature' }
  let value
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    return { ok: false, code: 'feed-format' }
  }
  const release = parseRelease(value)
  if (!release) return { ok: false, code: 'feed-format' }
  // A signed feed is good until its own expiry, so an old one replayed by the host cannot hold updates back forever.
  if (Date.parse(release.expiresAt) <= now) return { ok: false, code: 'feed-expired' }
  const asset = release.assets.find(item => item.platform === platform && item.arch === arch)
  if (!asset) return { ok: false, code: 'no-asset' }
  let url
  try {
    url = new URL(asset.url)
  } catch {
    return { ok: false, code: 'asset-url' }
  }
  if (url.protocol !== 'https:' || url.origin !== feedOrigin || url.username || url.password) return { ok: false, code: 'asset-url' }
  return { ok: true, release: { ...release, asset } }
}

function parseRelease(value) {
  if (!exactKeys(value, ['version', 'notes', 'minHostProtocol', 'host', 'pluginApi', 'assets', 'publishedAt', 'expiresAt']))
    return undefined
  if (!parseVersion(value.version) || typeof value.publishedAt !== 'string' || Number.isNaN(Date.parse(value.publishedAt))) return undefined
  if (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt))) return undefined
  if (!exactKeys(value.notes, ['zh-CN', 'en'])) return undefined
  const notes = { 'zh-CN': cleanNotes(value.notes['zh-CN']), en: cleanNotes(value.notes.en) }
  if (notes['zh-CN'] === undefined || notes.en === undefined) return undefined
  const positive = item => Number.isInteger(item) && item > 0 && item <= 1000
  if (!positive(value.minHostProtocol)) return undefined
  if (!exactKeys(value.host, ['version', 'protocol']) || !parseVersion(value.host.version) || !positive(value.host.protocol))
    return undefined
  if (!exactKeys(value.pluginApi, ['formats']) || !Array.isArray(value.pluginApi.formats)) return undefined
  const formats = value.pluginApi.formats
  if (formats.length === 0 || formats.length > 16 || !formats.every(positive)) return undefined
  if (!Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 16) return undefined
  const assets = []
  for (const item of value.assets) {
    if (!exactKeys(item, ['platform', 'arch', 'url', 'sha512', 'size'])) return undefined
    if (!PLATFORMS.has(item.platform) || !ARCHS.has(item.arch) || typeof item.url !== 'string' || item.url.length > 2048) return undefined
    if (typeof item.sha512 !== 'string' || !SHA512.test(item.sha512)) return undefined
    if (!Number.isInteger(item.size) || item.size <= 0 || item.size > ASSET_LIMIT) return undefined
    assets.push({ platform: item.platform, arch: item.arch, url: item.url, sha512: item.sha512, size: item.size })
  }
  return {
    version: value.version,
    publishedAt: new Date(value.publishedAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(),
    notes,
    minHostProtocol: value.minHostProtocol,
    host: { version: value.host.version, protocol: value.host.protocol },
    pluginApi: { formats: [...formats] },
    assets,
  }
}

/**
 * One HTTPS GET with Node's own TLS (the app session's network is shut; see network.cjs): no redirects, no credentials.
 * Resolves `{ status, body }` with the body as an async iterable of chunks. `ca` exists for the end-to-end test's
 * local feed only; a packaged build passes none.
 */
/**
 * @param {string} url
 * @param {{ signal?: AbortSignal, ca?: string }} [options]
 * @returns {Promise<{ status: number, body: AsyncIterable<Buffer> & { resume?: () => void } }>}
 */
function httpsGet(url, { signal, ca } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    if (target.protocol !== 'https:') {
      reject(new Error('Only HTTPS'))
      return
    }
    const req = httpsRequest(
      target,
      {
        method: 'GET',
        headers: { accept: 'application/json, application/octet-stream' },
        signal,
        timeout: REQUEST_TIMEOUT_MS,
        ...(ca ? { ca } : {}),
      },
      response => resolve({ status: response.statusCode ?? 0, body: response }),
    )
    req.once('timeout', () => req.destroy(new Error('timeout')))
    req.once('error', reject)
    req.end()
  })
}

async function readLimited(body, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.length
    if (size > limit) throw new Error('too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The feed and the downloads: `latest()` reads and verifies the feed; `download()` streams the asset into
 * `<cache>/<random>.partial` (0600, never through a link), checks size and SHA-512 and only then renames it. A mismatch
 * deletes the file. Nothing here installs.
 */
/**
 * @param {{ feedUrl: string, publicKey: string, platform: string, arch: string, cacheDir: string, get?: typeof httpsGet, ca?: string, now?: () => number }} options
 */
function createFeedSource({ feedUrl, publicKey, platform, arch, cacheDir, get = httpsGet, ca, now = Date.now }) {
  const feedOrigin = new URL(feedUrl).origin
  const key = publicKeyFrom(publicKey)

  async function latest() {
    let response
    try {
      response = await get(feedUrl, { ca })
    } catch {
      throw new UpdateError('check', 'offline')
    }
    if (response.status !== 200) {
      response.body.resume?.()
      throw new UpdateError('check', `http-${response.status}`)
    }
    let text
    try {
      text = await readLimited(response.body, FEED_LIMIT)
    } catch {
      throw new UpdateError('check', 'offline')
    }
    const result = verifyFeed(text, { publicKey: key, platform, arch, feedOrigin, now: now() })
    if (!result.ok || !result.release) throw new UpdateError('check', result.code ?? 'feed-format')
    return result.release
  }

  async function download(release, { onProgress, signal }) {
    const asset = release.asset
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
    const partial = join(cacheDir, `${randomUUID()}.partial`)
    const handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const hash = createHash('sha512')
    let received = 0
    let finished = false
    try {
      let response
      try {
        response = await get(asset.url, { ca, signal })
      } catch {
        throw new UpdateError('download', signal?.aborted ? 'cancelled' : 'offline')
      }
      if (response.status !== 200) {
        response.body.resume?.()
        throw new UpdateError('download', `http-${response.status}`)
      }
      try {
        for await (const chunk of response.body) {
          received += chunk.length
          if (received > asset.size) throw new UpdateError('verify', 'size-mismatch')
          hash.update(chunk)
          await handle.write(chunk)
          onProgress(received, asset.size)
        }
      } catch (error) {
        if (error instanceof UpdateError) throw error
        throw new UpdateError('download', signal?.aborted ? 'cancelled' : 'interrupted')
      }
      if (received !== asset.size) throw new UpdateError('download', 'interrupted')
      if (hash.digest('hex') !== asset.sha512) throw new UpdateError('verify', 'hash-mismatch')
      await handle.sync()
      finished = true
    } finally {
      await handle.close()
      if (!finished) await unlink(partial).catch(() => {})
    }
    const file = join(cacheDir, `Latch-${release.version}-${asset.platform}-${asset.arch}.zip`)
    await rename(partial, file)
    return { file }
  }

  /** Removes what an earlier run left: partial downloads and verified files of other versions. */
  async function sweep(keep) {
    const names = await readdir(cacheDir).catch(() => [])
    for (const name of names) if (join(cacheDir, name) !== keep) await unlink(join(cacheDir, name)).catch(() => {})
  }

  return { latest, download, sweep }
}

/** `<userData>/updates.json`: whether to download a found update by itself (on unless turned off). */
async function readUpdatePreferences(directory, options) {
  const text = await readOwnFile(join(directory, 'updates.json'), options?.uid ?? /** @type {() => number} */ (process.getuid)())
  try {
    const value = text === undefined ? undefined : JSON.parse(text)
    if (exactKeys(value, ['version', 'autoDownload']) && value.version === 1 && typeof value.autoDownload === 'boolean')
      return { autoDownload: value.autoDownload }
  } catch {
    /* default below */
  }
  return { autoDownload: true }
}

function writeUpdatePreferences(directory, preferences) {
  return writePrivateFile(
    join(directory, 'updates.json'),
    directory,
    '.updates-',
    `${JSON.stringify({ version: 1, autoDownload: preferences.autoDownload === true })}\n`,
  )
}

/**
 * What the coming version means for this Mac's Host: `app` when its bundled Host is the running one (same version and
 * protocol, and the new App speaks it), so only the App restarts and sessions are not touched; `host` otherwise, which
 * goes through the install window. A Host this app cannot read counts as `host`. A Host elsewhere is never updated.
 */
function planFor(release, host) {
  if (!host) return 'host'
  const same = host.version === release.host.version && host.protocol === release.host.protocol
  return same && host.protocol >= release.minHostProtocol ? 'app' : 'host'
}

/** What holds an install back: everything but the local services, which only end with the terminals that run them. */
const blocking = busy => busy.running + busy.waiting + busy.unknown + busy.queued + busy.terminals

/** Applied plugin packages, still on, whose format the coming version does not load. */
function incompatiblePlugins(release, host) {
  if (!host) return []
  return host.plugins
    .filter(plugin => plugin.enabled && !release.pluginApi.formats.includes(plugin.formatVersion))
    .map(plugin => ({ id: plugin.id, name: plugin.name }))
}

/** The Host's answer to GET/POST /link/api/host/update-window, reduced to what the updater uses; undefined when malformed. */
function parseHostStatus(value) {
  if (!plainObject(value) || !plainObject(value.busy) || !plainObject(value.window)) return undefined
  const count = item => Number.isInteger(item) && item >= 0
  const { running, waiting, unknown } = value.busy
  const extra = ['queued', 'terminals', 'services'].map(key => value.busy[key] ?? 0)
  if (![running, waiting, unknown, ...extra].every(count) || typeof value.window.open !== 'boolean') return undefined
  if (typeof value.version !== 'string' || !Number.isInteger(value.protocol)) return undefined
  const plugin = item =>
    plainObject(item) && typeof item.id === 'string' && PLUGIN_ID.test(item.id) && typeof item.name === 'string' && item.name.length <= 80
  if (!Array.isArray(value.plugins) || value.plugins.length > 64 || !value.plugins.every(plugin)) return undefined
  if (!Array.isArray(value.held) || value.held.length > 64 || !value.held.every(plugin)) return undefined
  return {
    open: value.window.open,
    version: value.version,
    protocol: value.protocol,
    busy: { running, waiting, unknown, queued: extra[0], terminals: extra[1], services: extra[2] },
    plugins: value.plugins.map(item => ({
      id: item.id,
      name: item.name,
      formatVersion: Number.isInteger(item.formatVersion) ? item.formatVersion : 0,
      enabled: item.enabled === true,
    })),
    held: value.held.map(item => ({ id: item.id, name: item.name })),
  }
}

/**
 * The install gate's side of the Host: main's own requests with the desktop app's credential over host.sock. Without a
 * credential (no device yet) it can only read the anonymous host-info counts and cannot hold the Host's window.
 */
function createHostGate({ request, activity }) {
  async function status() {
    const response = await request('GET', '/link/api/host/update-window').catch(() => undefined)
    const parsed = response?.status === 200 ? parseHostStatus(response.json) : undefined
    if (parsed) return { ...parsed, window: true }
    const counts = await activity().catch(() => undefined)
    if (!counts) return undefined
    return {
      open: false,
      version: counts.version,
      protocol: counts.protocol ?? 0,
      busy: { running: counts.running, waiting: counts.waiting, unknown: 0, queued: 0, terminals: 0, services: 0 },
      plugins: [],
      held: [],
      window: false,
    }
  }
  /** Enters or renews the Host's install window for `version`; undefined when the window could not be entered. */
  async function enter(pluginFormats, version) {
    const response = await request('POST', '/link/api/host/update-window', { open: true, pluginFormats, version }).catch(() => undefined)
    return response?.status === 200 ? parseHostStatus(response.json) : undefined
  }
  /**
   * The Host's last word before it is stopped: `committed` when nothing was busy and from now on nothing starts, `busy`
   * when something still works, `unavailable` otherwise.
   */
  async function commit() {
    const response = await request('POST', '/link/api/host/update-window/commit', {}).catch(() => undefined)
    if (response?.status === 200) return 'committed'
    return response?.status === 409 && response.json?.error === 'host-busy' ? 'busy' : 'unavailable'
  }
  async function leave(reason) {
    await request('POST', '/link/api/host/update-window', { open: false, reason }).catch(() => undefined)
  }
  return { status, enter, commit, leave }
}

/**
 * The updater's state machine. States: `idle` (not checked), `checking`, `up-to-date`, `available`, `downloading`,
 * `ready`, `waiting` (for sessions), `installing`, `failed` (with stage and code) and `unsupported` (with a reason).
 * Background and manual checks share one request; there is one download at a time.
 */
function createUpdater(options) {
  const {
    appVersion,
    platform,
    source,
    installer,
    gate,
    preferences,
    savePreferences,
    unsupported,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = /** @type {(text: string) => void} */ (() => {}),
    onChange = /** @type {(view: object) => void} */ (() => {}),
  } = options
  /** @type {string} */
  let state = unsupported ? 'unsupported' : 'idle'
  let release
  let plan = 'host'
  let plugins = []
  let held = []
  let file
  let progress
  let waiting
  let failure
  let checkedAt
  let installAtQuit = false
  let autoDownload = preferences.autoDownload
  let checking
  let downloading
  let downloadAbort
  let waitTimer
  let waitWake
  let schedule
  let gateRun = 0
  let gating = false

  function view() {
    return {
      state,
      appVersion,
      autoDownload,
      installAtQuit,
      ...(unsupported ? { reason: unsupported } : {}),
      ...(checkedAt ? { checkedAt: new Date(checkedAt).toISOString() } : {}),
      ...(release
        ? {
            release: {
              version: release.version,
              publishedAt: release.publishedAt,
              notes: { ...release.notes },
              size: release.asset.size,
              plan,
              incompatiblePlugins: plugins.map(item => ({ ...item })),
            },
          }
        : {}),
      ...(state === 'downloading' && progress ? { progress: { ...progress } } : {}),
      ...(state === 'waiting' && waiting ? { waiting: { ...waiting } } : {}),
      ...(state === 'failed' && failure ? { failure: { ...failure } } : {}),
      heldPlugins: held.map(item => ({ ...item })),
    }
  }

  const emit = () => onChange(view())

  function set(next, extra = {}) {
    state = next
    if (next !== 'failed') failure = undefined
    if ('failure' in extra) failure = extra.failure
    emit()
  }

  function fail(error, fallbackStage) {
    const stage = error instanceof UpdateError ? error.stage : fallbackStage
    const code = error instanceof UpdateError ? error.code : 'unexpected'
    if (!(error instanceof UpdateError)) log(`Update ${fallbackStage} failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    set('failed', { failure: { stage, code } })
  }

  async function hostStatus() {
    try {
      return await gate.status()
    } catch {
      return undefined
    }
  }

  /** Reads the Host's plugins and the ones an earlier update held off; never fails. */
  async function refreshHost(host) {
    if (host) held = host.held
    if (release) {
      plan = planFor(release, host)
      plugins = incompatiblePlugins(release, host)
      // A coming version that turns plugins off changes the Host's side whatever the versions say.
      if (plugins.length > 0) plan = 'host'
    }
  }

  /** One check at a time; a check while a download, an install or its wait is under way changes nothing. */
  function check() {
    if (state === 'unsupported' || ['downloading', 'ready', 'waiting', 'installing'].includes(state)) return Promise.resolve(view())
    checking ??= (async () => {
      set('checking')
      try {
        const latest = await source.latest()
        checkedAt = now()
        if (compareVersions(latest.version, appVersion) <= 0) {
          release = undefined
          plugins = []
          await refreshHost(await hostStatus())
          set('up-to-date')
          return view()
        }
        if (!release || release.version !== latest.version) file = undefined
        release = latest
        await refreshHost(await hostStatus())
        set('available')
        if (autoDownload) void download()
      } catch (error) {
        checkedAt = now()
        fail(error, 'check')
      } finally {
        checking = undefined
      }
      return view()
    })()
    return checking
  }

  function throttledProgress() {
    let last = 0
    return (received, total) => {
      const at = now()
      if (received < total && at - last < PROGRESS_EVERY_MS) return
      last = at
      progress = { received, total }
      if (state === 'downloading') emit()
    }
  }

  function download() {
    if (downloading) return downloading
    if (!release || !(state === 'available' || (state === 'failed' && failure && ['download', 'verify'].includes(failure.stage))))
      return Promise.resolve(view())
    downloading ??= (async () => {
      const controller = new AbortController()
      downloadAbort = controller
      progress = { received: 0, total: release.asset.size }
      set('downloading')
      try {
        const result = await source.download(release, { onProgress: throttledProgress(), signal: controller.signal })
        file = result.file
        await source.sweep?.(file)
        set('ready')
      } catch (error) {
        fail(error, 'download')
      } finally {
        downloading = undefined
        downloadAbort = undefined
      }
      return view()
    })()
    return downloading
  }

  function sleepUntilPoll(run) {
    return new Promise(done => {
      waitWake = done
      waitTimer = setTimer(() => {
        waitTimer = undefined
        done(undefined)
      }, WAIT_POLL_MS)
    }).finally(() => {
      if (run === gateRun) waitWake = undefined
    })
  }

  /**
   * The gate: an App-only update installs at once; one that changes the Host enters the Host's install window (new
   * starts refused) and waits until nothing runs, waits for an approval or has an unknown write, renewing the window as
   * it goes. `cancelWaiting` leaves the window and goes back to `ready`.
   */
  async function runGate() {
    const run = ++gateRun
    if (plan === 'app') return true
    for (;;) {
      if (run !== gateRun) return false
      const entered = await gate.enter(release.pluginApi.formats, release.host.version).catch(() => undefined)
      // Cancelled while entering: that request may have opened the window again, so leave it once more.
      if (run !== gateRun) {
        if (entered) await gate.leave('cancelled')
        return false
      }
      // Without the Host's window nothing stops a start in the meantime: no install.
      if (!entered) throw new UpdateError('gate', 'window-unavailable')
      const count = blocking(entered.busy)
      if (count === 0) {
        const committed = await gate.commit()
        // Cancelled while the Host was committing: undo it, whatever it answered.
        if (run !== gateRun) {
          await gate.leave('cancelled')
          return false
        }
        if (committed === 'committed') return true
        if (committed === 'unavailable') throw new UpdateError('gate', 'window-unavailable')
      } else {
        waiting = { count, ...entered.busy }
        if (state !== 'waiting') set('waiting')
        else emit()
      }
      await sleepUntilPoll(run)
    }
  }

  async function install(when = 'now') {
    if (when === 'at-quit') {
      if (state === 'ready') {
        installAtQuit = true
        emit()
      }
      return view()
    }
    const retry = state === 'failed' && (failure?.stage === 'install' || failure?.stage === 'gate')
    // One install at a time: a second click must not make the first one's run stale and close its window.
    if (gating || (state !== 'ready' && !retry) || !file || !release) return view()
    gating = true
    installAtQuit = false
    await refreshHost(await hostStatus())
    try {
      if (!(await runGate())) return view()
      set('installing')
      await installer.install({ file, plan, version: release.version })
    } catch (error) {
      if (plan === 'host') await gate.leave('failed')
      fail(error, 'install')
    } finally {
      gating = false
    }
    return view()
  }

  async function cancelWaiting() {
    if (state !== 'waiting') return view()
    gateRun++
    if (waitTimer !== undefined) clearTimer(waitTimer)
    waitTimer = undefined
    waitWake?.()
    waitWake = undefined
    waiting = undefined
    await gate.leave('cancelled')
    set('ready')
    return view()
  }

  async function setAutoDownload(on) {
    await savePreferences({ autoDownload: on === true })
    autoDownload = on === true
    emit()
    if (autoDownload && state === 'available') void download()
    return view()
  }

  /**
   * Whether a quit the user started should wait for the updater: it installs at quit, or an install waits for sessions
   * (which this quit then gives up). A quit macOS starts (logout, restart, shutdown) never waits.
   */
  function holdsQuit({ system }) {
    if (system) return false
    return (state === 'ready' && installAtQuit) || state === 'waiting'
  }

  /**
   * The quit the user started, held by `holdsQuit`: resolves true when the installer took over (it ends the app), false
   * when the app should simply quit. An update that changes the Host installs only when nothing is under way; otherwise
   * it waits for the next quit or the button, ready as it was.
   */
  async function quitting() {
    if (state === 'waiting') {
      await cancelWaiting()
      return false
    }
    if (!(state === 'ready' && installAtQuit) || !file || !release) return false
    const host = await hostStatus()
    await refreshHost(host)
    if (plan === 'host') {
      if (!host || blocking(host.busy) > 0) return false
      const entered = await gate.enter(release.pluginApi.formats, release.host.version).catch(() => undefined)
      if (!entered) return false
      if (blocking(entered.busy) > 0 || (await gate.commit()) !== 'committed') {
        await gate.leave('cancelled')
        return false
      }
    }
    try {
      set('installing')
      await installer.install({ file, plan, version: release.version })
      return true
    } catch (error) {
      if (plan === 'host') await gate.leave('failed')
      fail(error, 'install')
      return false
    }
  }

  function background() {
    clearTimer(schedule)
    schedule = setTimer(() => {
      void check().finally(background)
    }, CHECK_EVERY_MS)
  }

  return {
    view,
    check,
    download,
    install,
    cancelWaiting,
    setAutoDownload,
    holdsQuit,
    quitting,
    /**
     * Starts the background schedule and reads the plugins an earlier update held off. A window this app left open when
     * it quit or crashed (waiting, or committed and never followed by a stop) is left first.
     */
    start() {
      // The Host refuses this unless this device holds the window, so another desktop process's window stays.
      void (state === 'unsupported' ? Promise.resolve() : gate.leave('cancelled').catch(() => {}))
        .then(() => hostStatus())
        .then(host => {
          if (host) {
            held = host.held
            emit()
          }
        })
      if (state === 'unsupported') return
      schedule = setTimer(() => {
        void check().finally(background)
      }, FIRST_CHECK_MS)
    },
    /** After a wake: checks at once when the last check is older than the interval. */
    resume() {
      if (state === 'unsupported') return
      if (checkedAt === undefined || now() - checkedAt >= CHECK_EVERY_MS) {
        void check()
        background()
      }
    },
    stop() {
      clearTimer(schedule)
      if (waitTimer !== undefined) clearTimer(waitTimer)
      downloadAbort?.abort()
    },
  }
}

/**
 * Why this build cannot update itself, or undefined when it can: a development run, a build without the feed and key, a
 * build that is not signed (Squirrel.Mac installs only into a signed app) or another system.
 */
function unsupportedReason({ packaged, platform, source = SOURCE }) {
  if (!packaged) return 'development'
  if (platform !== 'darwin') return 'platform'
  if (!source.feedUrl || !source.publicKey) return 'not-configured'
  if (!source.signed) return 'unsigned'
  return undefined
}

/** How long Squirrel.Mac may take to take the file before the install counts as failed. */
const INSTALLER_TIMEOUT_MS = 2 * 60_000

/**
 * The real installer: Electron's autoUpdater (Squirrel.Mac), which itself checks that the new app carries the same code
 * signature. It is given the already verified file through a one-off loopback feed in Squirrel's default format
 * (`{ url }`), so nothing is downloaded twice and nothing unverified reaches it. An update that changes the Host first
 * stops the Host this app started (as an update); a Host started elsewhere refuses the install. Squirrel saying there is
 * no update, an error or no answer within two minutes all fail the install, and the Host is started again. Not
 * exercised before a signed build exists.
 */
function createElectronInstaller({ autoUpdater, stopHost, restartHost, serve, setTimer = setTimeout, clearTimer = clearTimeout }) {
  return {
    async install({ file, plan }) {
      let feed
      let timer
      const listeners = []
      const on = (event, listener) => {
        autoUpdater.once(event, listener)
        listeners.push([event, listener])
      }
      try {
        // From here on every failure starts the Host again, a stop that timed out included: its supervisor timer is off.
        if (plan === 'host') {
          const stopped = await stopHost()
          if (!stopped.ok) throw new UpdateError('install', stopped.error)
        }
        feed = await serve(file)
        await new Promise((resolve, reject) => {
          on('update-downloaded', resolve)
          on('update-not-available', () => reject(new UpdateError('install', 'installer-refused')))
          on('error', () => reject(new UpdateError('install', 'installer-failed')))
          timer = setTimer(() => reject(new UpdateError('install', 'installer-timeout')), INSTALLER_TIMEOUT_MS)
          autoUpdater.setFeedURL({ url: feed.url })
          autoUpdater.checkForUpdates()
        })
      } catch (error) {
        if (plan === 'host') await restartHost()
        throw error instanceof UpdateError ? error : new UpdateError('install', 'installer-failed')
      } finally {
        clearTimer(timer)
        for (const [event, listener] of listeners) autoUpdater.removeListener(event, listener)
        feed?.close()
      }
      autoUpdater.quitAndInstall()
    },
  }
}

/**
 * Hands Squirrel.Mac the verified file: a one-off server on 127.0.0.1 with unguessable paths, answering the JSON feed
 * and then the file, closed after the install takes it.
 */
async function serveVerifiedFile(file, { createServer = require('node:http').createServer } = {}) {
  const { createReadStream } = require('node:fs')
  const token = randomUUID()
  let origin = ''
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === `/${token}/feed.json`) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: `${origin}/${token}/update.zip` }))
      return
    }
    if (req.method === 'GET' && req.url === `/${token}/update.zip`) {
      res.writeHead(200, { 'content-type': 'application/zip' })
      createReadStream(file).pipe(res)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  origin = `http://127.0.0.1:${address.port}`
  // Closing also cuts a transfer in progress: once the installer gave up, Squirrel cannot finish fetching the file later
  // and stage an update that would apply at the next launch without the gate.
  return {
    url: `${origin}/${token}/feed.json`,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

module.exports = {
  UPDATE_CHANNELS,
  FIRST_CHECK_MS,
  CHECK_EVERY_MS,
  WAIT_POLL_MS,
  UpdateError,
  compareVersions,
  parseVersion,
  verifyFeed,
  publicKeyFrom,
  httpsGet,
  createFeedSource,
  readUpdatePreferences,
  writeUpdatePreferences,
  planFor,
  incompatiblePlugins,
  parseHostStatus,
  createHostGate,
  createUpdater,
  unsupportedReason,
  createElectronInstaller,
  INSTALLER_TIMEOUT_MS,
  serveVerifiedFile,
  /** The packaged build's feed, key and signing; the end-to-end test's bootstrap replaces it. */
  configuration: () => SOURCE,
}
