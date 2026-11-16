import type { McpServerLease } from '@latch/sdk'
import { COMPUTER_SHAPE_SOURCE } from './computer-call.ts'

/**
 * `latch-mcp`: MCP over stdio for one of Latch's own servers in one agent process. For a remote address it starts
 * nothing: it relays `initialize`, `tools/list` and `tools/call` to the Host through the gateway (`mcp/remote`), and the
 * Host, the server's only client, records each call, sends it and answers; the server's request headers never reach
 * the agent's side. For a local command: The agent starts it with the Host's
 * own Node, no environment and two paths; at `initialize` it reads its token (from a 0600 file the Host made, deleted
 * once read, as `latch-browser`'s), takes the server's launch from the Host's tool gateway and starts the person's
 * command in a process group of its own, with exactly the environment the Host gave: the agent's variables never reach
 * it. It then passes messages through line by line, changing nothing but:
 *
 * - only `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, cancels and
 *   `notifications/tools/list_changed` pass; the server's own requests (sampling, elicitation, roots) are declined, and
 *   the client's capabilities are not offered;
 * - a local command's prompts pass so a harness that reads MCP prompts lists them as its own commands; every
 *   `prompts/get` is recorded through the gateway before it is sent, and not sent when that fails. A remote server's
 *   prompts are not offered (尚未实现): the Host is not a client for them;
 * - tools switched off in Latch are left out of `tools/list` and refused, with the launch's few words on what to do
 *   instead where it has them;
 * - where the launch carries Latch's own `instructions` (「操控这台 Mac」), they replace the server's at `initialize`, or
 *   (`instructionsMode: 'prepend'`) come before the server's own, unchanged;
 * - where the launch asks for it (`shapes`, 「操控这台 Mac」), each `tools/call` tells the Host what the call has the
 *   driver do (`computerCallShape`: the tools a batch runs, the shape of `launch_app`, pids and names), never a value;
 * - every `tools/call` is recorded through the gateway before it is sent, and not sent when that fails; its outcome after;
 * - a server that does not start, or does not answer `initialize` within 30 s, is reported, and the agent gets a server
 *   with no tools, so a session is never refused over it (DeepSeek Harness refuses one when any server fails).
 *
 * `server/discover` (the 2026 handshake) is answered as unknown without starting anything, so an agent falls back to
 * `initialize`; a throwaway copy that asks only that never takes the token. The process group ends when the agent
 * closes stdin, when the gateway ends the token (the server was removed, switched off or changed) and when the bridge
 * exits.
 */
const BRIDGE_SOURCE = String.raw`
const { spawn } = require('node:child_process')
const { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } = require('node:fs')
const { createConnection } = require('node:net')
const socketPath = process.argv[1]
const tokenFile = process.argv[2]
const INIT_MS = 30000
const MAX_LINE = 4 * 1024 * 1024
const own = stat => stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.uid === process.getuid()
try {
  if (!own(lstatSync(tokenFile))) throw new Error('mode')
} catch {
  process.stderr.write('latch-mcp: the token file is missing or not private; not starting.\n')
  process.exit(1)
}
let token
function readToken() {
  if (token !== undefined) return token
  token = ''
  let fd
  try {
    fd = openSync(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (own(fstatSync(fd))) token = readFileSync(fd, 'utf8').trim()
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(tokenFile)
    } catch {}
  }
  return token
}
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

// ---- the gateway ----
let gateway
let gatewayBuffer = ''
let nextAsk = 1
const asked = new Map()
function connect() {
  if (gateway) return gateway
  gateway = createConnection(socketPath)
  gateway.setEncoding('utf8')
  gateway.on('data', chunk => {
    gatewayBuffer += chunk
    if (gatewayBuffer.length > MAX_LINE) return gateway.destroy()
    for (let end = gatewayBuffer.indexOf('\n'); end >= 0; end = gatewayBuffer.indexOf('\n')) {
      const line = gatewayBuffer.slice(0, end)
      gatewayBuffer = gatewayBuffer.slice(end + 1)
      let reply
      try {
        reply = JSON.parse(line)
      } catch {
        continue
      }
      const done = asked.get(reply && reply.id)
      if (!done) continue
      asked.delete(reply.id)
      done(reply)
    }
  })
  gateway.on('error', () => {})
  gateway.on('close', () => {
    for (const [, done] of asked) done({ error: { message: 'The Latch tool gateway is not reachable.' } })
    asked.clear()
    // The token ended (removed, switched off, changed) or the Host went away: the server goes with it.
    revoked = true
    stopChild()
  })
  return gateway
}
function ask(method, params, onId) {
  return new Promise(resolve => {
    if (revoked) return resolve({ error: { message: 'This MCP server was removed or switched off in Latch.' } })
    const id = nextAsk++
    if (onId) onId(id)
    asked.set(id, resolve)
    connect().write(JSON.stringify({ id, token: readToken(), method, params }) + '\n')
  })
}
const tell = (method, params) => {
  if (!revoked) void ask(method, params)
}

// ---- the server ----
let child
// A remote address: the Host is its client, and every message goes there.
let remote = false
let revoked = false
let broken
let reported = false
let disabled = new Set()
// A server that keeps new tools off: only these are not new.
let known
const off = name => disabled.has(name) || (known !== undefined && !known.has(name))
// Latch's text in place of the server's instructions, and per tool switched off what to do instead.
let instructions
let instructionsMode = 'replace'
let hints = {}
// 「操控这台 Mac」: each call's shape goes to the Host with its record.
let shapes = false
const offText = name =>
  'This tool is switched off in Latch.' + (typeof name === 'string' && Object.hasOwn(hints, name) ? ' ' + hints[name] : '')
let childBuffer = ''
// Request ID (as JSON) → what the agent asked, for its reply.
const pending = new Map()
function stopChild() {
  if (!child) return
  const pid = child.pid
  child = undefined
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }, 1000).unref()
  for (const entry of pending.values()) answerBroken(entry)
  pending.clear()
}
function fail(reason) {
  if (!broken) broken = reason
  if (!reported) {
    reported = true
    tell('mcp/report', { ok: false, reason })
  }
  stopChild()
}
function answerBroken(entry) {
  if (entry.method === 'initialize') return write({ id: entry.id, result: ownInitialize(entry.params) })
  if (entry.method === 'tools/list') return write({ id: entry.id, result: { tools: [] } })
  if (entry.method === 'prompts/list') return write({ id: entry.id, result: { prompts: [] } })
  if (entry.method === 'prompts/get') return write({ id: entry.id, error: { code: -32000, message: 'This MCP server is not running.' } })
  if (entry.method === 'tools/call') {
    if (entry.callId) tell('mcp/called', { callId: entry.callId, result: 'failed', ms: Date.now() - entry.at })
    return write({ id: entry.id, result: { content: [{ type: 'text', text: 'This MCP server is not running.' }], isError: true } })
  }
  write({ id: entry.id, result: {} })
}
// Latch's text, alone or before the server's own (unchanged, as a string at most 16 KiB).
// A reader that throws reads nothing: the Host refuses a call it cannot read.
function shapeOf(name, args) {
  try {
    return computerCallShape(name, args)
  } catch {
    return { form: 'unknown' }
  }
}
function ownInstructions(theirs) {
  if (instructionsMode !== 'prepend' || typeof theirs !== 'string' || !theirs.trim()) return instructions
  return instructions + '\n\n---\n\n' + theirs.slice(0, 16384)
}
const ownInitialize = params => ({
  protocolVersion: (params && params.protocolVersion) || '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'latch-mcp', version: '1' },
})
function toChild(message) {
  if (!child || !child.stdin || child.stdin.destroyed) return false
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  return true
}
function fromChild(message) {
  if (!message || typeof message !== 'object') return
  if (typeof message.method === 'string') {
    // The server's own requests are declined; of its notifications only a changed tool list passes.
    if (message.id !== undefined) return toChild({ id: message.id, error: { code: -32601, message: 'Method not found' } })
    if (message.method === 'notifications/tools/list_changed') write({ method: message.method })
    return
  }
  const key = JSON.stringify(message.id)
  const entry = pending.get(key)
  if (!entry || entry.forwarded === false) return
  pending.delete(key)
  if (entry.method === 'initialize') {
    clearTimeout(entry.timer)
    if (!message.result || typeof message.result !== 'object') return fail('protocol')
    const offered = message.result.capabilities || {}
    // Tools as the server offers them; prompts only as a plain capability (their change notice is not forwarded).
    const capabilities = { tools: offered.tools || {}, ...(offered.prompts ? { prompts: {} } : {}) }
    return write({ id: entry.id, result: { ...message.result, capabilities, ...(instructions !== undefined ? { instructions: ownInstructions(message.result.instructions) } : {}) } })
  }
  if (entry.method === 'tools/list') {
    if (message.result && Array.isArray(message.result.tools)) {
      const tools = message.result.tools.filter(tool => tool && typeof tool.name === 'string')
      if (!reported) {
        reported = true
        tell('mcp/report', { ok: true, tools: tools.map(tool => tool.name) })
      }
      return write({ id: entry.id, result: { ...message.result, tools: tools.filter(tool => !off(tool.name)) } })
    }
    if (!reported) {
      reported = true
      tell('mcp/report', { ok: false, reason: 'list-failed' })
    }
    return write({ id: entry.id, result: { tools: [] } })
  }
  if (entry.method === 'tools/call') {
    const result = entry.cancelled ? 'cancelled' : message.error ? 'failed' : message.result && message.result.isError ? 'error' : 'ok'
    tell('mcp/called', { callId: entry.callId, result, ms: Date.now() - entry.at })
  }
  write({ ...message, id: entry.id })
}
async function start(request) {
  readToken()
  const reply = await ask('mcp/launch', {})
  const entry = { id: request.id, method: 'initialize', params: request.params }
  if (reply.error || !reply.result) {
    broken = 'spawn-failed'
    return answerBroken(entry)
  }
  const launch = reply.result
  disabled = new Set(Array.isArray(launch.disabledTools) ? launch.disabledTools : [])
  known = Array.isArray(launch.knownTools) ? new Set(launch.knownTools) : undefined
  if (typeof launch.instructions === 'string') instructions = launch.instructions
  if (launch.instructionsMode === 'prepend') instructionsMode = 'prepend'
  shapes = launch.shapes === true
  if (launch.offHints && typeof launch.offHints === 'object')
    hints = Object.fromEntries(Object.entries(launch.offHints).filter(([, text]) => typeof text === 'string'))
  if (launch.remote === true) {
    remote = true
    const answer = await ask('mcp/remote', { method: 'initialize', params: request.params && typeof request.params === 'object' ? request.params : {} })
    if (answer.error || !answer.result || typeof answer.result !== 'object') {
      // The Host reported why; the agent gets a server with no tools.
      broken = 'protocol'
      return answerBroken(entry)
    }
    // Two sessions: the agent's with this bridge speaks the version the agent asked for; the Host's with the server, its own.
    return write({
      id: request.id,
      result: { ...answer.result, ...ownInitialize(request.params), ...(instructions !== undefined ? { instructions } : {}) },
    })
  }
  try {
    child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'ignore'], detached: true })
  } catch {
    answerBroken(entry)
    return fail('spawn-failed')
  }
  const current = child
  current.stdin.on('error', () => {})
  current.once('error', () => {
    if (child === current) fail('spawn-failed')
  })
  current.once('exit', () => {
    if (child !== current) return
    fail('exited')
  })
  current.stdout.setEncoding('utf8')
  current.stdout.on('data', chunk => {
    childBuffer += chunk
    if (childBuffer.length > MAX_LINE && !childBuffer.includes('\n')) {
      childBuffer = ''
      return fail('output-too-large')
    }
    for (let end = childBuffer.indexOf('\n'); end >= 0; end = childBuffer.indexOf('\n')) {
      const line = childBuffer.slice(0, end)
      childBuffer = childBuffer.slice(end + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      fromChild(message)
    }
  })
  entry.timer = setTimeout(() => fail('timeout'), INIT_MS)
  pending.set(JSON.stringify(request.id), entry)
  const params = request.params && typeof request.params === 'object' ? request.params : {}
  toChild({ id: request.id, method: 'initialize', params: { ...params, capabilities: {} } })
}
// A remote server's list or call, through the Host; a cancel from the agent stops it there.
async function relay(id, method, params) {
  const args = params && typeof params === 'object' ? params : {}
  if (method === 'tools/call' && (typeof args.name !== 'string' || off(args.name)))
    return write({ id, result: { content: [{ type: 'text', text: offText(args.name) }], isError: true } })
  const entry = { id, method, remote: true }
  pending.set(JSON.stringify(id), entry)
  const answer = await ask('mcp/remote', { method, params: args }, askId => {
    entry.askId = askId
  })
  if (pending.get(JSON.stringify(id)) !== entry) return
  pending.delete(JSON.stringify(id))
  if (answer.result && typeof answer.result === 'object') return write({ id, result: answer.result })
  if (method === 'tools/list') return write({ id, result: { tools: [] } })
  const text = answer.error && answer.error.message ? String(answer.error.message) : 'The call was not made.'
  write({ id, result: { content: [{ type: 'text', text }], isError: true } })
}
let started = false
async function handle(request) {
  const { id, method, params } = request
  if (id === undefined) {
    if (method === 'notifications/initialized' && child) toChild({ method })
    if (method === 'notifications/cancelled' && params) {
      const entry = pending.get(JSON.stringify(params.requestId))
      if (entry && entry.remote) {
        entry.cancelled = true
        if (entry.askId !== undefined) tell('mcp/cancel', { id: entry.askId })
      } else if (entry) {
        entry.cancelled = true
        if (entry.forwarded !== false)
          toChild({ method, params: { requestId: params.requestId, ...(params.reason ? { reason: String(params.reason).slice(0, 200) } : {}) } })
      }
    }
    return
  }
  if (method === 'initialize') {
    if (started) return write({ id, error: { code: -32600, message: 'Already initialized' } })
    started = true
    return start(request)
  }
  if (method === 'ping') {
    if (!child || remote) return write({ id, result: {} })
    pending.set(JSON.stringify(id), { id, method })
    return toChild({ id, method })
  }
  const prompts = method === 'prompts/list' || method === 'prompts/get'
  // A remote server's prompts are not relayed (尚未实现): the agent is not offered them here.
  if ((method !== 'tools/list' && method !== 'tools/call' && !prompts) || (prompts && remote))
    return write({ id, error: { code: -32601, message: 'Method not found' } })
  if (remote && !broken && !revoked) return relay(id, method, params)
  if (!child || broken || revoked) return answerBroken({ id, method, at: Date.now() })
  if (method === 'tools/list' || method === 'prompts/list') {
    pending.set(JSON.stringify(id), { id, method })
    return toChild({ id, method, params: params && typeof params === 'object' ? params : {} })
  }
  if (method === 'prompts/get') {
    const prompt = params && params.name
    if (typeof prompt !== 'string' || !prompt) return write({ id, error: { code: -32602, message: 'Invalid prompt.' } })
    const key = JSON.stringify(id)
    const entry = { id, method, forwarded: false }
    pending.set(key, entry)
    // Track cancellation during authorization, while ignoring replies until the request reaches the child's pipe.
    const recorded = await ask('mcp/prompt', { prompt })
    if (pending.get(key) !== entry) return
    if (recorded.error || !recorded.result || entry.cancelled) {
      pending.delete(key)
      const text = recorded.error && recorded.error.message ? String(recorded.error.message) : 'The prompt was not fetched.'
      return write({ id, error: { code: -32000, message: text } })
    }
    entry.forwarded = toChild({ id, method, params })
    if (entry.forwarded) return
    pending.delete(key)
    return answerBroken(entry)
  }
  const name = params && params.name
  if (typeof name !== 'string' || off(name))
    return write({ id, result: { content: [{ type: 'text', text: offText(name) }], isError: true } })
  const entry = { id, method, at: Date.now() }
  pending.set(JSON.stringify(id), entry)
  // Recorded before it is sent; a record that cannot be written stops the call.
  // A simulator the call names (a UUID under a key about a device), for the Host's record and its 设备 panel; nothing else
  // of the arguments leaves the agent's process.
  let device
  const callArgs = params && typeof params.arguments === 'object' && params.arguments ? params.arguments : {}
  for (const [key, value] of Object.entries(callArgs)) {
    if (/device|udid|destination/i.test(key) && typeof value === 'string') {
      const found = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i.exec(value)
      if (found) {
        device = found[0].toUpperCase()
        break
      }
    }
  }
  const recorded = await ask('mcp/call', {
    tool: name,
    ...(device ? { device } : {}),
    ...(shapes ? { shape: shapeOf(name, params.arguments) } : {}),
  })
  if (recorded.error || !recorded.result || typeof recorded.result.callId !== 'string') {
    pending.delete(JSON.stringify(id))
    const text = recorded.error && recorded.error.message ? String(recorded.error.message) : 'The call was not recorded, so it was not made.'
    return write({ id, result: { content: [{ type: 'text', text }], isError: true } })
  }
  entry.callId = recorded.result.callId
  if (!child || entry.cancelled) {
    pending.delete(JSON.stringify(id))
    return answerBroken(entry)
  }
  toChild({ id, method, params })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    if (request && typeof request === 'object') void handle(request)
  }
  if (buffer.length > MAX_LINE) buffer = ''
})
const quit = () => {
  stopChild()
  setTimeout(() => process.exit(0), 50)
}
process.stdin.on('end', quit)
process.on('SIGTERM', quit)
${COMPUTER_SHAPE_SOURCE}
`

/**
 * The `mcpServers` entry for one of Latch's servers: the Host's own Node with the source above, the gateway's socket and
 * the token file's path as its arguments, and no environment. Neither the token nor any secret of the server is in it.
 * No `type`, as for `latch-skills`.
 */
export function mcpBridgeServer(lease: Pick<McpServerLease, 'name' | 'socketPath' | 'tokenFile'>): {
  name: string
  command: string
  args: string[]
  env: never[]
} {
  return {
    name: lease.name,
    command: process.execPath,
    args: ['--disable-sigusr1', '-e', BRIDGE_SOURCE, lease.socketPath, lease.tokenFile],
    env: [],
  }
}
