// A deterministic stand-in for `pi --mode rpc`: no network, no model. It answers pi's RPC commands in pi's shapes and
// plays a turn from the prompt's words: "run" runs a short command, "slow" one of three seconds, "sleep" one that runs
// until stopped, "fail" ends with
// a service error, "confirm" asks the person through an extension confirmation first. Text added with `steer` while a
// turn runs gets its own reply in that turn. `compact` summarizes after a short wait; before any reply it fails as pi does
// with too little to compact, instructions with "cancel" have an extension cancel it and with "slow" it takes three
// seconds, until stopped. FAKE_PI_LOG names a JSONL file of what it received; FAKE_PI_NO_MODELS=1
// lists no models, as pi does with no login; FAKE_PI_TOO_OLD=1 answers as a pi older than 0.84.4. FAKE_PI_SHAPE=1.5
// behaves as pi 1.5 did in a handshake against the real program: a `queue_update` event before any command is answered,
// and `new_session` answered after commands sent behind it, since pi handles commands concurrently.
// It keeps each session's entries as pi does, a tree with IDs, parents and times, in a JSONL file under FAKE_PI_SESSIONS
// when that is set, so another process can switch to it, list it and fork or clone it. "recall" replies with the user
// messages on the branch before it; a session whose first message says "no-fork" has an extension cancel its forks.
// FAKE_PI_COMMANDS_FILE can add a JSON array of discoverable commands.
// Given `-e <dir>/latch-permission.ts`, it acts as Latch's permission extension does in pi (it never loads the file):
// `/latch-permission <level>` sets the level and every level is reported as a status; before a tool runs, `plan`
// blocks anything but reading, `ask` confirms the rest, `rule` lets edits and writes through. "write" in a prompt writes
// a file with the write tool. Each tool that really runs is logged as `executed`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { callFakeModel } from './fake-model-client.mjs'

const env = process.env
const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write(`${env.FAKE_PI_VERSION ?? '1.5.0'}\n`)
  process.exit(0)
}
const log = event => {
  if (env.FAKE_PI_LOG) appendFileSync(env.FAKE_PI_LOG, `${JSON.stringify({ pid: process.pid, ...event })}\n`)
}
log({ event: 'start', argv: process.argv.slice(2), cwd: process.cwd() })

const gatewayPath =
  env.FAKE_PI_GATEWAY === '1'
    ? argv.flatMap((arg, at) => (arg === '-e' && basename(argv[at + 1] ?? '') === 'pi-gateway.ts' ? [argv[at + 1]] : []))[0]
    : undefined
const gateway = gatewayPath ? JSON.parse(readFileSync(join(dirname(gatewayPath), 'pi-gateway.json'), 'utf8')) : undefined
const gatePath = argv.flatMap((arg, at) =>
  arg === '-e' && basename(argv[at + 1] ?? '') === 'latch-permission.ts' ? [argv[at + 1]] : [],
)[0]
const gate = gatePath ? { level: 'ask' } : undefined
const reportGate = () => {
  if (gate)
    send({
      type: 'extension_ui_request',
      id: `status-${++uiRequests}`,
      method: 'setStatus',
      statusKey: 'latch-permission',
      statusText: gate.level,
    })
}
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
/** What the gate says of a call: undefined to run it, or why it was blocked. */
async function gated(current, call, tool, input) {
  if (!gate || gate.level === 'never' || READ_TOOLS.has(tool)) return undefined
  if (gate.level === 'rule' && (tool === 'edit' || tool === 'write')) return undefined
  if (gate.level === 'plan') return `Latch: this session only reads (只看不改); ${tool} is blocked.`
  const id = `fake-ui-${++uiRequests}`
  send({
    type: 'extension_ui_request',
    id,
    method: 'confirm',
    title: tool,
    message: JSON.stringify({ latchGate: 1, toolCallId: call, toolName: tool, input }),
  })
  const answer = await Promise.race([new Promise(resolve => dialogs.set(id, resolve)), current.stopped.then(() => ({ cancelled: true }))])
  return answer.confirmed === true ? undefined : 'The person refused this call in Latch.'
}

const MODELS =
  env.FAKE_PI_NO_MODELS === '1'
    ? []
    : gateway
      ? gateway.models.map(item => ({
          id: item.id,
          name: item.id,
          provider: 'latch-gateway',
          api: gateway.api,
          reasoning: Boolean(item.capabilities?.thinking?.length),
          contextWindow: gateway.budget.contextTokens,
        }))
      : [
          {
            id: 'claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            provider: 'anthropic',
            api: 'anthropic-messages',
            reasoning: true,
            contextWindow: 200000,
          },
          { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', api: 'openai-responses', reasoning: true, contextWindow: 400000 },
        ]
const LEVELS = { anthropic: ['off', 'minimal', 'low', 'medium', 'high'], openai: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }
let model = MODELS.find(item => item.id === gateway?.selected) ?? MODELS[0]
let thinkingLevel = 'medium'
let sessions = 0
/** pi's own names: `<time>_<id>.jsonl`, the ID in the header too (pi 1.5.0 `session-manager.js`). */
let sessionUuid
const newFile = () => {
  sessions++
  sessionUuid = randomUUID()
  return join(env.FAKE_PI_SESSIONS ?? tmpdir(), `${new Date().toISOString().replace(/[:.]/gu, '-')}_${sessionUuid}.jsonl`)
}
let sessionFile = newFile()
/** The session's entries in the order they were written, and the one the branch ends at. */
let entries = []
let leafId = null

/** Written only where the test asked for files; without FAKE_PI_SESSIONS the session lives in this process alone. */
function persist() {
  if (!env.FAKE_PI_SESSIONS) return
  const header = { type: 'session', version: 3, id: sessionUuid, timestamp: new Date().toISOString(), cwd: process.cwd() }
  writeFileSync(sessionFile, [header, ...entries].map(item => `${JSON.stringify(item)}\n`).join(''))
}

function append(type, fields) {
  const item = { type, id: randomBytes(4).toString('hex'), parentId: leafId, timestamp: new Date().toISOString(), ...fields }
  entries.push(item)
  leafId = item.id
  persist()
  return item
}

/** pi opens a file that is not there as an empty session, written once something is said in it. */
function load(path) {
  sessionFile = path
  sessionUuid = /_([^_]+)\.jsonl$/u.exec(path)?.[1] ?? randomUUID()
  const lines = existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(line => line.trim())
    : []
  entries = lines.map(line => JSON.parse(line)).filter(item => item.type !== 'session')
  leafId = entries.at(-1)?.id ?? null
  if (gateway) {
    const selected = entries.findLast(item => item.type === 'model_change')
    model = MODELS.find(item => item.id === selected?.modelId && item.provider === selected?.provider) ?? model
    thinkingLevel = entries.findLast(item => item.type === 'thinking_level_change')?.thinkingLevel ?? thinkingLevel
  }
}

function branch(to = leafId) {
  const byId = new Map(entries.map(item => [item.id, item]))
  const path = []
  for (let id = to; id; id = byId.get(id)?.parentId ?? null) path.unshift(byId.get(id))
  return path
}

const userText = item => (item?.type === 'message' && item.message.role === 'user' ? String(item.message.content) : undefined)

/** A new session file holding the branch up to `to`, as pi's fork and clone write it, with the same IDs and times. */
function branchInto(to) {
  const kept = branch(to)
  sessionFile = newFile()
  entries = kept
  leafId = kept.at(-1)?.id ?? null
  persist()
}
const tokens = { input: 0, output: 0 }
/** pi knows the context's size from the last reply, and not again until a reply follows a compaction. */
let contextKnown = true
let run
let compacting
let uiRequests = 0
const dialogs = new Map()

const send = record => process.stdout.write(`${JSON.stringify(record)}\n`)
const ok = (command, id, data) => send({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
const refuse = (command, id, error) => send({ id, type: 'response', command, success: false, error })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const levels = () =>
  gateway
    ? (gateway.models.find(item => item.id === model?.id)?.capabilities?.thinking ?? ['off'])
    : model
      ? LEVELS[model.provider]
      : ['off']
const state = () => ({
  ...(model ? { model } : {}),
  thinkingLevel,
  isStreaming: run !== undefined,
  isCompacting: compacting !== undefined,
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  sessionFile,
  sessionId: `fake-${sessions}`,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: run?.steering.length ?? 0,
})

function assistantMessage(content, stopReason, errorMessage) {
  return {
    role: 'assistant',
    content,
    api: model?.api,
    provider: model?.provider,
    model: model?.id,
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  }
}

async function reply(text) {
  if (/recall/u.test(text)) {
    const said = branch().flatMap(item => userText(item) ?? [])
    text = `remembers: ${said.slice(0, -1).join(' | ') || 'nothing'}`
  }
  send({ type: 'message_start', message: assistantMessage([], 'pending') })
  send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Thinking about it.' } })
  const half = Math.ceil(text.length / 2)
  for (const piece of [text.slice(0, half), text.slice(half)]) {
    await sleep(60)
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: piece } })
  }
  tokens.input += 100
  tokens.output += 20
  contextKnown = true
  const said = assistantMessage(
    [
      { type: 'thinking', thinking: 'Thinking about it.' },
      { type: 'text', text },
    ],
    'stop',
  )
  append('message', { message: said })
  send({ type: 'message_end', message: said })
}

async function command(current, call, commandLine, ms) {
  send({ type: 'message_start', message: assistantMessage([], 'pending') })
  send({
    type: 'message_end',
    message: assistantMessage([{ type: 'toolCall', id: call, name: 'bash', arguments: { command: commandLine } }], 'toolUse'),
  })
  send({ type: 'tool_execution_start', toolCallId: call, toolName: 'bash', args: { command: commandLine } })
  const blocked = await gated(current, call, 'bash', { command: commandLine })
  if (blocked !== undefined) {
    send({
      type: 'tool_execution_end',
      toolCallId: call,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: blocked }] },
      isError: true,
    })
    return true
  }
  log({ event: 'executed', tool: 'bash', command: commandLine })
  send({
    type: 'tool_execution_update',
    toolCallId: call,
    toolName: 'bash',
    args: { command: commandLine },
    partialResult: { content: [{ type: 'text', text: `$ ${commandLine}\n` }] },
  })
  const waited = await Promise.race([sleep(ms).then(() => true), current.stopped.then(() => false)])
  send({
    type: 'tool_execution_end',
    toolCallId: call,
    toolName: 'bash',
    result: { content: [{ type: 'text', text: waited ? `$ ${commandLine}\nok\n` : `$ ${commandLine}\nCommand aborted` }], details: {} },
    isError: !waited,
  })
  return waited
}

/** The write tool on `a.txt`, through the gate. */
async function write(current, call) {
  const args = { path: 'a.txt', content: 'hi' }
  send({ type: 'message_start', message: assistantMessage([], 'pending') })
  send({ type: 'message_end', message: assistantMessage([{ type: 'toolCall', id: call, name: 'write', arguments: args }], 'toolUse') })
  send({ type: 'tool_execution_start', toolCallId: call, toolName: 'write', args })
  const blocked = await gated(current, call, 'write', args)
  if (blocked === undefined) {
    writeFileSync(join(process.cwd(), 'a.txt'), 'hi')
    log({ event: 'executed', tool: 'write', path: 'a.txt' })
  }
  send({
    type: 'tool_execution_end',
    toolCallId: call,
    toolName: 'write',
    result: { content: [{ type: 'text', text: blocked ?? 'Wrote a.txt' }] },
    isError: blocked !== undefined,
  })
}

function confirm(title) {
  const id = `fake-ui-${++uiRequests}`
  send({ type: 'extension_ui_request', id, method: 'confirm', title, message: 'The fake pi asks before it goes on.' })
  return new Promise(resolve => dialogs.set(id, resolve))
}

async function play(message) {
  let stop
  const current = { aborted: false, steering: [], stopped: new Promise(resolve => (stop = resolve)) }
  current.stop = stop
  run = current
  send({ type: 'agent_start' })
  send({ type: 'turn_start' })
  const user = { role: 'user', content: message, timestamp: Date.now() }
  append('message', { message: user })
  send({ type: 'message_start', message: user })
  send({ type: 'message_end', message: user })
  let ended = 'stop'
  if (gateway && message.startsWith('model ')) {
    const wire = {
      'openai-responses': 'responses',
      'openai-completions': 'chat-completions',
      'anthropic-messages': 'anthropic-messages',
    }[gateway.api]
    const answer = await callFakeModel({
      wire,
      baseURL: `${gateway.baseURL}${wire === 'anthropic-messages' ? '/v1' : ''}`,
      key: env.LMG_TOKEN,
      model: model.id,
      input: message,
    })
    await reply(`model: ${answer.text}`)
  } else if (/^dialog/u.test(message)) {
    // An extension's select, then its input: the reply names what pi got back for each.
    const ask = request =>
      Promise.race([
        new Promise(resolve => {
          const id = `fake-ui-${++uiRequests}`
          dialogs.set(id, resolve)
          send({ type: 'extension_ui_request', id, ...request })
        }),
        current.stopped.then(() => ({ cancelled: true })),
      ])
    const picked = await ask({ method: 'select', title: 'Which branch?', options: ['main', 'dev'] })
    const named = await ask({ method: 'input', title: 'Name the change', placeholder: 'short name' })
    const said = answer => (answer.cancelled ? 'cancelled' : answer.value)
    if (!current.aborted) await reply(`dialog: ${said(picked)} / ${said(named)}`)
  } else if (/confirm/u.test(message)) {
    const answer = await Promise.race([confirm('Go on with the fake task?'), current.stopped.then(() => ({ cancelled: true }))])
    if (!current.aborted) await reply(answer.confirmed ? 'confirmed: yes' : 'confirmed: no')
  } else if (/fail/u.test(message)) {
    send({ type: 'message_start', message: assistantMessage([], 'pending') })
    send({ type: 'message_end', message: assistantMessage([], 'error', '529 overloaded_error: Overloaded') })
    ended = 'error'
  } else {
    if (/write/u.test(message)) await write(current, 'call-w')
    if (/sleep/u.test(message)) await command(current, 'call-1', 'sleep 600', 600_000)
    else if (/slow/u.test(message)) await command(current, 'call-1', 'npm run build', 3_000)
    else if (/run/u.test(message)) await command(current, 'call-1', 'npm test', 400)
    if (!current.aborted) await reply(`echo: ${message}`)
  }
  while (!current.aborted && current.steering.length) {
    const added = current.steering.shift()
    const said = { role: 'user', content: added, timestamp: Date.now() }
    append('message', { message: said })
    send({ type: 'message_start', message: said })
    send({ type: 'message_end', message: said })
    await reply(`echo: ${added}`)
  }
  if (current.aborted) {
    send({ type: 'message_start', message: assistantMessage([], 'pending') })
    send({ type: 'message_end', message: assistantMessage([], 'aborted') })
  }
  send({ type: 'turn_end' })
  send({ type: 'agent_end', messages: [], willRetry: false })
  run = undefined
  send({ type: 'agent_settled', aborted: current.aborted && ended !== 'error' })
  current.settled?.()
}

async function compact(id, instructions) {
  const current = { aborted: false }
  let stop
  current.stopped = new Promise(resolve => (stop = resolve))
  current.stop = stop
  compacting = current
  send({ type: 'compaction_start', reason: 'manual' })
  const end = fields => send({ type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false, ...fields })
  const failed = error => {
    compacting = undefined
    refuse('compact', id, error)
    current.settled?.()
  }
  if (tokens.input === 0) {
    end({ errorMessage: 'Compaction failed: Nothing to compact (session too small)' })
    return failed('Nothing to compact (session too small)')
  }
  if (/cancel/u.test(instructions ?? '')) {
    end({ aborted: true })
    return failed('Compaction cancelled')
  }
  await Promise.race([sleep(/slow/u.test(instructions ?? '') ? 3_000 : 300), current.stopped])
  if (current.aborted) {
    end({ aborted: true })
    return failed('Compaction cancelled')
  }
  const result = {
    summary: `Summary of the conversation so far${instructions ? `, keeping: ${instructions}` : ''}.`,
    firstKeptEntryId: 'entry-1',
    tokensBefore: tokens.input + tokens.output,
    estimatedTokensAfter: 40,
    details: {},
  }
  contextKnown = false
  compacting = undefined
  append('compaction', { summary: result.summary, firstKeptEntryId: leafId, tokensBefore: result.tokensBefore })
  end({ result })
  ok('compact', id, result)
}

function handle(record) {
  const { id, type } = record
  log({
    event: 'recv',
    type,
    ...(type === 'prompt' || type === 'steer' ? { message: record.message } : {}),
    ...(type === 'switch_session' ? { sessionPath: record.sessionPath } : {}),
    ...(type === 'fork' ? { entryId: record.entryId } : {}),
    ...(type === 'get_entries' && record.since !== undefined ? { since: record.since } : {}),
    ...(type === 'compact' && record.customInstructions !== undefined ? { customInstructions: record.customInstructions } : {}),
  })
  switch (type) {
    case 'extension_ui_response': {
      const resolve = dialogs.get(id)
      dialogs.delete(id)
      resolve?.(record)
      return
    }
    case 'get_state':
      return ok(type, id, state())
    case 'get_available_models':
      return ok(type, id, { models: MODELS })
    case 'get_available_thinking_levels':
      return ok(type, id, { levels: levels() })
    case 'set_model': {
      const chosen = MODELS.find(item => item.provider === record.provider && item.id === record.modelId)
      if (!chosen) return refuse(type, id, `Model not found: ${record.provider}/${record.modelId}`)
      model = chosen
      if (!levels().includes(thinkingLevel)) thinkingLevel = gateway ? (levels()[0] ?? 'off') : 'medium'
      if (gateway) append('model_change', { provider: model.provider, modelId: model.id })
      return ok(type, id, model)
    }
    case 'set_thinking_level':
      if (!levels().includes(record.level)) return refuse(type, id, `Thinking level not available: ${record.level}`)
      thinkingLevel = record.level
      if (gateway) append('thinking_level_change', { thinkingLevel })
      return ok(type, id)
    case 'switch_session':
      load(record.sessionPath)
      // pi starts its extensions again for another session: the gate is back at its first level.
      if (gate) gate.level = 'ask'
      reportGate()
      return ok(type, id, { cancelled: false })
    case 'new_session':
      sessionFile = newFile()
      entries = []
      leafId = null
      if (env.FAKE_PI_SHAPE === '1.5') return void setTimeout(() => ok(type, id, { cancelled: false }), 50)
      return ok(type, id, { cancelled: false })
    case 'get_entries': {
      const from = record.since === undefined ? 0 : entries.findIndex(item => item.id === record.since) + 1
      if (from === 0 && record.since !== undefined) return refuse(type, id, `Entry ${record.since} not found`)
      return ok(type, id, { entries: entries.slice(from), leafId })
    }
    case 'fork':
    case 'clone': {
      if (run || compacting) return refuse(type, id, 'Wait for the current response to finish before forking')
      if (/no-fork/u.test(userText(entries.find(item => userText(item) !== undefined)) ?? '')) return ok(type, id, { cancelled: true })
      const chosen = type === 'fork' ? entries.find(item => item.id === record.entryId) : undefined
      if (type === 'fork' && userText(chosen) === undefined) return refuse(type, id, 'Invalid entry ID for forking')
      if (type === 'clone' && !leafId) return refuse(type, id, 'Cannot clone session: no current entry selected')
      branchInto(type === 'fork' ? chosen.parentId : leafId)
      return ok(type, id, type === 'fork' ? { text: userText(chosen), cancelled: false } : { cancelled: false })
    }
    case 'get_commands':
      return ok(type, id, {
        commands: [
          ...(gate
            ? [
                {
                  name: 'latch-permission',
                  description: 'Set by Latch',
                  source: 'extension',
                  sourceInfo: { path: gatePath, source: 'cli', scope: 'temporary', origin: 'top-level' },
                },
              ]
            : []),
          ...(env.FAKE_PI_COMMANDS_FILE ? JSON.parse(readFileSync(env.FAKE_PI_COMMANDS_FILE, 'utf8')) : []),
        ],
      })
    case 'prompt':
      {
        // An extension command runs at once, even during a run, and is not a message.
        const asked = gate && /^\/latch-permission(?:\s+(\S+))?\s*$/u.exec(String(record.message ?? ''))
        if (asked) {
          if (['plan', 'ask', 'rule', 'never'].includes(asked[1])) gate.level = asked[1]
          reportGate()
          return ok(type, id, { disposition: 'handled' })
        }
      }
      if (run) return refuse(type, id, 'Agent is already processing. Specify streamingBehavior.')
      if (!model) return refuse(type, id, 'No model selected')
      ok(type, id, { disposition: 'started' })
      void play(String(record.message ?? ''))
      return
    case 'steer':
      if (!run) return ok(type, id, { disposition: 'queued' })
      run.steering.push(String(record.message ?? ''))
      return ok(type, id, { disposition: 'queued' })
    case 'clear_queue': {
      // pi before 0.84.4 has no such command.
      if (env.FAKE_PI_TOO_OLD === '1') return refuse(type, id, `Unknown command: ${type}`)
      const steering = run ? run.steering.splice(0) : []
      return ok(type, id, { steering, followUp: [] })
    }
    case 'compact':
      if (run || compacting) return refuse(type, id, 'The fake pi compacts only between turns')
      void compact(id, record.customInstructions)
      return
    case 'abort': {
      const current = run ?? compacting
      if (!current) return ok(type, id)
      current.aborted = true
      current.stop()
      current.settled = () => ok(type, id)
      return
    }
    case 'get_session_stats':
      return ok(type, id, {
        sessionFile,
        tokens: { input: tokens.input, output: tokens.output, cacheRead: 0, cacheWrite: 0, total: tokens.input + tokens.output },
        cost: (tokens.input * 3 + tokens.output * 15) / 1_000_000,
        contextUsage: {
          tokens: contextKnown ? tokens.input + tokens.output : null,
          contextWindow: model?.contextWindow ?? null,
          percent: null,
        },
      })
    default:
      return refuse(type ?? 'parse', id, `Unknown command: ${type}`)
  }
}

reportGate()
if (env.FAKE_PI_SHAPE === '1.5') process.stdout.write(`${JSON.stringify({ type: 'queue_update', steering: [], followUp: [] })}\n`)

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch (error) {
      refuse('parse', undefined, `Failed to parse command: ${error.message}`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
