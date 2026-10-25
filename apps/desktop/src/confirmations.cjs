'use strict'
const { createHash } = require('node:crypto')
const { canonicalJson } = require('./credentials.cjs')

const CONFIRMATION = /^cfm_[A-Za-z0-9_-]{22}$/
const HASH = /^[a-f0-9]{64}$/
const ACTIONS = new Set(['task.start-l3', 'task.mode-widen', 'approval.r2'])
const failure = code => ({ status: 'failed', code })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Main reads the Host's content itself; the renderer supplies only a ticket ID, never any displayed text. */
function createConfirmationActions({ request, sign, identity, focused, gate, confirm, now = Date.now }) {
  return {
    async confirm(id) {
      if (typeof id !== 'string' || !CONFIRMATION.test(id)) return failure('invalid')
      if (!focused()) return failure('not-focused')
      if (!gate.enter()) return { status: 'busy' }
      const path = `/link/api/confirmations/${encodeURIComponent(id)}`
      try {
        const who = identity()
        if (!who) return failure('unauthorized')
        const result = await request('GET', `${path}/shell`)
        if (result.status !== 200) return failure(result.json?.error ?? 'confirmation-failed')
        const preview = result.json?.preview
        const previewHash = result.json?.previewHash
        if (
          !plain(preview)
          || preview.v !== 2
          || preview.hostId !== who.hostId
          || !ACTIONS.has(preview.action)
          || preview.requester?.deviceId !== who.deviceId
          || preview.requester?.listener !== 'unix'
          || typeof preview.reason !== 'string'
          || !preview.reason
          || !Array.isArray(preview.lines)
          || !preview.lines.every(line => plain(line) && typeof line.label === 'string' && typeof line.value === 'string')
          || !Array.isArray(preview.warnings)
          || !preview.warnings.every(warning => typeof warning === 'string')
          || typeof previewHash !== 'string'
          || !HASH.test(previewHash)
        )
          return failure('confirmation-mismatch')
        const canonical = canonicalJson(preview)
        if (Buffer.byteLength(canonical) > 64 * 1024 || createHash('sha256').update(canonical).digest('hex') !== previewHash)
          return failure('confirmation-mismatch')
        const expiresAt = Date.parse(preview.expiresAt)
        if (!Number.isFinite(expiresAt) || now() >= expiresAt) return failure('confirmation-expired')
        if (!focused()) return failure('not-focused')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.max(0, expiresAt - now()))
        timer.unref?.()
        // Closing the page or cancelling its ticket also closes the system sheet; a transport failure fails closed.
        let checking = false
        const poll = setInterval(() => {
          if (checking || controller.signal.aborted) return
          checking = true
          void request('GET', path)
            .then(
              result => {
                if (result.status !== 200 || result.json?.confirmation?.id !== id || result.json.confirmation.status !== 'pending')
                  controller.abort()
              },
              () => controller.abort(),
            )
            .finally(() => {
              checking = false
            })
        }, 500)
        poll.unref?.()
        let answer
        try {
          answer = await confirm({
            type: 'warning',
            title: 'Latch · 本机确认',
            message: preview.reason,
            detail: [...preview.lines.map(line => `${line.label}：${line.value}`), ...preview.warnings].join('\n'),
            buttons: ['取消', '允许'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
          clearInterval(poll)
        }
        if (controller.signal.aborted) return failure('confirmation-expired')
        if (answer.response !== 1) {
          await request('DELETE', path).catch(() => {})
          return { status: 'cancelled' }
        }
        const current = identity()
        if (!focused() || !current || current.hostId !== who.hostId || current.deviceId !== who.deviceId) return failure('unauthorized')
        if (now() >= expiresAt) return failure('confirmation-expired')
        // Cancellation never signs anything: a signed rejection cannot be reinterpreted as an approval.
        const signature = sign(id, previewHash)
        const approved = await request('POST', `${path}/shell`, { previewHash, signature })
        return approved.status === 200 && approved.json?.confirmation?.status === 'approved'
          ? { status: 'confirmed' }
          : failure(approved.json?.error ?? 'confirmation-failed')
      } catch {
        return failure('confirmation-failed')
      } finally {
        gate.leave()
      }
    },
  }
}

module.exports = { createConfirmationActions }
