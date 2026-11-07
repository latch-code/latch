// A deterministic stand-in for `pi --mode rpc`: no network, no model. It answers pi's RPC commands in pi's shapes and
// plays a turn from the prompt's words: "run" runs a short command, "slow" one of three seconds, "sleep" one that runs
// until stopped, "fail" ends with
// a service error, "confirm" asks the person through an extension confirmation first. Text added with `steer` while a
// turn runs gets its own reply in that turn. FAKE_PI_LOG names a JSONL file of what it received; FAKE_PI_NO_MODELS=1
// lists no models, as pi does with no login; FAKE_PI_TOO_OLD=1 answers as a pi older than 0.84.4.
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = process.env
const log = event => {
  if (env.FAKE_PI_LOG) appendFileSync(env.FAKE_PI_LOG, `${JSON.stringify({ pid: process.pid, ...event })}\n`)
}
log({ event: 'start', argv: process.argv.slice(2), cwd: process.cwd() })

const MODELS =
  env.FAKE_PI_NO_MODELS === '1'
    ? []
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
let model = MODELS[0]
let thinkingLevel = 'medium'
let sessions = 0
let sessionFile = join(env.FAKE_PI_SESSIONS ?? tmpdir(), `fake-pi-${process.pid}-${++sessions}.jsonl`)
const tokens = { input: 0, output: 0 }
let run
let uiRequests = 0
const dialogs = new Map()

const send = record => process.stdout.write(`${JSON.stringify(record)}\n`)
const ok = (command, id, data) => send({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
const refuse = (command, id, error) => send({ id, type: 'response', command, success: false, error })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const levels = () => (model ? LEVELS[model.provider] : ['off'])
const state = () => ({
  ...(model ? { model } : {}),
  thinkingLevel,
  isStreaming: run !== undefined,
  isCompacting: false,
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
  send({ type: 'message_start', message: assistantMessage([], 'pending') })
  send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Thinking about it.' } })
  const half = Math.ceil(text.length / 2)
  for (const piece of [text.slice(0, half), text.slice(half)]) {
    await sleep(60)
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: piece } })
  }
  tokens.input += 100
  tokens.output += 20
  send({
    type: 'message_end',
    message: assistantMessage(
      [
        { type: 'thinking', thinking: 'Thinking about it.' },
        { type: 'text', text },
      ],
      'stop',
    ),
  })
}

async function command(current, call, commandLine, ms) {
  send({ type: 'message_start', message: assistantMessage([], 'pending') })
  send({
    type: 'message_end',
    message: assistantMessage([{ type: 'toolCall', id: call, name: 'bash', arguments: { command: commandLine } }], 'toolUse'),
  })
  send({ type: 'tool_execution_start', toolCallId: call, toolName: 'bash', args: { command: commandLine } })
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
  send({ type: 'message_start', message: user })
  send({ type: 'message_end', message: user })
  let ended = 'stop'
  if (/confirm/u.test(message)) {
    const answer = await Promise.race([confirm('Go on with the fake task?'), current.stopped.then(() => ({ cancelled: true }))])
    if (!current.aborted) await reply(answer.confirmed ? 'confirmed: yes' : 'confirmed: no')
  } else if (/fail/u.test(message)) {
    send({ type: 'message_start', message: assistantMessage([], 'pending') })
    send({ type: 'message_end', message: assistantMessage([], 'error', '529 overloaded_error: Overloaded') })
    ended = 'error'
  } else {
    if (/sleep/u.test(message)) await command(current, 'call-1', 'sleep 600', 600_000)
    else if (/slow/u.test(message)) await command(current, 'call-1', 'npm run build', 3_000)
    else if (/run/u.test(message)) await command(current, 'call-1', 'npm test', 400)
    if (!current.aborted) await reply(`echo: ${message}`)
  }
  while (!current.aborted && current.steering.length) {
    const added = current.steering.shift()
    const said = { role: 'user', content: added, timestamp: Date.now() }
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

function handle(record) {
  const { id, type } = record
  log({ event: 'recv', type, ...(type === 'prompt' || type === 'steer' ? { message: record.message } : {}) })
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
      if (!levels().includes(thinkingLevel)) thinkingLevel = 'medium'
      return ok(type, id, model)
    }
    case 'set_thinking_level':
      if (!levels().includes(record.level)) return refuse(type, id, `Thinking level not available: ${record.level}`)
      thinkingLevel = record.level
      return ok(type, id)
    case 'switch_session':
      sessionFile = record.sessionPath
      return ok(type, id, { cancelled: false })
    case 'new_session':
      sessionFile = join(env.FAKE_PI_SESSIONS ?? tmpdir(), `fake-pi-${process.pid}-${++sessions}.jsonl`)
      return ok(type, id, { cancelled: false })
    case 'prompt':
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
    case 'abort': {
      const current = run
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
        contextUsage: { tokens: tokens.input + tokens.output, contextWindow: model?.contextWindow ?? null, percent: null },
      })
    default:
      return refuse(type ?? 'parse', id, `Unknown command: ${type}`)
  }
}

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
