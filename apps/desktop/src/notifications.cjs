'use strict'
const { constants } = require('node:fs')
const { lstat, mkdir, open, rename, rm } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const { join } = require('node:path')
const DEFAULTS = Object.freeze({ completion: false, approval: false, title: false })
const CONSENTS = new Set(['unasked', 'pending', 'accepted', 'declined'])
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
function validConsent(value) {
  return (
    value !== null
    && typeof value === 'object'
    && Object.keys(value).length === 1
    && Object.hasOwn(value, 'choice')
    && (value.choice === 'enable' || value.choice === 'decline')
  )
}
/** Only authenticated Host snapshots decide notification contents; the renderer never supplies text. */
function createNotifications(options) {
  let previous,
    polling = false,
    closed = false,
    state = fresh(),
    writes = Promise.resolve()
  const last = new Map(),
    now = options.now ?? Date.now
  const view = () => ({
    ...state.preferences,
    supported: options.supported(),
    needsConsent: state.consent === 'pending',
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
  const notify = (task, kind) => {
    const setting = kind === 'failure' ? 'completion' : kind
    if (
      closed
      || options.focused()
      || !options.supported()
      || !state.preferences[setting]
      || now() - (last.get(task.id) ?? -Infinity) < 10_000
    )
      return
    last.set(task.id, now())
    const body = kind === 'approval' ? '有一个请求等你处理。' : kind === 'failure' ? '一个会话失败了。' : '一个会话已完成。'
    const title = state.preferences.title
      ? String(task.title || '未命名会话')
          .replace(/[\u0000-\u001f\u007f]/gu, '')
          .slice(0, 120)
      : 'Latch'
    options.show({ title, body, onClick: () => options.open(task.id) })
  }
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
        consent: preferences.completion || preferences.approval ? 'accepted' : current.consent,
      }))
    },
    respond(value) {
      if (!validConsent(value)) return Promise.resolve(undefined)
      const enabled = value.choice === 'enable'
      return change(current => ({
        ...current,
        preferences: { ...current.preferences, completion: enabled, approval: enabled },
        consent: enabled ? 'accepted' : 'declined',
      }))
    },
    async poll() {
      if (polling || closed) return
      polling = true
      try {
        const snapshot = await options.snapshot()
        if (closed || !snapshot || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.approvals)) return
        options.badge?.(snapshot.approvals.length)
        const current = new Map(snapshot.tasks.map(task => [task.id, { ...task }]))
        if (previous) {
          for (const task of snapshot.tasks) {
            const before = previous.tasks.get(task.id)
            if (!before || !['running', 'waiting-approval'].includes(before.status)) continue
            const outcome =
              task.status === 'failed' || (task.status === 'idle' && task.runOutcome === 'failed')
                ? 'failure'
                : task.status === 'idle' && (task.runOutcome === undefined || task.runOutcome === 'completed')
                  ? 'completion'
                  : undefined
            if (!outcome) continue
            if (!options.focused() && options.supported() && state.consent === 'unasked')
              await change(value => (value.consent === 'unasked' ? { ...value, consent: 'pending' } : value))
            notify(task, outcome)
          }
          for (const approval of snapshot.approvals)
            if (!previous.approvals.has(approval.id)) {
              const task = current.get(approval.sessionId)
              if (task) notify(task, 'approval')
            }
        }
        previous = { tasks: current, approvals: new Set(snapshot.approvals.map(item => item.id)) }
        for (const id of last.keys()) if (!current.has(id)) last.delete(id)
      } catch {
        /* A disconnected Host or failed preference write cannot authorize a new notification. */
      } finally {
        polling = false
      }
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
  ipcMain.handle('latch:notifications:respond', (event, input) => (trusted(event) ? controller.respond(input) : undefined))
}
module.exports = { createNotifications, readPreferences, writePreferences, validPreferences, validConsent, handleNotificationRequests }
