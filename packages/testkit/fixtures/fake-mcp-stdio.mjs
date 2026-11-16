#!/usr/bin/env node
// A fake MCP server over stdio, for tests of Latch's `latch-mcp` bridge and 测试. It speaks the 2025 handshake only
// (`server/discover` is unknown), lists `echo`, `slow`, `env_names` and `where`, offers prompts (`prompts/list`,
// `prompts/get`), and writes what it saw as JSON lines to FAKE_MCP_LOG: the names of its environment's variables, never
// their values.
//
// FAKE_MCP_MODE: `crash` exits at once; `silent` never answers `initialize`; `noisy` writes a line longer than any limit;
// `ask` sends a sampling request of its own after `initialize`; `changed` sends `notifications/tools/list_changed`.
// FAKE_MCP_EXTRA_TOOLS: more tools by name, comma separated, each answering `<name>: ok`.
// FAKE_MCP_INSTRUCTIONS: the `instructions` it gives at `initialize`.
import { appendFileSync } from 'node:fs'

const env = process.env
const mode = env.FAKE_MCP_MODE ?? ''
const log = (event, detail = {}) => {
  if (env.FAKE_MCP_LOG) appendFileSync(env.FAKE_MCP_LOG, `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...detail })}\n`)
}
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

log('start', { envNames: Object.keys(env).sort(), cwd: process.cwd(), argv: process.argv.slice(2) })
if (mode === 'crash') process.exit(3)

const TOOLS = [
  { name: 'echo', description: 'Says the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'slow', description: 'Waits, then answers.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'env_names', description: 'Lists its variables by name.', inputSchema: { type: 'object', properties: {} } },
  { name: 'where', description: 'Says its working folder.', inputSchema: { type: 'object', properties: {} } },
  ...(env.FAKE_MCP_EXTRA_TOOLS ?? '')
    .split(',')
    .filter(Boolean)
    .map(name => ({ name, description: 'An extra tool.', inputSchema: { type: 'object', properties: {} } })),
]
const timers = new Map()
// Prompts: `review` takes arguments, `picture` answers with an image only, `long` with 30,000 characters, one has
// direction and zero-width characters in its name, and one a control character (a client drops that one).
const FAKE_MCP_PROMPTS = [
  { name: 'hello', description: 'Says hello.' },
  {
    name: 'review',
    description: 'Reviews a topic.',
    arguments: [
      { name: 'topic', description: 'What to review.', required: true },
      { name: 'tone', description: 'How to say it.' },
    ],
  },
  { name: 'picture', description: 'Only an image.' },
  { name: 'long', description: 'Thirty thousand characters.' },
  { name: 'tidy\u202Eevil\u200Bup', description: 'Hidden \u202Echaracters\u200B in its name.' },
  { name: 'bell\u0007', description: 'A control character in its name.' },
]

/** The `prompts/get` result for `name`, or undefined for an unknown prompt. */
function fakeMcpPrompt(name, args = {}) {
  const text = value => ({ messages: [{ role: 'user', content: { type: 'text', text: value } }] })
  if (name === 'hello') return text('Hello from the fake MCP server.')
  if (name === 'review') return text(`Review ${args.topic ?? ''} in a ${args.tone ?? 'plain'} tone.`)
  if (name === 'picture') return { messages: [{ role: 'user', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }] }
  if (name === 'long') return text('long '.repeat(6000))
  if (name === 'tidy\u202Eevil\u200Bup') return text('Tidy up.')
  return undefined
}

function handle(message) {
  const { id, method, params } = message
  if (method === undefined) {
    log('reply', { id })
    return
  }
  log('recv', {
    method,
    ...(method === 'tools/call' ? { tool: params?.name } : {}),
    ...(method === 'prompts/get' ? { prompt: params?.name, argumentNames: Object.keys(params?.arguments ?? {}).sort() } : {}),
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
        ...(env.FAKE_MCP_INSTRUCTIONS ? { instructions: env.FAKE_MCP_INSTRUCTIONS } : {}),
      },
    })
    if (mode === 'ask') send({ id: 'server-1', method: 'sampling/createMessage', params: {} })
    if (mode === 'noisy') process.stdout.write(`${'x'.repeat(5 * 1024 * 1024)}\n`)
    if (mode === 'changed') setTimeout(() => send({ method: 'notifications/tools/list_changed' }), 50)
    return
  }
  if (method === 'ping') {
    if (mode === 'early-prompt') send({ id: 2, result: fakeMcpPrompt('hello') })
    return send({ id, result: {} })
  }
  if (method === 'tools/list') return send({ id, result: { tools: TOOLS } })
  if (method === 'prompts/list') return send({ id, result: { prompts: FAKE_MCP_PROMPTS } })
  if (method === 'prompts/get') {
    const result = fakeMcpPrompt(params?.name, params?.arguments ?? {})
    return send(result ? { id, result } : { id, error: { code: -32602, message: `Unknown prompt ${params?.name}` } })
  }
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
    if ((env.FAKE_MCP_EXTRA_TOOLS ?? '').split(',').includes(params?.name)) return text(`${params.name}: ok`)
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
