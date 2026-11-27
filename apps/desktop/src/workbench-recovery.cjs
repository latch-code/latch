'use strict'

const { isAppUrl } = require('./proxy.cjs')

const RETRY_INTERVAL_MS = 60_000
const RETRY_DELAY_MS = 200

/**
 * Restore the document in the same WebContents. The target is fixed by main when it sets the window's Host, and
 * loadURL performs a new GET. Chromium's reload of its last navigation could resubmit a form.
 * @param {Pick<import('electron').WebContents, 'on' | 'once' | 'isCrashed' | 'isDestroyed' | 'loadURL'>} contents
 * @param {{ url: string, active: () => boolean, offerReload: (signal: AbortSignal) => Promise<'reload' | 'start' | undefined>,
 *   discardUnselected?: () => boolean, log: (message: string) => void }} options
 */
function createWorkbenchRecovery(contents, { url, active, offerReload, discardUnselected, log }) {
  const home = new URL(url).hostname
  /** @type {NodeJS.Timeout | undefined} */
  let pending
  /** @type {AbortController | undefined} */
  let prompt
  let prompted = false
  let failed = false
  let recovering = false
  let retryAfter = 0

  function cancelPrompt() {
    const previous = prompt
    prompt = undefined
    previous?.abort()
  }

  function reset() {
    clearTimeout(pending)
    pending = undefined
    failed = false
    prompted = false
    cancelPrompt()
  }

  function load({ recovery = false, start = false } = {}) {
    if (contents.isDestroyed()) return
    reset()
    recovering = recovery
    return contents.loadURL(start ? `${url}?recovery=start` : url)
  }

  function update() {
    if (!active()) {
      cancelPrompt()
      return
    }
    if (!failed || prompt || prompted || contents.isDestroyed()) return
    const request = (prompt = new AbortController())
    void offerReload(request.signal).then(
      choice => {
        if (request !== prompt) return
        prompt = undefined
        prompted = true
        if (choice && active() && failed) void load({ recovery: true, start: choice === 'start' })?.catch(() => {})
      },
      () => {
        if (request === prompt) prompt = undefined
      },
    )
  }

  function reportFailure(reason) {
    if (contents.isDestroyed() || pending || failed) return
    log(`工作台页面故障（${reason}）。`)
    if (discardUnselected?.()) return
    if (recovering || Date.now() < retryAfter) {
      failed = true
      update()
      return
    }
    pending = setTimeout(() => {
      pending = undefined
      if (contents.isDestroyed()) return
      if (discardUnselected?.()) return
      retryAfter = Date.now() + RETRY_INTERVAL_MS
      void load({ recovery: true })?.catch(() => {})
    }, RETRY_DELAY_MS)
    pending.unref()
  }

  contents.on('render-process-gone', (_event, details) => reportFailure(details.reason))
  contents.on('did-fail-load', (_event, code, _message, target, mainFrame) => {
    if (code !== -3 && mainFrame && isAppUrl(target, home)) reportFailure(`load ${code}`)
  })
  contents.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument && isAppUrl(event.url, home)) reset()
  })
  contents.on('did-finish-load', () => {
    recovering = false
  })
  contents.once('destroyed', reset)

  return {
    load,
    update,
    /** Let the native Reload command reach the bound page even when there is no renderer or focused frame. */
    reloadFailed() {
      if (contents.isDestroyed() || (!failed && !pending && !recovering && !contents.isCrashed())) return false
      void load({ recovery: true })?.catch(() => {})
      return true
    },
  }
}

module.exports = { createWorkbenchRecovery }
