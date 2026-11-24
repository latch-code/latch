'use strict'
// The computers this desktop app reaches: the Host on this Mac (host.sock) and other computers' Hosts over HTTPS. The
// list belongs to this app, not to any Host: `userData/computers.json` (0600) holds each computer's hostId, address,
// name and when it was added, never a credential. Each computer's credential stays in its own
// `latch-devices/<hostId>.json` (credentials.cjs) with its own enrollment and device key; that encrypted record alone
// decides where the credential may go (origin and certificate pin), and a listed origin that disagrees is corrected.
const { randomUUID } = require('node:crypto')
const { lstat, mkdir, open, readFile, rename, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { attentionOf, attentionTitle, sameName, sessionsOf } = require('./notifications.cjs')

const FILE = 'computers.json'
const COMPUTER_LIMIT = 16
const HOST_ID = /^[a-z2-7]{52}$/
const RECORD_KEYS = new Set(['hostId', 'kind', 'origin', 'name', 'addedAt', 'lastSeenAt', 'lastVersion'])
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/u
const STATES = [
  'online',
  'connecting',
  'offline',
  'stopping',
  'sleeping',
  'revoked',
  'wrong-host',
  'cert-error',
  'cert-changed',
  'outdated',
]
/** While online, `lastSeenAt` is written at most this often; leaving online writes it at once. */
const SEEN_WRITE_MS = 10 * 60 * 1000
/** While a computer answers: every 15 seconds while a Latch window is in front, every minute otherwise. */
const PROBE_FRONT_MS = 15_000
const PROBE_BACK_MS = 60_000
const PROBE_RETRY_MS = 15_000
const PROBE_MAX_MS = 5 * 60 * 1000

/** Exactly an HTTPS origin (`https://host[:port]`), as `URL.origin` writes it; anything else is undefined. */
function httpsOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 512) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.origin === raw ? raw : undefined
  } catch {
    return undefined
  }
}

const isTime = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
/** One line of at most 80 characters, counted in code points as the Host's names are cut. */
const isName = value => typeof value === 'string' && value.trim().length > 0 && [...value].length <= 80 && !/[\p{C}]/u.test(value)

/** One record, strictly: unknown members, a local record with an address or a remote one without make it invalid. */
function parseComputer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Object.keys(value).some(key => !RECORD_KEYS.has(key))) return undefined
  if (typeof value.hostId !== 'string' || !HOST_ID.test(value.hostId)) return undefined
  if (value.kind !== 'local' && value.kind !== 'https') return undefined
  if (value.kind === 'https' ? httpsOrigin(value.origin) === undefined : value.origin !== undefined) return undefined
  if (!isName(value.name) || !isTime(value.addedAt)) return undefined
  if (value.lastSeenAt !== undefined && !isTime(value.lastSeenAt)) return undefined
  if (value.lastVersion !== undefined && !(typeof value.lastVersion === 'string' && VERSION.test(value.lastVersion))) return undefined
  return {
    hostId: value.hostId,
    kind: value.kind,
    ...(value.kind === 'https' ? { origin: value.origin } : {}),
    name: value.name,
    addedAt: value.addedAt,
    ...(value.lastSeenAt !== undefined ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(value.lastVersion !== undefined ? { lastVersion: value.lastVersion } : {}),
  }
}

/** `{ version: 1, computers }`, strict, at most 16 computers, each hostId once; undefined for anything else. */
function parseComputers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Object.keys(value).some(key => key !== 'version' && key !== 'computers') || value.version !== 1) return undefined
  if (!Array.isArray(value.computers) || value.computers.length > COMPUTER_LIMIT) return undefined
  const computers = []
  const seen = new Set()
  for (const item of value.computers) {
    const record = parseComputer(item)
    if (!record || seen.has(record.hostId)) return undefined
    seen.add(record.hostId)
    computers.push(record)
  }
  return { version: 1, computers }
}

/**
 * The saved list. A missing file is an empty list; a file that does not parse is not guessed at: the list is empty and
 * `damaged`, and the next write first moves the file aside to `computers.json.damaged`.
 * @returns {Promise<{ computers: NonNullable<ReturnType<typeof parseComputer>>[], damaged: boolean }>}
 */
async function readComputers(directory, { uid = /** @type {() => number} */ (process.getuid)() } = {}) {
  const file = join(directory, FILE)
  let stats
  try {
    stats = await lstat(file)
  } catch {
    return { computers: [], damaged: false }
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.uid !== uid) return { computers: [], damaged: true }
  try {
    const parsed = parseComputers(JSON.parse(await readFile(file, 'utf8')))
    return parsed ? { computers: parsed.computers, damaged: false } : { computers: [], damaged: true }
  } catch {
    return { computers: [], damaged: true }
  }
}

/**
 * Writes the list atomically (0600 temporary file, fsync, rename). Only records the reader accepts are written, each
 * hostId once and at most 16: one bad record never costs the others. Resolves how many records were left out.
 */
async function writeComputers(directory, computers, { damaged = false } = {}) {
  const seen = new Set()
  const valid = []
  for (const item of computers) {
    const record = parseComputer(item)
    if (!record || seen.has(record.hostId) || valid.length >= COMPUTER_LIMIT) continue
    seen.add(record.hostId)
    valid.push(record)
  }
  const value = { version: 1, computers: valid }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, FILE)
  if (damaged) await rename(file, `${file}.damaged`).catch(() => {})
  const temporary = join(directory, `.${FILE}-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return computers.length - valid.length
}

/**
 * A remote computer's next state after what main learned. `revoked` stays until the computer is removed or added again;
 * a Host that announced it is stopping or sleeping stays so until its `retryAfter` has passed, even while unreachable.
 * @param {{ state: string, until?: number, reason?: string, lastSeenAt?: number }} current
 * @param {{ kind: string, state?: string, reason?: string, retryAfter?: number }} event
 * @param {number} at
 */
function nextState(current, event, at) {
  const seen = current.lastSeenAt !== undefined ? { lastSeenAt: current.lastSeenAt } : {}
  if (current.state === 'revoked') return current
  switch (event.kind) {
    case 'online':
      return { state: 'online', lastSeenAt: at }
    case 'connecting':
      return { state: 'connecting', ...seen }
    case 'revoked':
    case 'wrong-host':
    case 'cert-error':
    case 'cert-changed':
    case 'outdated':
      return { state: event.kind, ...seen }
    case 'offline':
      if ((current.state === 'stopping' || current.state === 'sleeping') && (current.until ?? 0) > at) return current
      return { state: 'offline', ...seen }
    case 'host-state':
      if (event.state === 'awake') return { state: 'connecting', lastSeenAt: at }
      if (event.state === 'stopping' || event.state === 'sleeping')
        return {
          state: event.state,
          ...(event.reason ? { reason: event.reason } : {}),
          until: at + Math.max(1, Math.min(event.retryAfter ?? 30, 3600)) * 1000,
          lastSeenAt: at,
        }
      return current
    default:
      return current
  }
}

/**
 * When main looks at a computer again: every 15 seconds while it answers and a Latch window is in front, every minute
 * while none is, backing off from 15 seconds to five minutes while it does not answer.
 */
function probeDelay(current, failures, at, focused = true) {
  if (current.state === 'revoked') return undefined
  if (current.state === 'online' || current.state === 'connecting') return focused ? PROBE_FRONT_MS : PROBE_BACK_MS
  if ((current.state === 'stopping' || current.state === 'sleeping') && (current.until ?? 0) > at)
    return Math.max(1_000, (current.until ?? at) - at + 1_000)
  return Math.min(PROBE_MAX_MS, PROBE_RETRY_MS * 2 ** Math.min(Math.max(failures - 1, 0), 10))
}

/**
 * Each name once: a name two other computers share gets the first four characters of each one's hostId. This Mac is
 * 「这台 Mac」 on the page, so its own name never collides.
 */
function distinctNames(items) {
  // A name that mixes Latin with a script of Latin look-alikes (build-mіni, Cyrillic і) always carries its hostId.
  // Compared as a person reads them: look-alikes (another width, case, a variation selector) count as the same name.
  const counts = new Map()
  for (const item of items) if (!item.local) counts.set(sameName(item.name), (counts.get(sameName(item.name)) ?? 0) + 1)
  return items.map(item =>
    !item.local && ((counts.get(sameName(item.name)) ?? 0) > 1 || mixedScript(item.name))
      ? { ...item, name: `${item.name} ${item.hostId.slice(0, 4)}` }
      : item,
  )
}

/** A first name for a computer before its Host has told it: the first label of its address. */
function nameFromOrigin(origin) {
  try {
    const host = new URL(origin).hostname
    return (/^[\d.]+$|:/u.test(host) ? host : host.split('.')[0]).slice(0, 80) || '电脑'
  } catch {
    return '电脑'
  }
}

/**
 * Opens one window per computer however many calls race: concurrent calls for one hostId share one attempt, and an open
 * window is brought forward instead of a second one.
 * @param {{ existing(hostId: string): any, create(hostId: string): Promise<any>, focus(window: any): void }} options
 */
function createWindowOpener({ existing, create, focus }) {
  const opening = new Map()
  return function open(hostId) {
    const window = existing(hostId)
    if (window) {
      focus(window)
      return Promise.resolve(window)
    }
    let attempt = opening.get(hostId)
    if (!attempt) {
      attempt = create(hostId).finally(() => opening.delete(hostId))
      opening.set(hostId, attempt)
    }
    return attempt
  }
}

/** Scripts whose letters pass for Latin ones. Han, kana and Hangul beside Latin (「王的 MacBook」) are ordinary names. */
const LOOK_ALIKE =
  /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Coptic}\p{Script=Lisu}\p{Script=Canadian_Aboriginal}\p{Script=Tifinagh}\p{Script=Glagolitic}\p{Script=Georgian}]/u
function mixedScript(name) {
  const text = String(name).normalize('NFKC')
  return /\p{Script=Latin}/u.test(text) && LOOK_ALIKE.test(text)
}

/**
 * Sends each other computer's window the list only when what it may see changed: what waits on another computer is not
 * in its view, so a change to it sends that window nothing (not even the moment it happened).
 * @param {(target: any, view: any) => void} send
 */
function createViewSender(send) {
  const sent = new WeakMap()
  const push = (target, view) => {
    const text = JSON.stringify(view)
    if (sent.get(target) === text) return false
    sent.set(target, text)
    send(target, view)
    return true
  }
  /** What the window read itself (`list()`), so the first push after it is compared with that too. */
  push.seen = (target, view) => {
    sent.set(target, JSON.stringify(view))
    return view
  }
  return push
}

/**
 * Which page an IPC call came from: `{ kind: 'full' }` for this Mac's own window, `{ kind: 'remote', hostId }` for a
 * listed computer's own window, otherwise undefined (a child frame, another document, an unknown window).
 * @param {{ homeOf: (contents: any) => string, isAppUrl: (url: string, home: string) => boolean, localHome: string, mainContents: () => any, isRemoteContents: (hostId: string, contents: any) => boolean, has: (hostId: string) => boolean }} options
 */
function createSenderOf({ homeOf, isAppUrl, localHome, mainContents, isRemoteContents, has }) {
  return event => {
    const frame = event?.senderFrame
    const contents = event?.sender
    if (!frame || frame.detached || frame.parent || !contents) return undefined
    const home = homeOf(contents)
    if (typeof home !== 'string' || !isAppUrl(frame.url, home)) return undefined
    if (home === localHome) return contents === mainContents() ? { kind: 'full' } : undefined
    const hostId = home.slice(2)
    return has(hostId) && isRemoteContents(hostId, contents) ? { kind: 'remote', hostId } : undefined
  }
}

const FORBIDDEN = Object.freeze({ ok: false, error: 'forbidden', message: '只接受 Latch 页面的请求。' })
const NO_GESTURE = Object.freeze({ ok: false, error: 'gesture-required', message: '请在 Latch 页面上点按后再试。' })
const NOT_FOUND = Object.freeze({ ok: false, error: 'computer-not-found', message: '找不到这台电脑。' })

/**
 * `latch:computers:start` (新会话 on a computer): only from a Latch page, only after a real click or key on it, only for a
 * listed computer; a remote computer's page only for itself or this Mac.
 * @param {{ senderOf: (event: any) => ({ kind: string, hostId?: string } | undefined), gestureOf: (event: any) => boolean, has: (hostId: string) => boolean, localHostId: string, startOn: (hostId: string) => any }} options
 */
function createStartHandler({ senderOf, gestureOf, has, localHostId, startOn }) {
  return (event, hostId) => {
    const sender = senderOf(event)
    if (!sender) return FORBIDDEN
    // Everything that refuses without a gesture is checked first, so a refused call never uses one up.
    if (typeof hostId !== 'string' || !has(hostId)) return NOT_FOUND
    if (sender.kind === 'remote' && hostId !== sender.hostId && hostId !== localHostId) return FORBIDDEN
    if (!gestureOf(event)) return NO_GESTURE
    return startOn(hostId)
  }
}

const CUSTOM_AGENT = /^agt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const unavailableAgent = () => refusal(409, 'work-computer-unavailable', '这台工作电脑上的助手暂不可用。')

function canRunWorkAgents(snapshot, hostId) {
  return (
    snapshot?.host?.hostId === hostId
    && snapshot?.device?.dataScope === 'all'
    && Array.isArray(snapshot.device.scopes)
    && ['view', 'run'].every(scope => snapshot.device.scopes.includes(scope))
    && snapshot.catalog?.features?.agentWorkComputer === true
    && Array.isArray(snapshot.customAgents)
  )
}

/** The target's authenticated snapshot alone decides which assistants may receive work there. */
function workAgents(snapshot, hostId) {
  if (!canRunWorkAgents(snapshot, hostId)) return undefined
  return snapshot.customAgents.flatMap(agent => {
    if (
      !agent
      || typeof agent.id !== 'string'
      || !CUSTOM_AGENT.test(agent.id)
      || agent.available !== true
      || agent.workComputer !== undefined
    )
      return []
    const name = attentionTitle(agent.name)
    return name ? [{ id: agent.id, name }] : []
  })
}

/** Only the local top-level page can choose a target or open it. The native picker keeps the rest of the remote roster private. */
function createWorkComputerHandler({ senderOf, gestureOf, localHostId, proxyFor, choose, navigate, localSnapshot }) {
  return async (event, hostId, agentId, owner) => {
    if (senderOf(event)?.kind !== 'full') return FORBIDDEN
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || hostId === localHostId) return NOT_FOUND
    if (agentId !== undefined || owner !== undefined) {
      if (typeof agentId !== 'string' || !CUSTOM_AGENT.test(agentId) || typeof owner !== 'string' || !CUSTOM_AGENT.test(owner))
        return unavailableAgent()
    }
    const proxy = proxyFor(hostId)
    if (!proxy) return NOT_FOUND
    if (!gestureOf(event)) return NO_GESTURE
    const allowed = async () => {
      const source = await localSnapshot()
      if (senderOf(event)?.kind !== 'full' || proxyFor(hostId) !== proxy || !canRunWorkAgents(source, localHostId)) return false
      // A click from a stale page must not open an old or removed binding.
      return (
        owner === undefined
        || source.customAgents.some(
          agent => agent?.id === owner && agent.workComputer?.hostId === hostId && agent.workComputer.agentId === agentId,
        )
      )
    }
    const agents = async () => {
      if (!(await allowed())) return undefined
      const result = await proxy.probe()
      return result?.state === 'online' && proxyFor(hostId) === proxy ? workAgents(result.snapshot, hostId) : undefined
    }
    try {
      const list = await agents()
      if (!list || !(await allowed())) return unavailableAgent()
      if (agentId !== undefined) {
        if (!list.some(item => item.id === agentId)) return unavailableAgent()
        return navigate(hostId, agentId)
      }
      const selected = await choose(hostId, list)
      if (!selected) return refusal(409, 'canceled', '')
      const current = await agents()
      if (!current || !(await allowed())) return unavailableAgent()
      if (selected === 'new') return navigate(hostId, 'new')
      if (!current.some(item => item.id === selected)) return unavailableAgent()
      return { ok: true, hostId, agentId: selected }
    } catch {
      return unavailableAgent()
    }
  }
}

/**
 * Sends to a window once its page has loaded, or now; a load that fails or a window that goes takes the wait with it,
 * so no handler is left behind.
 */
function whenLoaded(contents, send) {
  if (!contents.isLoading()) {
    send()
    return
  }
  const done = () => {
    contents.removeListener('did-finish-load', loaded)
    contents.removeListener('did-fail-load', done)
    contents.removeListener('destroyed', done)
  }
  const loaded = () => {
    done()
    send()
  }
  contents.once('did-finish-load', loaded)
  contents.once('did-fail-load', done)
  contents.once('destroyed', done)
}

function refusal(status, error, message) {
  return { ok: false, status, error, message }
}

/**
 * The registry of remote computers: their records, credential stores, scheme handlers, states and probes.
 * @param {object} options
 * @param {string} options.directory  userData
 * @param {string} options.localHostId  the Host on this Mac's host.sock
 * @param {() => { name?: string, state: string }} options.local  this Mac's Host as the list shows it
 * @param {(hostId: string) => Promise<any>} options.openStore  credentials.cjs openCredentialStore for that hostId
 * @param {(input: { hostId: string, origin: string, store: any, onStatus: (event: any) => void }) => any} options.makeProxy
 * @param {(link: { origin: string, code: string }, hooks: { signal: AbortSignal, onWaiting: (state: { fingerprint: string, hostId: string }) => void, refuse: (hostId: string) => string | undefined }) => Promise<{ hostId: string, certificate?: string, key: any, deviceId: string, credential: string }>} options.enroll
 * @param {(link: string) => { origin: string, code: string } | undefined} options.parseLink
 * @param {(hostId: string) => Promise<void> | void} [options.forgetPartition]  closes the computer's windows and clears its storage
 * @param {(kind?: 'list' | 'attention') => void} [options.onChange]  the list, a state or what waits on a computer changed
 * @param {() => boolean} [options.focused]  a Latch window is in front
 * @param {(hostId: string, snapshot: any) => void} [options.onSnapshot]  a computer's authenticated snapshot (notifications)
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {(callback: () => void, ms: number) => any} [options.setTimer]
 * @param {(timer: any) => void} [options.clearTimer]
 */
function createComputers(options) {
  const {
    directory,
    localHostId,
    local,
    openStore,
    makeProxy,
    enroll,
    parseLink,
    forgetPartition = () => {},
    onChange = () => {},
    focused = () => true,
    onSnapshot = () => {},
    log = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options
  /**
   * `attention`: what waited on that computer at its last authenticated snapshot (attentionOf); kept while it is away,
   * so the page can say what waited before it went, and dropped when it removes this device.
   * `sessions`: that computer's Code sessions at its last authenticated snapshot (sessionsOf), for this Mac's unified
   * list; in memory only, kept while it is away and dropped when it removes this device.
   * @type {Map<string, { record: any, store: any, proxy: any, status: any, failures: number, timer?: any, seenWritten: number, stopRenewal?: () => void, dueAt?: number, probing?: Promise<void>, attention?: { count: number, items: any[], running: number }, sessions?: any[] }>}
   */
  const entries = new Map()
  let damaged = false
  let adding
  let writes = Promise.resolve()
  let stopped = false
  /**
   * Computers whose credential store could not be opened at start. The list is then read-only until that is fixed (the
   * next start): nothing is written over the file and no page storage is deleted, so nothing is lost by a passing fault.
   */
  const unavailable = new Set()
  const readOnly = () => unavailable.size > 0
  const READ_ONLY = '无法打开其他电脑的设备凭据，电脑列表暂时只读。请检查后重新打开 Latch。'

  function records() {
    return [...entries.values()].map(entry => entry.record)
  }

  function save() {
    if (readOnly()) return Promise.resolve()
    const list = records()
    const next = writes.then(async () => {
      await writeComputers(directory, list, { damaged })
      damaged = false
    })
    writes = next.catch(error => log(`无法保存电脑列表：${error instanceof Error ? error.message : '未知错误'}`))
    return next
  }

  /** `attention`: only what waits on a computer changed, which no other computer's window sees. */
  /** @param {'list' | 'attention'} [kind] */
  function changed(kind = 'list') {
    try {
      onChange(kind)
    } catch {
      /* A closed window is not the registry's trouble. */
    }
  }

  function schedule(entry) {
    if (entry.timer !== undefined) clearTimer(entry.timer)
    entry.timer = undefined
    if (stopped) return
    const delay = probeDelay(entry.status, entry.failures, now(), focused())
    if (delay === undefined) return
    entry.dueAt = now() + delay
    entry.timer = setTimer(() => void probe(entry.record.hostId), delay)
    entry.timer?.unref?.()
  }

  /** A record changed on input; one that would not be accepted is never adopted. */
  function adopt(entry, next) {
    const record = parseComputer(next)
    if (!record) return false
    entry.record = record
    void save()
    return true
  }

  function apply(entry, event) {
    const before = entry.status
    const after = nextState(before, event, now())
    if (after === before) return
    entry.status = after
    const record = entry.record
    if (after.lastSeenAt !== undefined) {
      const leaving = before.state === 'online' && after.state !== 'online'
      if (leaving || now() - entry.seenWritten > SEEN_WRITE_MS) {
        entry.seenWritten = now()
        adopt(entry, { ...record, lastSeenAt: new Date(after.lastSeenAt).toISOString() })
      }
    }
    if (after.state === 'online' || after.state === 'connecting') entry.failures = 0
    // A computer that removed this device: nothing it said before stands.
    if (after.state === 'revoked') {
      entry.attention = undefined
      entry.sessions = undefined
    }
    if (before.state !== after.state) {
      // A state that may change by itself is looked at again soon.
      schedule(entry)
      changed()
    }
  }

  /**
   * Looks at a computer once. Looks at one computer run one after another, so its snapshots apply in order; nothing a
   * look throws or rejects stops the computer from being looked at again.
   */
  function probe(hostId) {
    const entry = entries.get(hostId)
    if (!entry || stopped) return Promise.resolve()
    const next = (entry.probing ?? Promise.resolve()).then(() => look(hostId, entry))
    entry.probing = next.catch(() => {})
    return entry.probing
  }

  async function look(hostId, entry) {
    if (entries.get(hostId) !== entry || stopped) return
    let result
    try {
      result = await entry.proxy.probe()
    } catch {
      result = { state: 'offline' }
    }
    if (entries.get(hostId) !== entry) return
    try {
      observe(hostId, entry, result)
    } catch {
      log('无法读取另一台电脑的状态')
    } finally {
      schedule(entry)
    }
  }

  function observe(hostId, entry, result) {
    if (result.state !== 'online') entry.failures += 1
    if (result.state === 'online' && result.snapshot) {
      let attention
      try {
        attention = attentionOf(result.snapshot, { now: now() })
      } catch {
        // A snapshot that cannot be read says nothing about what waits there; the last one stands.
        attention = entry.attention
      }
      let sessions
      try {
        sessions = sessionsOf(result.snapshot)
      } catch {
        sessions = entry.sessions
      }
      if (JSON.stringify(attention) !== JSON.stringify(entry.attention) || JSON.stringify(sessions) !== JSON.stringify(entry.sessions)) {
        entry.attention = attention
        entry.sessions = sessions
        // Both are this Mac's page's alone: no other computer's window hears of the change.
        changed('attention')
      }
      try {
        onSnapshot(hostId, result.snapshot)
      } catch {
        /* Notifications cannot stop the list. */
      }
    }
    if (result.state === 'online') {
      const record = entry.record
      const name = result.name ?? record.name
      const version = result.version ?? record.lastVersion
      if (
        (name !== record.name || version !== record.lastVersion)
        && adopt(entry, { ...record, name, ...(version ? { lastVersion: version } : {}) })
      )
        changed()
    }
    apply(entry, { kind: result.state })
  }

  async function attach(listed, store) {
    // The encrypted record decides where the credential goes; a listed origin that disagrees is not used.
    const bound = store.binding?.()
    let record = listed
    if (bound && bound.origin !== listed.origin) {
      log('电脑列表中的地址与加密凭据不一致，已按凭据恢复')
      record = { ...listed, origin: bound.origin }
    }
    /** @type {any} */
    let entry
    const proxy = makeProxy({
      hostId: record.hostId,
      origin: record.origin,
      store,
      onStatus: event => {
        if (entry && entries.get(record.hostId) === entry) apply(entry, event)
      },
    })
    entry = {
      record,
      store,
      proxy,
      status: {
        state: store.current() ? 'connecting' : 'revoked',
        ...(record.lastSeenAt ? { lastSeenAt: Date.parse(record.lastSeenAt) } : {}),
      },
      failures: 0,
      seenWritten: now(),
    }
    entry.stopRenewal = proxy.startRenewalTimer?.()
    entries.set(record.hostId, entry)
    if (record !== listed) void save()
    return entry
  }

  /** Loads the saved list and starts looking at each computer. */
  async function start() {
    const saved = await readComputers(directory)
    damaged = saved.damaged
    if (damaged) log('电脑列表文件无法读取，已按空列表处理')
    for (const record of saved.computers) {
      if (record.kind !== 'https' || record.hostId === localHostId) continue
      try {
        const entry = await attach(record, await openStore(record.hostId))
        void probe(entry.record.hostId)
      } catch (error) {
        unavailable.add(record.hostId)
        log(`无法打开另一台电脑的设备凭据：${error instanceof Error ? error.message : '未知错误'}`)
      }
    }
    changed()
  }

  /**
   * The list as a page sees it. `full` (this Mac's own page) adds each address and an addition in progress; another
   * computer's page gets names, states and versions only.
   */
  function view({ full = false } = {}) {
    const here = local()
    const items = [
      { hostId: localHostId, name: here.name ?? '这台 Mac', local: true, state: here.state },
      ...[...entries.values()].map(entry => ({
        hostId: entry.record.hostId,
        name: entry.record.name,
        local: false,
        state: entry.status.state,
        // Another computer's page learns when one was last seen only while it is away, to the minute: a look at a
        // computer that answers moves nothing it can see.
        ...(entry.status.lastSeenAt !== undefined && (full || (entry.status.state !== 'online' && entry.status.state !== 'connecting'))
          ? { lastSeenAt: new Date(full ? entry.status.lastSeenAt : Math.floor(entry.status.lastSeenAt / 60_000) * 60_000).toISOString() }
          : {}),
        ...(entry.record.lastVersion ? { version: entry.record.lastVersion } : {}),
        ...(entry.status.reason ? { reason: entry.status.reason } : {}),
        ...(full ? { origin: entry.record.origin } : {}),
        // What waits there, for this Mac's own page only: titles and kinds, never a message, path or argument.
        ...(full && entry.attention
          ? {
              waiting: entry.attention.items.map(item => ({ hostId: entry.record.hostId, ...item })),
              running: entry.attention.running,
            }
          : {}),
        // That computer's sessions for the unified list, for this Mac's own page only: never another computer's window.
        ...(full && entry.sessions ? { sessions: entry.sessions } : {}),
      })),
    ]
    const computers = distinctNames(items)
    if (!full) return { computers }
    return {
      computers,
      ...(readOnly() ? { problem: 'credentials' } : {}),
      adding: adding
        ? { stage: adding.stage, origin: adding.origin, ...(adding.fingerprint ? { fingerprint: adding.fingerprint } : {}) }
        : null,
    }
  }

  /**
   * Adds the computer of an invitation link (from the clipboard or a code file, read by main). Concurrent calls are
   * refused. A computer already in the list is refused unless it had removed this device, and is then replaced.
   */
  async function add(text) {
    if (readOnly()) return refusal(409, 'computers-read-only', READ_ONLY)
    if (adding) return refusal(409, 'add-busy', '正在添加另一台电脑。')
    const link = parseLink(text)
    if (!link) return refusal(400, 'invalid-link', '没有找到电脑链接。请在那台电脑的 Latch 里点「复制链接」。')
    if (entries.size + 1 >= COMPUTER_LIMIT && ![...entries.values()].some(entry => entry.status.state === 'revoked'))
      return refusal(409, 'too-many-computers', `最多添加 ${COMPUTER_LIMIT - 1} 台其他电脑。`)
    const controller = new AbortController()
    adding = { stage: 'checking', origin: link.origin, controller }
    changed()
    try {
      const result = await enroll(link, {
        signal: controller.signal,
        onWaiting: ({ fingerprint }) => {
          if (!adding) return
          adding.stage = 'waiting'
          adding.fingerprint = fingerprint
          changed()
        },
        refuse: hostId => {
          if (hostId === localHostId) return '这是这台 Mac 自己。'
          const existing = entries.get(hostId)
          return existing && existing.status.state !== 'revoked' ? '已添加这台电脑。' : undefined
        },
      })
      const previous = entries.get(result.hostId)
      if (previous) await drop(previous)
      const store = await openStore(result.hostId)
      await store.commit({
        key: result.key,
        deviceId: result.deviceId,
        credential: result.credential,
        ...(result.certificate ? { binding: { origin: link.origin, certificate: result.certificate } } : {}),
      })
      const record = {
        hostId: result.hostId,
        kind: 'https',
        origin: link.origin,
        name: nameFromOrigin(link.origin),
        addedAt: new Date(now()).toISOString(),
      }
      const entry = await attach(record, store)
      await save().catch(() => {})
      await probe(entry.record.hostId)
      return { ok: true, hostId: result.hostId }
    } catch (error) {
      const failure = /** @type {{ status?: unknown, code?: unknown, state?: unknown, message?: unknown }} */ (error ?? {})
      // Only main's own refusals (a ProxyError's code, a RemoteError's state) keep their words: another error may repeat
      // what the link held.
      const own = typeof failure.code === 'string' ? failure.code : typeof failure.state === 'string' ? failure.state : undefined
      if (own === undefined) log('添加电脑失败')
      const status = typeof failure.status === 'number' ? failure.status : 502
      const message = own !== undefined && typeof failure.message === 'string' ? failure.message : '无法添加这台电脑，请重试。'
      return refusal(status, own ?? 'add-failed', message)
    } finally {
      adding = undefined
      changed()
    }
  }

  function cancelAdd() {
    adding?.controller.abort()
    return { ok: true }
  }

  async function drop(entry) {
    if (entry.timer !== undefined) clearTimer(entry.timer)
    entry.stopRenewal?.()
    entries.delete(entry.record.hostId)
    await entry.store.clear().catch(() => log('无法删除另一台电脑的设备凭据'))
    try {
      await forgetPartition(entry.record.hostId)
    } catch {
      log('无法清除另一台电脑的页面数据')
    }
  }

  /**
   * Removes a computer: revokes this device there when that Host can still be reached as itself, then deletes the
   * credential, the record and the computer's page storage. `revokedThere` says whether that Host confirmed it.
   */
  async function remove(hostId) {
    if (readOnly()) return refusal(409, 'computers-read-only', READ_ONLY)
    const entry = typeof hostId === 'string' ? entries.get(hostId) : undefined
    if (!entry) return refusal(404, 'computer-not-found', '找不到这台电脑。')
    const revokedThere = entry.status.state === 'revoked' ? true : await entry.proxy.revokeSelf()
    if (entries.get(hostId) !== entry) return { ok: true, revokedThere }
    await drop(entry)
    await save().catch(() => {})
    changed()
    return { ok: true, revokedThere }
  }

  /**
   * Trusts the new certificate of a computer whose certificate changed, after the person chose to: only when its Host
   * proves it serves that certificate with its identity key (remote-proxy.cjs).
   */
  async function trustCertificate(hostId) {
    if (readOnly()) return refusal(409, 'computers-read-only', READ_ONLY)
    const entry = typeof hostId === 'string' ? entries.get(hostId) : undefined
    if (!entry || entry.status.state !== 'cert-changed') return refusal(404, 'computer-not-found', '找不到这台电脑。')
    const result = await entry.proxy.acceptCertificate()
    if (!result.ok) {
      if (result.reason === 'outdated')
        return refusal(409, 'outdated', '这个地址上的 Latch 不能证明新证书，没有信任它。请先更新那台电脑上的 Latch。')
      if (result.reason === 'offline') return refusal(502, 'host-unavailable', '无法连接到这台电脑，请稍后再试。')
      return refusal(409, 'certificate-refused', '这个地址上的服务器没能证明它是那台电脑，新证书没有被信任。')
    }
    await probe(hostId)
    return { ok: true }
  }

  /** Every session that waits on the person on the computers that answer now; the Dock adds this Mac's own. */
  function waitingTotal() {
    let total = 0
    for (const entry of entries.values()) if (entry.status.state === 'online') total += entry.attention?.count ?? 0
    return total
  }

  /**
   * Whether `taskId` is a session of that computer as main last read it (one that waits there, or one of its listed
   * sessions): this Mac's page opens only these on another computer.
   */
  function waits(hostId, taskId) {
    const entry = entries.get(hostId)
    return (
      entry?.attention?.items.some(item => item.taskId === taskId) === true
      || entry?.sessions?.some(item => item.taskId === taskId) === true
    )
  }

  /** A Latch window came to the front: computers that answer are looked at again at the faster rate. */
  function refocus() {
    for (const entry of entries.values())
      if ((entry.status.state === 'online' || entry.status.state === 'connecting') && (entry.dueAt ?? Infinity) - now() > PROBE_FRONT_MS)
        schedule(entry)
  }

  return {
    start,
    view,
    waitingTotal,
    waits,
    refocus,
    /** The name the list shows for a computer (two that share one get part of their hostId). */
    nameOf: hostId => view().computers.find(item => item.hostId === hostId)?.name,
    add,
    cancelAdd,
    remove,
    trustCertificate,
    probe,
    /** The scheme handlers of a computer in the list. */
    proxyFor: hostId => entries.get(hostId)?.proxy,
    stateOf: hostId => entries.get(hostId)?.status.state,
    has: hostId => hostId === localHostId || entries.has(hostId),
    /** Listed, even when its credentials could not be opened: its page storage stays. */
    known: hostId => entries.has(hostId) || unavailable.has(hostId),
    remotes: () => [...entries.keys()],
    stop() {
      stopped = true
      for (const entry of entries.values()) {
        if (entry.timer !== undefined) clearTimer(entry.timer)
        entry.stopRenewal?.()
      }
    },
    /** Resolves once every pending write of the list has finished (tests). */
    settled: () => writes,
  }
}

module.exports = {
  FILE,
  COMPUTER_LIMIT,
  STATES,
  httpsOrigin,
  parseComputer,
  parseComputers,
  readComputers,
  writeComputers,
  nextState,
  probeDelay,
  PROBE_FRONT_MS,
  PROBE_BACK_MS,
  distinctNames,
  mixedScript,
  nameFromOrigin,
  createWindowOpener,
  createViewSender,
  createComputers,
  createSenderOf,
  createStartHandler,
  createWorkComputerHandler,
  whenLoaded,
}
