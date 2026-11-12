#!/usr/bin/env node
// A fake MCP server over stdio, for tests of Latch's `latch-mcp` bridge and 测试. It speaks the 2025 handshake only
// (`server/discover` is unknown), lists `echo`, `slow`, `env_names` and `where`, and writes what it saw as JSON lines to
// FAKE_MCP_LOG: the names of its environment's variables, never their values.
//
// FAKE_MCP_MODE: `crash` exits at once; `silent` never answers `initialize`; `noisy` writes a line longer than any limit;
// `ask` sends a sampling request of its own after `initialize`; `changed` sends `notifications/tools/list_changed`.
import { appendFileSync } from 'node:fs'

const env = process.env
const mode = env.FAKE_MCP_MODE ?? ''
const log = (event, detail = {}) => {
  if (env.FAKE_MCP_LOG) appendFileSync(env.FAKE_MCP_LOG, `${JSON.stringify({ event, pid: process.pid, ...detail })}\n`)
}
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

log('start', { envNames: Object.keys(env).sort(), cwd: process.cwd(), argv: process.argv.slice(2) })
if (mode === 'crash') process.exit(3)

const TOOLS = [
  { name: 'echo', description: 'Says the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'slow', description: 'Waits, then answers.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'env_names', description: 'Lists its variables by name.', inputSchema: { type: 'object', properties: {} } },
  { name: 'where', description: 'Says its working folder.', inputSchema: { type: 'object', properties: {} } },
]
const timers = new Map()

function handle(message) {
  const { id, method, params } = message
  if (method === undefined) {
    log('reply', { id })
    return
  }
  log('recv', {
    method,
    ...(method === 'tools/call' ? { tool: params?.name } : {}),
    ...(method === 'initialize' ? { capabilities: params?.capabilities ?? null } : {}),
  })
  if (id === undefined) {
    if (method === 'notifications/cancelled') {
      clearTimeout(timers.get(JSON.stringify(params?.requestId)))
      send({ id: params?.requestId, error: { code: -32800, message: 'cancelled' } })
    }
    return
  }
  if (method === 'initialize') {
    if (mode === 'silent') return
    send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: 'fake-mcp', version: '1' },
      },
    })
    if (mode === 'ask') send({ id: 'server-1', method: 'sampling/createMessage', params: {} })
    if (mode === 'noisy') process.stdout.write(`${'x'.repeat(5 * 1024 * 1024)}\n`)
    if (mode === 'changed') setTimeout(() => send({ method: 'notifications/tools/list_changed' }), 50)
    return
  }
  if (method === 'ping') return send({ id, result: {} })
  if (method === 'tools/list') return send({ id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    const args = params?.arguments ?? {}
    const text = value => send({ id, result: { content: [{ type: 'text', text: String(value) }] } })
    if (params?.name === 'echo') return text(`echo: ${args.text ?? ''}`)
    if (params?.name === 'env_names') return text(Object.keys(env).sort().join(','))
    if (params?.name === 'where') return text(process.cwd())
    if (params?.name === 'slow') {
      timers.set(
        JSON.stringify(id),
        setTimeout(() => text('slow done'), Number(args.ms ?? 1000)),
      )
      return
    }
    return send({ id, result: { content: [{ type: 'text', text: `unknown tool ${params?.name}` }], isError: true } })
  }
  send({ id, error: { code: -32601, message: 'Method not found' } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch {
      /* Not JSON: ignored. */
    }
  }
})
process.stdin.on('end', () => {
  log('end')
  process.exit(0)
})
process.on('SIGTERM', () => {
  log('sigterm')
  process.exit(0)
})
