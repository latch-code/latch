// Deterministic ACP v1 agent for tests. No network, no model; it writes only FAKE_ACP_STATE and FAKE_ACP_LOG
// (and reads FAKE_ACP_STORE, the client's own snapshot, to check what was durable when a prompt arrived).
// Process-wide behaviour comes from environment variables; each turn's behaviour from the prompt's first word.
// Several processes may share FAKE_ACP_STATE (one per session), so every save merges into what is on disk.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const env = process.env
/** The content of FAKE_ACP_CAPS_FILE when set, so a later process of the same definition can advertise other capabilities. */
const capsFile = (() => {
  try {
    return env.FAKE_ACP_CAPS_FILE ? readFileSync(env.FAKE_ACP_CAPS_FILE, 'utf8').trim() : undefined
  } catch {
    return undefined
  }
})()
/** Comma list: resume, load, delete, dirs (sessionCapabilities.additionalDirectories). */
const caps = new Set((capsFile ?? env.FAKE_ACP_CAPS ?? '').split(',').filter(Boolean))
const stateFile = env.FAKE_ACP_STATE
const logFile = env.FAKE_ACP_LOG
const END = { stopReason: 'end_turn' }
/** Delay before exiting on stdin end, like an agent flushing its state. */
const exitDelay = Number(env.FAKE_ACP_EXIT_DELAY ?? 0)
/** Delay for session/load, and for session/new once FAKE_ACP_STATE already holds a session (of any process). */
const slowSetup = Number(env.FAKE_ACP_SLOW_SETUP ?? 0)
/** Comma list of modes; the legacy default is build,plan. With FAKE_ACP_CONFIG=options a `mode` option appears only when set. */
const modes = (env.FAKE_ACP_MODES ?? 'build,plan').split(',').filter(Boolean)
const initialMode = env.FAKE_ACP_INITIAL_MODE ?? modes[0]
/** Ignores every request to change the mode, and says so. */
const stickyMode = env.FAKE_ACP_STICKY_MODE === '1'
/** Mode a session comes back in after session/resume or session/load. */
const resumeMode = env.FAKE_ACP_RESUME_MODE
/** session/resume and session/load answer without the session's state; a load reports the mode only during its replay. */
const resumeSilent = env.FAKE_ACP_RESUME_SILENT === '1'
/** Mode the agent switches itself to while it handles a request to change its mode, as a model-invoked mode tool might. */
const selfMode = env.FAKE_ACP_SELF_MODE
/** Shape of the agent's own mode reports with FAKE_ACP_CONFIG=options: full, uncategorized (mode option without its
 * category), unlisted (mode option left out) or none (no report; responses still carry the state). */
const modeReport = env.FAKE_ACP_MODE_REPORT ?? 'full'
/** agentInfo.version; 'none' omits it. */
const version = env.FAKE_ACP_VERSION ?? '1.2.3'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function log(event, data = {}) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, event, ...data })}\n`)
}

const readDisk = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
}
const sessions = readDisk()
const touched = new Set()
const save = () => {
  if (!stateFile) return
  const disk = readDisk()
  for (const id of touched) {
    if (sessions[id]) disk[id] = sessions[id]
    else delete disk[id]
  }
  writeFileSync(stateFile, JSON.stringify(disk))
}

log('start', {
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  // Names of the Host's settings, whose values must never reach an agent: LATCH_* and their names before the rename.
  latchEnv: Object.keys(env).filter(key => /^LATCH_/iu.test(key)),
  secret: env.FAKE_SECRET ?? null,
  tmpdir: env.TMPDIR ?? null,
})
if (env.FAKE_ACP_DUMP_ENV === '1') log('env', { env: { ...env } })
if (env.FAKE_ACP_IGNORE_TERM) process.on('SIGTERM', () => log('sigterm-ignored'))
if (env.FAKE_ACP_GRANDCHILD) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  log('grandchild', { grandchild: child.pid })
}
if (env.FAKE_ACP_STARTUP_NOISE) process.stdout.write('fake agent starting (not json)\n')

// ---- transport ----------------------------------------------------------------------------------------------

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    if (/[\u2028\u2029]/.test(line)) log('raw-separator')
    if (line.trim()) receive(JSON.parse(line))
  }
})
process.stdin.on('end', () => {
  log('stdin-end')
  setTimeout(() => {
    log('exit')
    process.stdout.write('', () => process.exit(0))
  }, exitDelay)
})

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const update = (sessionId, value) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })
let nextId = 0 // Deliberately overlaps the client's own request IDs.
const waiting = new Map()
function request(method, params) {
  const id = nextId++
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise(resolve => waiting.set(id, resolve))
}
function rpcError(code, message) {
  return Object.assign(new Error(message), { code })
}

const cancelled = new Set()
const cancelWaiters = new Map()
function waitCancel(sessionId) {
  if (cancelled.has(sessionId)) return Promise.resolve()
  return new Promise(resolve => cancelWaiters.set(sessionId, resolve))
}

function receive(message) {
  log('recv', {
    method: message.method ?? null,
    id: message.id ?? null,
    params: message.params,
    result: message.result,
    error: message.error,
  })
  if (message.method === undefined) {
    const resolve = waiting.get(message.id)
    waiting.delete(message.id)
    resolve?.(message)
    return
  }
  if (message.id === undefined) {
    if (message.method === 'session/cancel') {
      cancelled.add(message.params.sessionId)
      cancelWaiters.get(message.params.sessionId)?.()
      cancelWaiters.delete(message.params.sessionId)
    }
    return
  }
  Promise.resolve()
    .then(() => handle(message.method, message.params ?? {}))
    .then(
      result => send({ jsonrpc: '2.0', id: message.id, result }),
      error => send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
    )
}

// ---- sessions -----------------------------------------------------------------------------------------------

function existing(sessionId) {
  // Another process may have created it since this one started.
  if (!sessions[sessionId]) {
    const stored = readDisk()[sessionId]
    if (stored) sessions[sessionId] = stored
  }
  const session = sessions[sessionId]
  if (!session) throw rpcError(-32002, `Session not found: ${sessionId}`)
  touched.add(sessionId)
  return session
}

function configOptions(session, shape = 'full') {
  const mode = {
    id: 'mode',
    name: 'Mode',
    ...(shape === 'uncategorized' ? {} : { category: 'mode' }),
    type: 'select',
    currentValue: session.mode,
    options: modes.map(mode => ({ value: mode, name: mode })),
  }
  return [
    ...(env.FAKE_ACP_MODES && shape !== 'unlisted' ? [mode] : []),
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: session.model,
      options: [
        { value: 'small', name: 'Small' },
        { value: 'large', name: 'Large' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: session.effort,
      options: [
        {
          group: 'levels',
          name: 'Levels',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    },
    { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
  ]
}

function configState(session) {
  if (env.FAKE_ACP_CONFIG === 'legacy') {
    return {
      models: {
        currentModelId: session.model,
        availableModels: [
          { modelId: 'small', name: 'Fake Small' },
          { modelId: 'large', name: 'Fake Large' },
        ],
      },
      modes: {
        currentModeId: session.mode,
        availableModes: modes.map(mode => ({ id: mode, name: mode[0].toUpperCase() + mode.slice(1) })),
      },
    }
  }
  if (env.FAKE_ACP_CONFIG === 'options') return { configOptions: configOptions(session) }
  return {}
}

/** Reports the session's mode the way its configuration style does. */
function reportMode(sessionId, session) {
  if (modeReport === 'none') return
  if (env.FAKE_ACP_CONFIG === 'options')
    update(sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions(session, modeReport) })
  else update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: session.mode })
}

function restored(sessionId) {
  const session = existing(sessionId)
  if (resumeMode) {
    session.mode = resumeMode
    save()
  }
  return session
}

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      if (env.FAKE_ACP_INIT_DELAY) await delay(Number(env.FAKE_ACP_INIT_DELAY))
      if (env.FAKE_ACP_INIT_AUTH === '1') throw rpcError(-32000, 'Authentication required')
      if (env.FAKE_ACP_INIT_ERROR) {
        const diagnostic = ['x'.repeat(Math.min(20000, Number(env.FAKE_ACP_INIT_DIAGNOSTIC_SIZE ?? 0))), env.FAKE_ACP_INIT_DIAGNOSTIC]
          .filter(Boolean)
          .join(' ')
        process.stderr.write(`startup diagnostics ${diagnostic ? `${diagnostic} ` : ''}${env.FAKE_SECRET ?? ''}\n`)
        throw rpcError(-32603, `provider rejected API key ${env.FAKE_SECRET ?? ''}`)
      }
      return {
        protocolVersion: Number(env.FAKE_ACP_PROTOCOL ?? 1),
        agentCapabilities: {
          promptCapabilities: { image: caps.has('images'), embeddedContext: caps.has('embedded') },
          loadSession: caps.has('load'),
          sessionCapabilities: {
            ...(caps.has('resume') ? { resume: {} } : {}),
            ...(caps.has('delete') ? { delete: {} } : {}),
            ...(caps.has('dirs') ? { additionalDirectories: {} } : {}),
          },
        },
        authMethods: env.FAKE_ACP_AUTH ? [{ id: 'fake-login', name: 'Fake login', description: 'Run `fake login` in a terminal' }] : [],
        agentInfo: { name: 'Fake ACP', ...(version === 'none' ? {} : { version }) },
      }
    case 'session/new': {
      if (env.FAKE_ACP_AUTH === 'new') throw rpcError(-32000, 'Authentication required')
      if (slowSetup && Object.keys(readDisk()).length > 0) await delay(slowSetup)
      const sessionId = `sess-${randomUUID()}`
      sessions[sessionId] = { cwd: params.cwd, history: [], model: 'small', mode: initialMode, effort: 'low' }
      touched.add(sessionId)
      save()
      return { sessionId, ...configState(sessions[sessionId]) }
    }
    case 'session/load': {
      if (!caps.has('load')) throw rpcError(-32601, 'Method not found')
      if (slowSetup) await delay(slowSetup)
      const session = restored(params.sessionId)
      for (const entry of session.history) {
        update(params.sessionId, {
          sessionUpdate: entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: entry.text },
        })
      }
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'replayed', title: 'Replayed tool', status: 'completed' })
      if (!resumeSilent) return configState(session)
      reportMode(params.sessionId, session)
      return {}
    }
    case 'session/resume': {
      if (!caps.has('resume')) throw rpcError(-32601, 'Method not found')
      const session = restored(params.sessionId)
      return resumeSilent ? {} : configState(session)
    }
    case 'session/prompt':
      return prompt(params)
    case 'session/set_model':
      existing(params.sessionId).model = params.modelId
      save()
      return {}
    case 'session/set_mode': {
      const session = existing(params.sessionId)
      if (!stickyMode) session.mode = params.modeId
      if (selfMode) session.mode = selfMode
      save()
      // The response is empty, so the agent reports the resulting mode separately.
      update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: session.mode })
      return {}
    }
    case 'session/set_config_option': {
      const session = existing(params.sessionId)
      const mode = params.configId === 'mode'
      if (!(stickyMode && mode) && env.FAKE_ACP_IGNORE_CONFIG !== params.configId) session[params.configId] = params.value
      if (mode && selfMode) {
        session.mode = selfMode
        reportMode(params.sessionId, session)
      }
      save()
      return { configOptions: configOptions(session) }
    }
    case 'session/delete':
      existing(params.sessionId)
      delete sessions[params.sessionId]
      save()
      return {}
    default:
      throw rpcError(-32601, `Method not found: ${method}`)
  }
}

// ---- turns --------------------------------------------------------------------------------------------------

/** Asks once with exactly these options and reports the answer. */
function options(choices) {
  return async ({ say, permission }) => {
    const { result } = await permission({ toolCallId: 'call_1', title: 'Ask with options' }, choices)
    log('permission-answer', { outcome: result.outcome })
    say(`outcome ${result.outcome.optionId ?? result.outcome.outcome}`)
    return END
  }
}

const ALLOW_OPTIONS = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]
const text = value => ({ type: 'content', content: { type: 'text', text: value } })

async function prompt({ sessionId, prompt: blocks }) {
  const session = existing(sessionId)
  if (env.FAKE_ACP_STORE) {
    const durable = (() => {
      try {
        return readFileSync(env.FAKE_ACP_STORE, 'utf8').includes(sessionId)
      } catch {
        return false
      }
    })()
    log('prompt-store', { sessionId, durable })
  }
  if (env.FAKE_ACP_AUTH === 'prompt') throw rpcError(-32000, 'Authentication required')
  const input = blocks.map(block => block.text ?? '').join('')
  const [keyword, argument] = input.trim().split(/\s+/)
  log('prompt-mode', { sessionId, mode: session.mode })
  cancelled.delete(sessionId)
  session.history.push({ role: 'user', text: input })
  const reply = []
  const say = (value, messageId) => {
    reply.push(value)
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value }, ...(messageId ? { messageId } : {}) })
  }
  const think = value => update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value } })
  const tool = (value, kind = 'tool_call') => update(sessionId, { sessionUpdate: kind, ...value })
  const permission = (toolCall, options = ALLOW_OPTIONS) => request('session/request_permission', { sessionId, toolCall, options })
  const scenario = scenarios[keyword] ?? scenarios.echo
  const result = await scenario({ sessionId, session, input, argument, say, think, tool, permission })
  session.history.push({ role: 'agent', text: reply.join('') })
  save()
  return result
}

const scenarios = {
  echo: ({ input, say }) => {
    say(`echo: ${input}`)
    return END
  },
  count: async ({ sessionId, argument, say }) => {
    for (let index = 0; index < Number(argument ?? 5); index++) {
      if (cancelled.has(sessionId)) return { stopReason: 'cancelled' }
      say(`${index} `)
      await delay(10)
    }
    return END
  },
  ids: ({ say }) => {
    say('first ', 'm1')
    say('part', 'm1')
    say('second', 'm2')
    return END
  },
  think: ({ think, say }) => {
    think('pondering')
    think(' deeply')
    say('answer')
    return END
  },
  tool: ({ say, tool }) => {
    say('before')
    tool({
      toolCallId: 'call_1',
      title: 'Edit a.txt',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: '/w/a.txt' },
      locations: [{ path: '/w/a.txt', line: 3 }],
    })
    tool({ toolCallId: 'call_1', status: 'in_progress' }, 'tool_call_update')
    tool(
      {
        toolCallId: 'call_1',
        status: 'completed',
        content: [{ type: 'diff', path: '/w/a.txt', oldText: 'old\n', newText: 'new\n' }, text('written')],
      },
      'tool_call_update',
    )
    say('after')
    return END
  },
  // A new file (oldText null), an edit (oldText text) and an agent that leaves oldText out.
  diffs: ({ tool }) => {
    tool({
      toolCallId: 'call_1',
      title: 'Write files',
      kind: 'edit',
      status: 'completed',
      content: [
        { type: 'diff', path: '/w/new.txt', oldText: null, newText: 'created\n' },
        { type: 'diff', path: '/w/a.txt', oldText: 'old\n', newText: 'new\n' },
        { type: 'diff', path: '/w/b.txt', newText: 'b\n' },
      ],
    })
    return END
  },
  permission: async ({ say, tool, permission }) => {
    const call = { toolCallId: 'call_1', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }
    tool(call)
    const { result } = await permission(call)
    if (result.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' }
    if (result.outcome.optionId === 'reject') {
      tool({ toolCallId: 'call_1', status: 'failed' }, 'tool_call_update')
      say('rejected')
      return END
    }
    tool({ toolCallId: 'call_1', status: 'in_progress' }, 'tool_call_update')
    tool({ toolCallId: 'call_1', status: 'completed', content: [text(`ran with ${result.outcome.optionId}`)] }, 'tool_call_update')
    say('allowed')
    return END
  },
  // One edit that asks once per file: it writes a.txt after the first answer allows it, then asks again for b.txt and
  // reports what it wrote whatever the second answer is.
  twice: async ({ say, tool, permission }) => {
    const call = { toolCallId: 'call_1', title: 'Edit two files', kind: 'edit', status: 'pending', rawInput: { files: ['a.txt', 'b.txt'] } }
    tool(call)
    const first = await permission(call)
    if (first.result.outcome.optionId !== 'allow') {
      tool({ toolCallId: 'call_1', status: 'failed' }, 'tool_call_update')
      return END
    }
    const wrote = [{ type: 'diff', path: '/w/a.txt', oldText: 'old\n', newText: 'new\n' }]
    tool({ toolCallId: 'call_1', status: 'in_progress', content: wrote }, 'tool_call_update')
    const second = await permission({ toolCallId: 'call_1', title: 'Edit b.txt' })
    tool({ toolCallId: 'call_1', status: 'completed', content: wrote }, 'tool_call_update')
    say(`second=${second.result.outcome.optionId}`)
    return END
  },
  // An agent that runs the call whatever the answer, as a full-access agent may: the ask is advisory.
  ignore: async ({ say, tool, permission }) => {
    const call = { toolCallId: 'call_1', title: 'Edit a.txt', kind: 'edit', status: 'pending', rawInput: { path: '/w/a.txt' } }
    tool(call)
    const { result } = await permission(call)
    tool(
      {
        toolCallId: 'call_1',
        status: 'completed',
        content: [{ type: 'diff', path: '/w/a.txt', oldText: 'old\n', newText: 'new\n' }],
      },
      'tool_call_update',
    )
    say(`ignored ${result.outcome.optionId}`)
    return END
  },
  // A plan, then the same question as `permission`: a running session that waits for an answer with a plan in hand.
  'plan-ask': args => {
    update(args.sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'List the project root', status: 'in_progress' },
        { content: 'Summarise the layout', status: 'pending' },
      ],
    })
    return scenarios.permission(args)
  },
  'persistent-only': options([
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'never', name: 'Always reject', kind: 'reject_always' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]),
  'only-always': options([{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }]),
  'unknown-kind': options([
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'weird', name: 'Allow in this folder', kind: 'allow_folder' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]),
  'unknown-only': options([
    { optionId: 'weird', name: 'Allow in this folder', kind: 'allow_folder' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]),
  // Codex-style choices that would store an exec or network policy amendment.
  amendment: options([
    { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
    { optionId: 'accept_execpolicy_amendment', name: 'Yes, and allow this command from now on', kind: 'allow_once' },
    { optionId: 'apply_network_policy_amendment-example.com', name: 'Yes, and allow this host', kind: 'allow_once' },
    { optionId: 'abort', name: 'No', kind: 'reject_once' },
  ]),
  // Asks, then switches its own mode mid-turn and waits to be cancelled.
  drift: async ({ sessionId, session, argument, tool, permission }) => {
    tool({ toolCallId: 'call_1', title: 'Risky step', kind: 'execute', status: 'pending' })
    const answer = permission({ toolCallId: 'call_1' })
    session.mode = argument
    save()
    reportMode(sessionId, session)
    const { result } = await answer
    log('permission-answer', { outcome: result?.outcome ?? null })
    await waitCancel(sessionId)
    return { stopReason: 'cancelled' }
  },
  parallel: async ({ say, tool, permission }) => {
    tool({ toolCallId: 'call_a', title: 'Job A', kind: 'execute', status: 'pending' })
    tool({ toolCallId: 'call_b', title: 'Job B', kind: 'execute', status: 'pending' })
    const [a, b] = await Promise.all([permission({ toolCallId: 'call_a' }), permission({ toolCallId: 'call_b' })])
    say(`a=${a.result.outcome.optionId} b=${b.result.outcome.optionId}`)
    return END
  },
  withdraw: async ({ sessionId, say, tool }) => {
    tool({ toolCallId: 'call_1', title: 'Maybe', kind: 'execute', status: 'pending' })
    const requestId = nextId
    const answer = request('session/request_permission', { sessionId, toolCall: { toolCallId: 'call_1' }, options: ALLOW_OPTIONS })
    await delay(300)
    send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId } })
    const response = await answer
    tool({ toolCallId: 'call_1', status: 'failed' }, 'tool_call_update')
    say(`withdrawn ${response.error?.code}`)
    return END
  },
  endturn: async ({ sessionId, say, tool }) => {
    say('working')
    tool({ toolCallId: 'call_1', title: 'Long job', kind: 'execute', status: 'in_progress' })
    tool({ toolCallId: 'call_2', title: 'Queued job', kind: 'execute', status: 'pending' })
    await waitCancel(sessionId)
    tool({ toolCallId: 'call_1', status: 'completed', content: [text('stopped cleanly')] }, 'tool_call_update')
    return END
  },
  hang: async ({ say, tool }) => {
    say('working')
    tool({ toolCallId: 'call_1', title: 'Stuck job', kind: 'execute', status: 'in_progress' })
    await new Promise(() => {})
  },
  crash: async ({ say, tool }) => {
    say('partial')
    tool({ toolCallId: 'call_1', title: 'Running job', kind: 'execute', status: 'in_progress' })
    tool({ toolCallId: 'call_2', title: 'Queued job', kind: 'execute', status: 'pending' })
    process.stderr.write(`fatal: token=${env.FAKE_SECRET ?? ''}\n`)
    process.stdout.write('', () => process.exit(3))
    await new Promise(() => {})
  },
  reuse: ({ input, tool }) => {
    tool({ toolCallId: 'call_1', title: input, kind: 'read', status: 'completed', content: [text(input)] })
    return END
  },
  plan: ({ sessionId, say }) => {
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read', priority: 'high', status: 'completed' },
        { content: 'Write', priority: 'medium', status: 'in_progress' },
      ],
    })
    update(sessionId, { sessionUpdate: 'session_info_update', title: 'Fake title' })
    update(sessionId, { sessionUpdate: 'usage_update', used: 10, size: 100 })
    update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'init' }] })
    update(sessionId, { sessionUpdate: 'some_future_kind', anything: true })
    say('planned')
    return { stopReason: 'end_turn', usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 } }
  },
  noise: ({ say }) => {
    process.stdout.write('this line is not json\n')
    say('still fine')
    return END
  },
  flood: async ({ say }) => {
    const chunk = `${'e'.repeat(1023)}\n`.repeat(64)
    for (let index = 0; index < 48; index++) process.stderr.write(chunk)
    say('survived')
    return END
  },
  big: ({ argument, say }) => {
    say('x'.repeat(Number(argument)))
    return END
  },
  'image-output': ({ sessionId, say }) => {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=',
      },
    })
    say('image delivered')
    return END
  },
  stray: ({ sessionId, say }) => {
    say('main')
    setTimeout(() => {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'stray-1', content: { type: 'text', text: 'late' } })
      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'stray-1', content: { type: 'text', text: ' tail' } })
    }, 30)
    return END
  },
  probe: async ({ sessionId, say }) => {
    const response = await request('fs/read_text_file', { sessionId, path: '/etc/hosts' })
    say(`fs:${response.error?.code}`)
    return END
  },
  refuse: () => ({ stopReason: 'refusal' }),
}
