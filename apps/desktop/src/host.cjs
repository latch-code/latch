'use strict'
// Host discovery for the Electron shell. Mirrors the checks of apps/host/src/host-state.ts in CommonJS,
// because the Electron main process loads plain .cjs files and cannot import the TypeScript sources.
const { request } = require('node:http')
const { lstat, readFile } = require('node:fs/promises')
const { dirname, isAbsolute } = require('node:path')

const HOST_ID = /^[a-z2-7]{52}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_KEYS = ['version', 'pid', 'hostId', 'instanceId', 'socketPath', 'loopbackOrigin', 'tlsOrigin', 'startedAt', 'dataDir']
const SOCKET_HOST = 'latch.unix'
const INFO_LIMIT = 64 * 1024

function isUrl(value) {
  if (typeof value !== 'string') return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/** Strict parse of host.json v2. Unknown members, like zod's `.strict()`, make the file invalid. */
function parseHostState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const keys = Object.keys(value)
  if (keys.some(key => !STATE_KEYS.includes(key))) return undefined
  if (value.version !== 2) return undefined
  if (!Number.isInteger(value.pid) || value.pid <= 0) return undefined
  if (typeof value.hostId !== 'string' || !HOST_ID.test(value.hostId)) return undefined
  if (typeof value.instanceId !== 'string' || !UUID.test(value.instanceId)) return undefined
  if (typeof value.socketPath !== 'string' || !isAbsolute(value.socketPath) || value.socketPath.includes('\0')) return undefined
  if (!isUrl(value.loopbackOrigin)) return undefined
  if (value.tlsOrigin !== null && !isUrl(value.tlsOrigin)) return undefined
  if (typeof value.startedAt !== 'string' || typeof value.dataDir !== 'string') return undefined
  return {
    version: 2,
    pid: value.pid,
    hostId: value.hostId,
    instanceId: value.instanceId,
    socketPath: value.socketPath,
    loopbackOrigin: value.loopbackOrigin,
    tlsOrigin: value.tlsOrigin,
    startedAt: value.startedAt,
    dataDir: value.dataDir,
  }
}

/** Returns the parsed state, or undefined when the file is missing or malformed. */
async function readHostStateFile(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return parseHostState(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * One HTTP/1.1 request over host.sock. Resolves once response headers arrive; the caller owns the body.
 * `timeoutMs` bounds the wait for response headers only, so long-lived streams are not cut.
 * @param {string} socketPath
 * @param {{ method?: string, path?: string, headers?: Record<string, string>, body?: Buffer, bodyStream?: ReadableStream<Uint8Array>, bodyLimit?: number, check?: () => void, signal?: AbortSignal, timeoutMs?: number }} [options]
 */
function socketRequest(socketPath, { method = 'GET', path, headers = {}, body, ...rest } = {}) {
  const outgoing = { ...headers, host: SOCKET_HOST }
  if (body !== undefined) outgoing['content-length'] = String(body.length)
  return exchange(() => request({ socketPath, method, path, headers: outgoing }), { body, ...rest })
}

/**
 * Sends one request that `open()` creates (Node's http or https `ClientRequest`, not yet ended) and resolves with it and
 * its response once the headers arrive. The body is a Buffer, or a stream bounded by `bodyLimit` that `check` may stop.
 * @param {() => import('node:http').ClientRequest} open
 * @param {{ body?: Buffer, bodyStream?: ReadableStream<Uint8Array>, bodyLimit?: number, check?: () => void, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{ request: import('node:http').ClientRequest, response: import('node:http').IncomingMessage }>}
 */
function exchange(open, { body, bodyStream, bodyLimit, check, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let req
    try {
      req = open()
    } catch (error) {
      reject(error)
      return
    }
    let timer
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => req.destroy(Object.assign(new Error('Latch 服务响应超时'), { code: 'ETIMEDOUT' })), timeoutMs)
    }
    const reader = bodyStream?.getReader()
    let responded = false
    const abort = () => {
      req.destroy(new Error('Latch upload cancelled'))
      void reader?.cancel().catch(() => {})
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    req.once('close', () => signal?.removeEventListener('abort', abort))
    req.once('response', response => {
      responded = true
      void reader?.cancel().catch(() => {})
      if (timer) clearTimeout(timer)
      resolve({ request: req, response })
    })
    req.once('error', error => {
      if (timer) clearTimeout(timer)
      void reader?.cancel().catch(() => {})
      reject(error)
    })
    if (reader) {
      void (async () => {
        let size = 0
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done || responded) break
            check?.()
            size += chunk.value.byteLength
            if (typeof bodyLimit !== 'number' || !Number.isSafeInteger(bodyLimit) || size > bodyLimit)
              throw Object.assign(new Error('请求内容过长'), { status: 413, code: 'body-too-large' })
            if (!req.write(Buffer.from(chunk.value))) {
              const drained = await new Promise(resolve => {
                const close = () => {
                    req.off('drain', drain)
                    resolve(false)
                  },
                  drain = () => {
                    req.off('close', close)
                    resolve(true)
                  }
                req.once('close', close)
                req.once('drain', drain)
              })
              if (!drained) return
            }
            check?.()
          }
          if (!req.destroyed) req.end()
        } catch (error) {
          void reader.cancel().catch(() => {})
          if (!responded) req.destroy(error instanceof Error ? error : new Error('Latch upload failed'))
        }
      })()
    } else req.end(body)
  })
}

/** Reads a whole response body, refusing anything larger than `limit` bytes. */
function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = error => {
      if (!settled) {
        settled = true
        reject(error)
      }
    }
    stream.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new Error('Latch 服务响应过大'))
        stream.destroy()
        return
      }
      chunks.push(chunk)
    })
    stream.once('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
    stream.once('error', fail)
    stream.once('close', () => fail(new Error('Latch 服务连接中断')))
  })
}

/** `{ running, waiting }` with non-negative integer counts, as hostInfoSchema in host-state.ts requires. */
function isActivity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const count = item => Number.isInteger(item) && item >= 0
  return count(value.running) && count(value.waiting)
}

function parseHostInfo(value) {
  if (!value || typeof value !== 'object') return undefined
  if (value.product !== 'Latch' || typeof value.hostId !== 'string' || typeof value.instanceId !== 'string') return undefined
  if (!Number.isInteger(value.pid) || typeof value.devMode !== 'boolean') return undefined
  // Optional, as in host-state.ts: running sessions and waiting approvals, which the desktop app keeps the Mac awake for.
  if (value.activity !== undefined && !isActivity(value.activity)) return undefined
  // Optional too: the Host API version, which the updater compares with a release's bundled Host (updater.cjs).
  if (value.protocol !== undefined && !(Number.isInteger(value.protocol) && value.protocol > 0)) return undefined
  return value
}

async function queryHostInfo(socketPath, timeoutMs = 2_000) {
  const { request: req, response } = await socketRequest(socketPath, {
    path: '/link/api/host-info',
    headers: { accept: 'application/json' },
    timeoutMs,
  })
  const timer = setTimeout(() => req.destroy(), timeoutMs)
  try {
    const body = await readBody(response, INFO_LIMIT)
    if (response.statusCode !== 200) throw new Error(`host-info 返回 ${response.statusCode}`)
    const info = parseHostInfo(JSON.parse(body.toString('utf8')))
    if (!info) throw new Error('host-info 格式不正确')
    return info
  } finally {
    clearTimeout(timer)
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Checks that host.json still describes a live Host owned by this user:
 * socket dir 0700, not a symlink, owned by uid; socket owned by uid; pid alive;
 * host-info over the socket reports the same pid, hostId and instanceId.
 * Returns `{ ok: true, info }` or `{ ok: false, reason }` (Chinese, for the error page).
 */
async function inspectHostState(state, { timeoutMs = 2_000, uid = /** @type {() => number} */ (process.getuid)() } = {}) {
  const directory = dirname(state.socketPath)
  let stats
  try {
    stats = await lstat(directory)
  } catch {
    return { ok: false, reason: '运行目录不存在' }
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { ok: false, reason: '运行目录不是普通目录' }
  if (stats.uid !== uid) return { ok: false, reason: '运行目录不属于当前用户' }
  if ((stats.mode & 0o077) !== 0) return { ok: false, reason: '运行目录权限不是 0700' }
  try {
    stats = await lstat(state.socketPath)
  } catch {
    return { ok: false, reason: 'host.sock 不存在' }
  }
  if (!stats.isSocket()) return { ok: false, reason: 'host.sock 不是套接字' }
  if (stats.uid !== uid) return { ok: false, reason: 'host.sock 不属于当前用户' }
  if (!isAlive(state.pid)) return { ok: false, reason: 'Host 进程已退出' }
  let info
  try {
    info = await queryHostInfo(state.socketPath, timeoutMs)
  } catch {
    return { ok: false, reason: '无法通过 host.sock 读取 Host 信息' }
  }
  if (info.pid !== state.pid || info.hostId !== state.hostId || info.instanceId !== state.instanceId) {
    return { ok: false, reason: 'host.sock 上的 Host 与 host.json 记录不一致' }
  }
  return { ok: true, info }
}

async function verifyHostState(state, options) {
  const result = await inspectHostState(state, options)
  return result.ok ? result.info : undefined
}

module.exports = {
  SOCKET_HOST,
  parseHostState,
  exchange,
  readHostStateFile,
  socketRequest,
  readBody,
  queryHostInfo,
  inspectHostState,
  verifyHostState,
}
