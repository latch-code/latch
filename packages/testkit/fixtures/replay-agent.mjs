// Plays one ACP transcript back over stdio, in place of a real agent: no network, no model. It checks every frame the
// client sends against the transcript's next `expect_outbound`, and sends the `emit_inbound` frames that follow.
// REPLAY_TRANSCRIPT names the NDJSON file, REPLAY_STATUS the JSON file it reports into (where it got to, the first
// mismatch, and how each process was started), REPLAY_WORKSPACE what `<workspace>` stands for (default: its cwd).
// A transcript can span processes: after a `runtime_exit` the next process carries on from there.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const env = process.env
const transcriptPath = env.REPLAY_TRANSCRIPT
const statusPath = env.REPLAY_STATUS
if (!transcriptPath || !statusPath) {
  process.stderr.write('replay agent needs REPLAY_TRANSCRIPT and REPLAY_STATUS\n')
  process.exit(2)
}
const workspace = env.REPLAY_WORKSPACE ?? process.cwd()
const lines = readFileSync(transcriptPath, 'utf8')
  .split('\n')
  .filter(line => line.trim())
const header = JSON.parse(lines[0])
const entries = lines.slice(1).map(line => JSON.parse(line))
// Variables whose value a test asserts: where the person's home is, and the programs an adapter is pointed at.
const WATCHED = ['HOME', 'CODEX_PATH', 'PI_ACP_PI_COMMAND', 'TMPDIR']

function previous() {
  try {
    return JSON.parse(readFileSync(statusPath, 'utf8'))
  } catch {
    return undefined
  }
}
const before = previous()
// Carry on only where the last process was meant to end; anything else starts over, and a test sees two starts.
let cursor =
  before && before.failure === undefined && typeof before.cursor === 'number' && entries[before.cursor - 1]?.type === 'runtime_exit'
    ? before.cursor
    : 0
const starts = [
  ...(Array.isArray(before?.starts) ? before.starts : []),
  {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    at: cursor,
    env: Object.fromEntries(WATCHED.map(name => [name, env[name] ?? null])),
  },
]
let failure
let stopped = false
let nextAgentId = 1
const clientRequests = new Map()
const agentRequests = new Map()

function writeStatus() {
  const temporary = `${statusPath}.${process.pid}.tmp`
  writeFileSync(
    temporary,
    JSON.stringify({ scenario: header.scenario, cursor, total: entries.length, starts, ...(failure ? { failure } : {}) }),
  )
  // A test may read the file while this process writes it.
  renameSync(temporary, statusPath)
}

function fail(detail, actual) {
  if (stopped) return
  stopped = true
  failure = { detail, cursor, expected: entries[cursor] ?? null, ...(actual === undefined ? {} : { actual }) }
  writeStatus()
  process.stderr.write(`replay mismatch: ${JSON.stringify(failure)}\n`)
  process.exitCode = 1
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

function expand(value) {
  if (typeof value === 'string') return value.replaceAll('<workspace>', workspace)
  if (Array.isArray(value)) return value.map(expand)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]))
  return value
}

/** `<any>` matches any value, or any run of text inside a string; objects must have exactly the expected keys. */
function matches(expected, actual) {
  if (expected === '<any>') return true
  if (typeof expected === 'string') {
    if (typeof actual !== 'string') return false
    const parts = expand(expected).split('<any>')
    if (parts.length === 1) return parts[0] === actual
    if (!actual.startsWith(parts[0]) || !actual.endsWith(parts.at(-1))) return false
    let offset = parts[0].length
    for (const part of parts.slice(1, -1)) {
      const index = actual.indexOf(part, offset)
      if (index === -1) return false
      offset = index + part.length
    }
    return offset <= actual.length - parts.at(-1).length
  }
  if (Array.isArray(expected))
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => matches(item, actual[index]))
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    const keys = Object.keys(expected).sort()
    const actualKeys = Object.keys(actual).sort()
    return keys.length === actualKeys.length && keys.every((key, index) => key === actualKeys[index] && matches(expected[key], actual[key]))
  }
  return Object.is(expected, actual)
}

function logical(message) {
  if (typeof message.method === 'string') {
    const request = message.id !== undefined && message.id !== null
    return {
      kind: request ? 'request' : 'notification',
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    }
  }
  const method = agentRequests.get(String(message.id))
  if (method === undefined) return undefined
  return {
    kind: 'response',
    method,
    ...(message.result === undefined ? {} : { result: message.result }),
    ...(message.error === undefined ? {} : { error: message.error }),
  }
}

function wire(frame) {
  const value = expand(frame)
  switch (value.kind) {
    case 'notification':
      return { jsonrpc: '2.0', method: value.method, ...(value.params === undefined ? {} : { params: value.params }) }
    case 'request': {
      const id = nextAgentId++
      agentRequests.set(String(id), value.method)
      return { jsonrpc: '2.0', id, method: value.method, ...(value.params === undefined ? {} : { params: value.params }) }
    }
    case 'response': {
      const id = clientRequests.get(value.method)
      if (id === undefined) return fail(`no request from the client to answer: ${value.method}`, value)
      clientRequests.delete(value.method)
      return {
        jsonrpc: '2.0',
        id,
        ...(value.result === undefined ? {} : { result: value.result }),
        ...(value.error === undefined ? {} : { error: value.error }),
      }
    }
    default:
      return fail('emit_inbound frame has no kind', value)
  }
}

/** Sends every inbound frame up to the next expected one, recording progress before the client can react to them. */
function flush() {
  const out = []
  let exitCode
  while (!stopped) {
    const entry = entries[cursor]
    if (!entry || entry.type === 'expect_outbound') break
    if (entry.type === 'runtime_exit') {
      cursor++
      // A number: this process ends by itself. Otherwise the client ends it; frames after belong to the next process.
      if (typeof entry.code === 'number') exitCode = entry.code
      break
    }
    const message = wire(entry.frame)
    if (!message) break
    out.push(message)
    cursor++
  }
  if (!stopped) writeStatus()
  for (const message of out) send(message)
  if (exitCode !== undefined) process.stdout.write('', () => process.exit(exitCode))
}

function receive(message) {
  if (stopped) return
  const actual = logical(message)
  const entry = entries[cursor]
  if (!actual || entry?.type !== 'expect_outbound' || !matches(entry.frame, actual)) {
    fail(actual ? 'unexpected frame from the client' : 'a response to no request of the agent', actual ?? message)
    if (message.method && message.id !== undefined)
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'replay mismatch' } })
    return
  }
  if (actual.kind === 'request') clientRequests.set(actual.method, message.id)
  if (actual.kind === 'response') agentRequests.delete(String(message.id))
  cursor++
  flush()
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      fail('a line from the client is not JSON', line.slice(0, 200))
      continue
    }
    receive(message)
  }
})
process.stdin.on('end', () => {
  if (!stopped && cursor < entries.length && entries[cursor - 1]?.type !== 'runtime_exit')
    fail('the client closed input before the transcript ended')
  process.exit(process.exitCode ?? 0)
})
process.on('SIGTERM', () => {
  if (!stopped && cursor < entries.length && entries[cursor - 1]?.type !== 'runtime_exit')
    fail('the client stopped the process before the transcript ended')
  process.exit(process.exitCode ?? 0)
})

writeStatus()
flush()
