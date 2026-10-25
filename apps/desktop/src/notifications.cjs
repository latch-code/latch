'use strict'
const { readFile, mkdir, writeFile, rename } = require('node:fs/promises')
const { join } = require('node:path')
const DEFAULTS = Object.freeze({ completion: false, approval: false, title: false })
function validPreferences(value) {
  return (
    value !== null
    && typeof value === 'object'
    && Object.keys(value).every(key => ['completion', 'approval', 'title'].includes(key))
    && ['completion', 'approval', 'title'].every(key => typeof value[key] === 'boolean')
  )
}
async function readPreferences(directory) {
  try {
    const value = JSON.parse(await readFile(join(directory, 'notifications.json'), 'utf8'))
    return validPreferences(value) ? value : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}
async function writePreferences(directory, value) {
  if (!validPreferences(value)) throw new Error('invalid-notification-preferences')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'notifications.json'),
    temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, path)
}
/** Only authenticated Host snapshots decide notification contents; the renderer never supplies text. */
function createNotifications(options) {
  let previous,
    polling = false,
    settings = { ...DEFAULTS },
    consent = false
  const last = new Map(),
    now = options.now ?? Date.now
  const notify = (task, kind) => {
    if (options.focused() || !settings[kind] || now() - (last.get(task.id) ?? -Infinity) < 10_000) return
    last.set(task.id, now())
    const body = kind === 'approval' ? '有一个请求等你处理。' : '一个会话已完成。'
    const title = settings.title
      ? String(task.title || '未命名会话')
          .replace(/[\u0000-\u001f\u007f]/gu, '')
          .slice(0, 120)
      : 'Latch'
    options.show({ title, body, onClick: () => options.open(task.id) })
  }
  return {
    configure(value) {
      if (!validPreferences(value)) return false
      settings = { ...value }
      return true
    },
    view() {
      return { ...settings, supported: options.supported(), needsConsent: consent }
    },
    async poll() {
      if (polling) return
      polling = true
      try {
        const snapshot = await options.snapshot()
        if (!snapshot || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.approvals)) return
        options.badge(snapshot.approvals.length)
        const current = new Map(snapshot.tasks.map(task => [task.id, { ...task }]))
        if (previous) {
          for (const task of snapshot.tasks) {
            const before = previous.tasks.get(task.id)
            if (before && ['running', 'waiting-approval'].includes(before.status) && task.status === 'idle') {
              if (!options.focused() && !settings.completion) consent = true
              notify(task, 'completion')
            }
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
        /* A disconnected Host cannot authorize a notification. */
      } finally {
        polling = false
      }
    },
  }
}
module.exports = { createNotifications, readPreferences, writePreferences, validPreferences }
