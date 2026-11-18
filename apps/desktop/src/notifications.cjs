'use strict'
const { constants } = require('node:fs')
const { lstat, mkdir, open, rename, rm } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const { join } = require('node:path')
const { defineCopy } = require('./locale.cjs')
const COPY = defineCopy(
  {
    approval: '有一个请求等你处理。',
    question: '有一个问题等你回答。',
    failure: '一个会话失败了。',
    completion: '一个会话已完成。',
    untitled: '未命名会话',
    otherComputer: '另一台电脑',
  },
  {
    approval: 'A request needs your attention.',
    question: 'A question needs an answer.',
    failure: 'A session failed.',
    completion: 'A session finished.',
    untitled: 'Untitled session',
    otherComputer: 'Another computer',
  },
)
const DEFAULTS = Object.freeze({ completion: false, approval: false, title: false })
const CONSENTS = new Set(['unasked', 'accepted', 'declined'])
const fresh = () => ({ version: 1, preferences: { ...DEFAULTS }, consent: 'unasked' })
function validPreferences(value) {
  return (
    value !== null
    && typeof value === 'object'
    && Object.keys(value).length === 3
    && ['completion', 'approval', 'title'].every(key => Object.hasOwn(value, key) && typeof value[key] === 'boolean')
  )
}
function record(value) {
  if (validPreferences(value))
    return { version: 1, preferences: { ...value }, consent: value.completion || value.approval ? 'accepted' : 'unasked' }
  if (
    !value
    || typeof value !== 'object'
    || Object.keys(value).length !== 3
    || value.version !== 1
    || !['version', 'preferences', 'consent'].every(key => Object.hasOwn(value, key))
    || !validPreferences(value.preferences)
    || !CONSENTS.has(value.consent)
  )
    return undefined
  return { version: 1, preferences: { ...value.preferences }, consent: value.consent }
}
async function readPreferences(directory) {
  let fd
  try {
    const path = join(directory, 'notifications.json'),
      before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) return fresh()
    fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await fd.stat()
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) return fresh()
    const bytes = Buffer.alloc(4097)
    let offset = 0
    while (offset < bytes.length) {
      const part = await fd.read(bytes, offset, bytes.length - offset, offset)
      if (!part.bytesRead) break
      offset += part.bytesRead
    }
    const after = await fd.stat()
    if (offset > 4096 || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return fresh()
    return record(JSON.parse(bytes.subarray(0, offset).toString('utf8'))) ?? fresh()
  } catch {
    return fresh()
  } finally {
    await fd?.close()
  }
}
async function writePreferences(directory, value) {
  const checked = record(value)
  if (!checked) throw new Error('invalid-notification-preferences')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, '.notifications-' + randomUUID()),
    path = join(directory, 'notifications.json')
  let fd
  try {
    fd = await open(temporary, 'wx', 0o600)
    await fd.writeFile(JSON.stringify(checked) + '\n')
    await fd.sync()
    await fd.close()
    fd = undefined
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } finally {
    await fd?.close()
    await rm(temporary, { force: true })
  }
}
const ATTENTION_LIMIT = 50
const TITLE_LIMIT = 80
const RUNNING_LIMIT = 100_000
/** A session ID as the preload accepts it; anything else from a Host is not listed. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
/**
 * Characters that change how a line reads without being seen: controls, format characters (bidi overrides), line and
 * paragraph separators, unassigned and private-use code points, and default-ignorable ones (variation selectors).
 */
const INVISIBLE = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu
const stamp = value => {
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}
/** A title as other computers' rows and notifications show it: one visible line of at most `limit` code points. */
function attentionTitle(value, limit = TITLE_LIMIT) {
  return [...String(typeof value === 'string' ? value : '').replace(INVISIBLE, '')].slice(0, limit).join('').trim()
}
/**
 * What 等你处理 lists, as items: sessions with a request or a question (`approval`, `question`), a request Latch did not
 * recognise and nothing since, and runs the Host calls silent (`stuck`); a stop already asked for answers all of these.
 * Unread results and running work do not count. `count` is every such session, `items` the newest `limit` of them with
 * the title and when it began to wait, and `running` the sessions running without waiting on the person. Nothing else
 * of the snapshot is kept: no message, path, argument or project.
 */
function attentionOf(snapshot, { limit = ATTENTION_LIMIT, now = Date.now() } = {}) {
  // A Host's snapshot is data: entries that are not objects with a session ID of the accepted shape are left out.
  const listed = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const tasks = (Array.isArray(snapshot?.tasks) ? snapshot.tasks : []).filter(
    task => listed(task) && typeof task.id === 'string' && SESSION_ID.test(task.id),
  )
  const approvals = (Array.isArray(snapshot?.approvals) ? snapshot.approvals : []).filter(
    approval => listed(approval) && typeof approval.sessionId === 'string' && SESSION_ID.test(approval.sessionId),
  )
  const stopping = task => (task.status === 'running' || task.status === 'waiting-approval') && task.live?.activity === 'cancelling'
  const stopped = new Set(tasks.filter(stopping).map(task => task.id))
  const byId = new Map(tasks.map(task => [task.id, task]))
  /** @type {Map<string, { kind: 'approval' | 'question' | 'stuck', since: number | undefined }>} */
  const waiting = new Map()
  for (const approval of approvals) {
    if (stopped.has(approval.sessionId)) continue
    const at = stamp(approval.requestedAt)
    const before = waiting.get(approval.sessionId)
    const since = before?.since === undefined ? at : at === undefined ? before.since : Math.min(before.since, at)
    waiting.set(approval.sessionId, { kind: 'approval', since })
  }
  for (const task of tasks) {
    if (stopped.has(task.id) || waiting.has(task.id)) continue
    const asked = stamp(task.live?.unrecognized?.at)
    const stuck = asked !== undefined && asked >= (stamp(task.live?.lastEventAt) ?? Infinity)
    const quiet = task.live?.silent === true || stuck
    // A question also holds a session at waiting-approval; a real request is in the approvals above.
    if (task.status === 'waiting-approval' && !(task.pendingQuestions > 0))
      waiting.set(task.id, { kind: 'approval', since: stamp(task.live?.lastEventAt) })
    else if ((task.status === 'running' || task.status === 'waiting-approval') && task.pendingQuestions > 0)
      waiting.set(task.id, { kind: 'question', since: stamp(task.live?.lastEventAt) })
    else if (task.status === 'running' && quiet)
      waiting.set(task.id, { kind: 'stuck', since: stuck ? asked : stamp(task.live?.lastEventAt) })
  }
  const items = [...waiting].map(([taskId, item]) => {
    const task = byId.get(taskId)
    const since = item.since ?? stamp(task?.updatedAt) ?? now
    return { taskId, title: attentionTitle(task?.title), kind: item.kind, since: new Date(since).toISOString() }
  })
  items.sort((a, b) => Date.parse(b.since) - Date.parse(a.since))
  const running = tasks.filter(task => task.status === 'running' && !waiting.has(task.id) && !stopped.has(task.id)).length
  return { count: items.length, items: items.slice(0, limit), running: Math.min(running, RUNNING_LIMIT) }
}
/** How many of another computer's sessions this Mac's unified list holds. */
const SESSION_LIMIT = 60
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/u
/**
 * Another computer's Code sessions for this Mac's unified list: not archived, not 我的 Agent's, newest first, at most
 * `limit`. Each keeps its ID, title, one status word, when it changed and its saved project's ID and name; nothing else
 * of the snapshot (no message, folder, path, argument or model) is kept.
 */
function sessionsOf(snapshot, { limit = SESSION_LIMIT } = {}) {
  const listed = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const projects = new Map()
  for (const project of Array.isArray(snapshot?.catalog?.workspaces) ? snapshot.catalog.workspaces : [])
    if (listed(project) && typeof project.id === 'string' && PROJECT_ID.test(project.id) && project.id !== 'default') {
      const name = attentionTitle(project.name)
      if (name) projects.set(project.id, name)
    }
  const items = []
  for (const task of Array.isArray(snapshot?.tasks) ? snapshot.tasks : []) {
    if (!listed(task) || typeof task.id !== 'string' || !SESSION_ID.test(task.id)) continue
    if (task.archived === true || task.agent || task.generalChat === true) continue
    const updated = stamp(task.updatedAt)
    if (updated === undefined) continue
    const status =
      task.status === 'waiting-approval' || task.pendingQuestions > 0
        ? 'waiting'
        : task.status === 'running'
          ? 'running'
          : task.status === 'failed'
            ? 'failed'
            : 'idle'
    const projectName = typeof task.workspaceId === 'string' ? projects.get(task.workspaceId) : undefined
    items.push({
      taskId: task.id,
      title: attentionTitle(task.title),
      status,
      updatedAt: new Date(updated).toISOString(),
      ...(projectName ? { project: { id: task.workspaceId, name: projectName } } : {}),
    })
  }
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return items.slice(0, limit)
}
/** The per-Agent switch each kind of notification answers to (CustomAgent.notifications). */
const AGENT_SETTING = Object.freeze({ completion: 'completed', failure: 'failed', approval: 'waiting', question: 'waiting' })
/**
 * Whether an Agent turned this kind of notification off, from the same authenticated snapshot: a session is the Agent's
 * when it is one of its topics, or a run of one of its schedules. Anything not shaped as expected leaves it on.
 */
function agentSilenced(snapshot) {
  const listed = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const settings = new Map()
  for (const agent of Array.isArray(snapshot?.customAgents) ? snapshot.customAgents : [])
    if (listed(agent) && typeof agent.id === 'string' && listed(agent.notifications)) settings.set(agent.id, agent.notifications)
  const owners = new Map()
  for (const automation of Array.isArray(snapshot?.automations) ? snapshot.automations : [])
    if (listed(automation) && typeof automation.id === 'string' && typeof automation.customAgentId === 'string')
      owners.set(automation.id, automation.customAgentId)
  return (task, kind) => {
    const own = listed(task.agent) && typeof task.agent.customAgentId === 'string' ? task.agent.customAgentId : undefined
    const owner = own ?? (typeof task.automationId === 'string' ? owners.get(task.automationId) : undefined)
    const setting = owner === undefined ? undefined : settings.get(owner)
    return setting !== undefined && setting[AGENT_SETTING[kind]] === false
  }
}
/** A name as two names are compared: NFKC, nothing invisible, case folded, so look-alikes count as one. */
function sameName(value) {
  return String(value).normalize('NFKC').replace(INVISIBLE, '').toLowerCase()
}
/** How many sessions 等你处理 lists (attentionOf); the Dock counts these. */
function waitingCount(snapshot) {
  return attentionOf(snapshot, { limit: 0 }).count
}
/**
 * Only authenticated Host snapshots decide notification contents; the renderer never supplies text. This Mac's Host is
 * read by `poll`; another computer's snapshots arrive through `observeRemote` (computers.cjs reads them), each compared
 * with that computer's own previous one, under the same preferences, with its name before the title.
 */
function createNotifications(options) {
  let polling = false,
    closed = false,
    state = fresh(),
    writes = Promise.resolve()
  /** The previous snapshot of each source: `local`, or a remote computer's hostId. */
  const previous = new Map()
  const last = new Map(),
    now = options.now ?? Date.now
  const view = () => ({
    ...state.preferences,
    supported: options.supported(),
    consent: state.consent,
  })
  const change = make => {
    if (closed) return Promise.resolve(undefined)
    const pending = writes
      .catch(() => {})
      .then(async () => {
        const next = make(state)
        if (JSON.stringify(next) !== JSON.stringify(state)) {
          await options.save?.(next)
          state = next
          try {
            if (!closed) options.changed?.(view())
          } catch {
            /* A closed window cannot undo a durable preference. */
          }
        }
        return view()
      })
    writes = pending.then(
      () => {},
      () => {},
    )
    return pending
  }
  const notify = (source, task, kind, silenced) => {
    if (silenced(task, kind)) return
    const setting = kind === 'failure' ? 'completion' : kind === 'question' ? 'approval' : kind
    const key = `${source.key}\u0000${task.id}`
    if (closed || options.focused() || !options.supported() || !state.preferences[setting] || now() - (last.get(key) ?? -Infinity) < 10_000)
      return
    last.set(key, now())
    const body = kind === 'approval' || kind === 'question' || kind === 'failure' ? COPY[kind] : COPY.completion
    // Nothing invisible survives (a bidi override could make one computer's line read as another's).
    const named = state.preferences.title ? attentionTitle(task.title, 120) || COPY.untitled : 'Latch'
    // Another computer's name leads the title; this Mac's notifications have none.
    const title = source.name ? `${source.name} · ${named}` : named
    options.show({ title, body, onClick: () => source.open(task.id) })
  }
  /** Compares a source's snapshot with its previous one; the first only sets the baseline. */
  async function observe(source, snapshot) {
    const current = new Map(snapshot.tasks.map(task => [task.id, { ...task }]))
    const before = previous.get(source.key)
    const silenced = agentSilenced(snapshot)
    if (before) {
      for (const task of snapshot.tasks) {
        const earlier = before.tasks.get(task.id)
        if (!earlier || !['running', 'waiting-approval'].includes(earlier.status)) continue
        const outcome =
          task.status === 'failed' || (task.status === 'idle' && task.runOutcome === 'failed')
            ? 'failure'
            : task.status === 'idle' && (task.runOutcome === undefined || task.runOutcome === 'completed')
              ? 'completion'
              : undefined
        if (!outcome || silenced(task, outcome)) continue
        // The first real ending seen in the background turns notifications on; the OS asks on the first one shown.
        if (!options.focused() && options.supported() && state.consent === 'unasked')
          await change(value =>
            value.consent === 'unasked'
              ? { ...value, preferences: { ...value.preferences, completion: true, approval: true }, consent: 'accepted' }
              : value,
          )
        notify(source, task, outcome, silenced)
      }
      for (const approval of snapshot.approvals)
        if (!before.approvals.has(approval.id)) {
          const task = current.get(approval.sessionId)
          if (task) notify(source, task, 'approval', silenced)
        }
      // A new question from the agent waits for the person as a request does; the list says only how many there are.
      for (const task of snapshot.tasks) {
        const asked = Number.isSafeInteger(task.pendingQuestions) ? task.pendingQuestions : 0
        const earlier = before.tasks.get(task.id)?.pendingQuestions
        if (asked > (Number.isSafeInteger(earlier) ? earlier : 0)) notify(source, task, 'question', silenced)
      }
    }
    previous.set(source.key, { tasks: current, approvals: new Set(snapshot.approvals.map(item => item.id)) })
    const prefix = `${source.key}\u0000`
    for (const key of last.keys()) if (key.startsWith(prefix) && !current.has(key.slice(prefix.length))) last.delete(key)
  }
  const valid = snapshot =>
    snapshot
    && Array.isArray(snapshot.tasks)
    && Array.isArray(snapshot.approvals)
    && snapshot.tasks.every(task => task !== null && typeof task === 'object' && typeof task.id === 'string')
    && snapshot.approvals.every(item => item !== null && typeof item === 'object')
  return {
    configure(value) {
      const next = record(value)
      if (!next) return false
      state = next
      return true
    },
    view,
    set(value) {
      if (!validPreferences(value)) return Promise.resolve(undefined)
      const preferences = { ...value }
      return change(current => ({
        ...current,
        preferences,
        consent: 'accepted',
      }))
    },
    async poll() {
      if (polling || closed) return
      polling = true
      try {
        const snapshot = await options.snapshot()
        if (closed || !valid(snapshot)) return
        options.badge?.(waitingCount(snapshot))
        await observe({ key: 'local', open: id => options.open(id) }, snapshot)
      } catch {
        /* A disconnected Host or failed preference write cannot authorize a new notification. */
      } finally {
        polling = false
      }
    },
    /**
     * Another computer's authenticated snapshot, read by main (computers.cjs). `name` is how the list names it; a click
     * opens that computer's window on the session.
     */
    async observeRemote(hostId, name, snapshot) {
      if (closed || typeof hostId !== 'string' || !valid(snapshot)) return
      try {
        const shown = attentionTitle(name) || COPY.otherComputer
        await observe({ key: `h-${hostId}`, name: shown, open: id => options.openRemote?.(hostId, id) }, snapshot)
      } catch {
        /* A failed preference write cannot authorize a new notification. */
      }
    },
    /** A removed computer: its baseline goes, so adding it again starts from a fresh one. */
    forgetRemote(hostId) {
      const key = `h-${hostId}`
      previous.delete(key)
      for (const id of last.keys()) if (id.startsWith(`${key}\u0000`)) last.delete(id)
    },
    async close() {
      closed = true
      await writes
    },
  }
}
/** No notification IPC accepts text, paths, arbitrary IDs or a secondary-frame sender. */
function handleNotificationRequests({ ipcMain, trusted, controller }) {
  ipcMain.handle('latch:notifications:get', event => (trusted(event) ? controller.view() : undefined))
  ipcMain.handle('latch:notifications:set', (event, input) => (trusted(event) ? controller.set(input) : undefined))
}
module.exports = {
  createNotifications,
  readPreferences,
  writePreferences,
  validPreferences,
  handleNotificationRequests,
  attentionOf,
  sessionsOf,
  SESSION_LIMIT,
  agentSilenced,
  attentionTitle,
  sameName,
  waitingCount,
  ATTENTION_LIMIT,
}
