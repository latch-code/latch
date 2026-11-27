'use strict'

const { workAgents } = require('./computers.cjs')
const { readRequestBody } = require('./proxy.cjs')
const { defineCopy } = require('./locale.cjs')

const ITEM = /^itm_[A-Za-z0-9_-]{22}$/u
const POST = /^pst_[A-Za-z0-9_-]{22}$/u
const HOST = /^[a-z2-7]{52}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const DEVICE = /^dev_[A-Za-z0-9_-]{22}$/u
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const RETRY_WINDOW = 7 * 24 * 60 * 60 * 1000
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const STATUS = new Set(['unknown', 'running', 'waiting-approval', ...TERMINAL])
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value)
const agent = value => typeof value === 'string' && value.startsWith('agt_') && UUID.test(value.slice(4))
const validText = text => typeof text === 'string' && text.length > 0 && text.length <= 4000 && text.trim() === text
const validTarget = value => value && agent(value.customAgentId) && matches(HOST, value.hostId) && agent(value.agentId)
const sameTarget = (a, b) => a.hostId === b.hostId && a.agentId === b.agentId && a.customAgentId === b.customAgentId
const copy = defineCopy(
  {
    forbidden: '请在本机待办中操作。',
    gesture: '请点按待办里的操作按钮。',
    invalid: '这条委托无效，请重新打开待办。',
    source: '本机待办或工作电脑绑定已变化，请刷新待办。',
    unavailable: '无法核对工作电脑的连接、设备权限或助手，请检查连接与配置。',
    unknown: '尚未确认发送结果。请刷新状态，或重试同一条委托。',
    expired: '已超过七天的安全重试期限，请在目标电脑核对原消息。',
    missing: '目标电脑尚无可打开的这次委托记录。',
    removed: '工作电脑已移除这条委托的记录，请到目标电脑核对。',
  },
  {
    forbidden: 'Use the work item on this computer.',
    gesture: 'Click the action on the work item.',
    invalid: 'This delegation is invalid. Reopen the work item.',
    source: 'The work item or its computer binding changed. Refresh the work item.',
    unavailable: 'Check the work computer connection, its device permissions and the selected assistant.',
    unknown: 'Delivery is unconfirmed. Refresh the status or retry the same delegation.',
    expired: 'The seven-day retry window has passed. Check the original message on the work computer.',
    missing: 'The work computer has no conversation to open for this delegation yet.',
    removed: 'The work computer removed this delegation’s receipt. Check the conversation there.',
  },
)
const fail = (error, message) => ({ ok: false, error, message })

/** @param {object} [body] */
async function mentionRequest(proxy, hostId, method, suffix, body, timeoutMs = 30_000) {
  const url = 'latch://h-' + hostId + '/link/api/custom-agents/general/mentions' + suffix
  const response = await proxy.handle(
    new Request(url, {
      method,
      headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    AbortSignal.timeout(timeoutMs),
  )
  // The target controls the HTTPS response. Only the bounded receipt fields below can enter the source Host.
  const bytes = await readRequestBody(response, 256 * 1024)
  const json = bytes && JSON.parse(bytes.toString('utf8'))
  return { status: response.status, json }
}

/** Match the exact destination turn before accepting any of its references, including after a lost POST response. */
function evidence(receipt, mention) {
  const remote = receipt.post.remote
  if (
    mention?.requestId !== receipt.dispatchId
    || mention.initiator !== 'person'
    || mention.sourceAgentId !== 'general'
    || mention.text !== receipt.post.text
    || mention.targetAgentId !== remote.agentId
    || !matches(UUID, mention.id)
    || (remote.mentionId && remote.mentionId !== mention.id)
  )
    return undefined
  const status = mention.status === 'sending' ? 'unknown' : mention.status
  const sessionId = mention.targetSessionId
  const messageId = TERMINAL.has(status) ? mention.reply?.messageId : undefined
  if (
    !STATUS.has(status)
    || (sessionId !== undefined && !matches(REF, sessionId))
    || (remote.sessionId && remote.sessionId !== sessionId)
    || (messageId !== undefined && !matches(REF, messageId))
    || (remote.messageId && remote.messageId !== messageId)
  )
    return undefined
  return { status, mentionId: mention.id, ...(sessionId ? { sessionId } : {}), ...(messageId ? { messageId } : {}) }
}

/** A foreground action has one source device, one destination enrollment, and one request id for its lifetime. */
function createWorkDelegationHandler({ senderOf, gestureOf, localRequest, proxyFor, confirm, openSession, now = Date.now }) {
  return async (event, action, itemId, input) => {
    const frame = event.senderFrame
    const current = () => frame && event.senderFrame === frame && senderOf(event)?.kind === 'full'
    const invalid = () => fail('invalid', copy.invalid)
    const changed = () => fail('source-changed', copy.source)
    const unavailable = () => fail('work-computer-unavailable', copy.unavailable)
    if (!current()) return fail('forbidden', copy.forbidden)
    if (!matches(ITEM, itemId) || !['delegate', 'retry', 'refresh', 'open'].includes(action)) return invalid()
    const initial = action === 'delegate'
    const writing = initial || action === 'retry'
    if (
      initial
        ? !validTarget(input) || !validText(input.text) || !matches(/^[A-Za-z0-9_-]{8,128}$/u, input.requestId)
        : !matches(POST, input)
    )
      return invalid()
    if (action !== 'refresh' && !gestureOf(event)) return fail('gesture-required', copy.gesture)
    const posts = '/link/api/work/items/' + itemId + '/posts'
    try {
      let receipt
      let path
      if (!initial) {
        path = posts + '/' + input + '/remote'
        const read = await localRequest('GET', path + (writing ? '?dispatch=1' : ''))
        if (read.status !== 200 || read.json?.post?.id !== input) return changed()
        receipt = read.json
      }
      const target = initial ? input : receipt.post.remote
      if (!validTarget(target) || !current()) return changed()
      const { hostId, agentId } = target
      const text = initial ? input.text : receipt.post.text
      const proxy = proxyFor(hostId)
      const stillHere = () => current() && proxy && proxyFor(hostId) === proxy
      if (!validText(text)) return invalid()
      const probe = writing && proxy ? await proxy.probe() : undefined
      if (!current() || proxyFor(hostId) !== proxy) return changed()
      const snapshot = probe?.state === 'online' ? probe.snapshot : undefined
      const agents = workAgents(snapshot, hostId)
      const destination = agents?.find(entry => entry.id === agentId)
      const online = !!agents && matches(DEVICE, snapshot.device.id) && snapshot.catalog.features.agentMentionLookup === true
      if (writing) {
        if (!(await confirm({ hostId, agentId, agentName: destination?.name, text }))) return fail('cancelled', '')
        if (!current() || proxyFor(hostId) !== proxy) return changed()
      }
      if (initial) {
        const { requestId, customAgentId } = input
        const reserved = await localRequest('POST', posts + '/remote', { requestId, text, customAgentId, hostId, agentId })
        const code = reserved.json?.error
        if (reserved.status === 400 || reserved.status === 422) {
          // Trusted source validation rejected these words before creating a new post. Keep the draft editable.
          if (['agent-mention-secret', 'agent-mention-reference', 'post-secret', 'post-invalid'].includes(code))
            return fail(code, copy.invalid)
        }
        if (reserved.status === 409 && code === 'thread-full') return fail(code, '')
        if (reserved.status >= 500) return fail('delivery-unknown', copy.unknown)
        if (reserved.status < 200 || reserved.status >= 300 || !matches(POST, reserved.json?.post?.id)) return changed()
        receipt = reserved.json
        path = posts + '/' + receipt.post.id + '/remote'
      }
      const postId = receipt.post.id
      const { dispatchId } = receipt
      const check = row =>
        row?.dispatchId === dispatchId
        && matches(UUID, dispatchId)
        && row.post?.id === postId
        && row.post.text === text
        && row.post.remote
        && sameTarget(row.post.remote, target)
      if (!check(receipt)) return changed()
      const reload = async (dispatch = false) => {
        const read = await localRequest('GET', path + (dispatch ? '?dispatch=1' : ''))
        if (read.status !== 200 || !check(read.json) || !current()) return false
        receipt = read.json
        return true
      }
      const patch = async fields => {
        const before = receipt.post.remote
        if (Object.entries(fields).every(([key, value]) => before[key] === value)) return true
        if (!current()) return false
        const result = await localRequest('PATCH', path, { baseRevision: before.revision, ...fields })
        if (result.status !== 200 || !check({ dispatchId, post: result.json?.post })) return false
        receipt = { dispatchId, post: result.json.post }
        return true
      }
      if ((writing && !online) || !stillHere()) {
        // Losing the connection says nothing about a submission already attempted or a turn already seen.
        if (writing && current() && !snapshot && receipt.post.remote.status === 'prepared') await patch({ status: 'offline' })
        return unavailable()
      }
      // Reading one result uses only its exact, authorized receipt. No full snapshot or target roster on polling.
      const deviceId = proxy.deviceId()
      const sameDevice = () => stillHere() && proxy.deviceId() === deviceId
      if (
        !matches(DEVICE, deviceId)
        || (writing && deviceId !== snapshot.device.id)
        || (receipt.post.remote.deviceId && receipt.post.remote.deviceId !== deviceId)
      )
        return unavailable()
      if (!receipt.post.remote.deviceId) {
        if (!writing) return fail('no-receipt', copy.missing)
        if (!destination || !(await reload(true)) || !sameDevice() || !(await patch({ status: 'prepared', deviceId }))) return changed()
      }
      const readMention = () => mentionRequest(proxy, hostId, 'GET', '/by-request/' + dispatchId)
      const present = async mention => {
        const values = evidence(receipt, mention)
        if (!values || !sameDevice() || !(await patch(values))) return changed()
        if (action === 'open') {
          if (!values.sessionId || !sameDevice() || !(await reload()) || !sameDevice()) return fail('no-receipt', copy.missing)
          const anchor = values.messageId ?? mention.targetMessageId
          return openSession(hostId, values.sessionId, matches(REF, anchor) ? anchor : undefined)
        }
        return { ok: true }
      }
      const lookup = await readMention()
      if (!sameDevice()) return unavailable()
      let mayRetryUnknown = false
      if (lookup.status === 200) {
        if (!evidence(receipt, lookup.json)) return changed()
        mayRetryUnknown = writing && lookup.json.status === 'unknown' && lookup.json.canRetry === true
        if (!mayRetryUnknown) return await present(lookup.json)
      } else if (lookup.status !== 404 || lookup.json?.error !== 'agent-mention-missing') return unavailable()
      if (!writing) return fail('no-receipt', copy.missing)
      if (!destination || !(await reload(true)) || !sameDevice() || receipt.post.remote.deviceId !== deviceId) return changed()
      const prior = receipt.post.remote
      if (TERMINAL.has(prior.status) || prior.sessionId || (prior.mentionId && !mayRetryUnknown)) return fail('no-receipt', copy.missing)
      const timeLeft = () => {
        const age = now() - Date.parse(receipt.post.at)
        return Number.isFinite(age) && age >= 0 ? RETRY_WINDOW - age : 0
      }
      if (timeLeft() <= 0) return fail('retry-expired', copy.expired)
      const checked = await proxy.probe()
      const live = checked?.state === 'online' && checked.snapshot
      if (
        !live
        || !sameDevice()
        || live.device?.id !== deviceId
        || live.catalog?.features?.agentMentionLookup !== true
        || !workAgents(live, hostId)?.some(entry => entry.id === agentId && entry.name === destination.name)
      )
        return unavailable()
      // Persist uncertainty before putting a byte on the wire, so a crash also recovers through the same lookup.
      if (!(await patch({ status: 'unknown' })) || !sameDevice()) return changed()
      if (!(await reload(true)) || !sameDevice() || receipt.post.remote.status !== 'unknown' || receipt.post.remote.deviceId !== deviceId)
        return changed()
      // The second probe and source recheck can span the deadline. Bound the HTTPS handshake and credential renewal too.
      const timeoutMs = Math.min(30_000, timeLeft())
      if (timeoutMs <= 0) return fail('retry-expired', copy.expired)
      const sent = await mentionRequest(
        proxy,
        hostId,
        'POST',
        '?receipt=reference',
        {
          requestId: dispatchId,
          target: { kind: 'agent', customAgentId: agentId },
          text,
        },
        timeoutMs,
      ).catch(() => undefined)
      if (!sameDevice()) return unavailable()
      if (sent && sent.status >= 200 && sent.status < 300) return await present(sent.json)
      const recovered = await readMention()
      if (recovered.status === 200) return await present(recovered.json)
      const missing = sameDevice() && recovered.status === 404 && recovered.json?.error === 'agent-mention-missing'
      if (missing && sent?.status === 409 && sent.json?.error === 'agent-mention-expired')
        return fail('remote-receipt-removed', copy.removed)
      // Only a definite pre-acceptance refusal plus a missing receipt can close the attempt.
      if (missing && (prior.status === 'prepared' || prior.status === 'offline') && sent && [400, 403, 404, 422].includes(sent.status)) {
        await patch({ status: 'failed' })
        return fail('not-delivered', copy.unavailable)
      }
      return fail('delivery-unknown', copy.unknown)
    } catch {
      return fail('delivery-unknown', copy.unknown)
    }
  }
}

module.exports = { createWorkDelegationHandler }
