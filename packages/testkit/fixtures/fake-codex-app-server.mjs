// A deterministic stand-in for `codex app-server` (no network, no model), in the shapes `codex app-server generate-ts`
// gives for Codex 0.167. Run directly (`node fake-codex-app-server.mjs app-server`, `--version`), or as what
// `codex-acp cli app-server` answers when the fake ACP agent is started with those arguments.
//
// Models: FAKE_CODEX_MODELS is a JSON array in Codex's shape; FAKE_CODEX_MODEL the configured model;
// FAKE_CODEX_LIST_ERROR makes model/list fail. FAKE_CODEX_VERSION is what `--version` and the user agent say
// (default 0.167.0); FAKE_CODEX_LOGGED_OUT=1, or a FAKE_ACP_LOGIN_FILE that does not exist, answers account/read as Codex
// does with no login, and account/logout removes that file; FAKE_ACP_INIT_AUTH=1 refuses initialize as a stored login
// the service no longer takes. FAKE_CODEX_STATE names a
// JSON file of threads, so another process can list, read and resume them. Everything received goes to FAKE_ACP_LOG.
//
// A turn plays its first word: `echo <text>` replies with the text in pieces; `think` reasons first; `run` runs a
// command and `edit` changes a file, each asking first unless the turn's approval policy is `never` (a declined call
// is reported declined, a cancelled one ends the turn); `plan` reports a plan; `sleep` runs until interrupted;
// `fail` ends the turn failed after a retry notice; `fetch` asks for network access to example.com; `widen` asks for more
// permissions, `elicit` relays an MCP server's question and `odd` sends a request Codex has no name for, each answered
// before the turn goes on; `sub` has a subagent thread run a command and ask for it; `crash` exits mid-turn. With the
// `auto_review` reviewer, `run` (and `risky run`, which it denies) is decided by Codex's review model, not asked.
// FAKE_CODEX_INTERRUPT_MS delays the end of an interrupted turn; FAKE_CODEX_INTERRUPT_NEVER=1 never ends it; a `sleep
// late` turn asks for a command once interrupted. Anything else is echoed as `echo: <text>`, as the fake ACP agent
// does. Text added with turn/steer is replied to in the same turn.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const env = process.env
// Codex keeps its threads across processes; so does this fake, beside the fake ACP agent's state when no file is named.
const STATE = env.FAKE_CODEX_STATE ?? (env.FAKE_ACP_STATE ? `${env.FAKE_ACP_STATE}.codex-threads.json` : undefined)
const VERSION = env.FAKE_CODEX_VERSION ?? '0.167.0'
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${VERSION}\n`)
  process.exit(0)
}

const log = (event, data = {}) => {
  if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, `${JSON.stringify({ pid: process.pid, event, ...data })}\n`)
}
const effort = (reasoningEffort, description) => ({ reasoningEffort, description })
const models = env.FAKE_CODEX_MODELS
  ? JSON.parse(env.FAKE_CODEX_MODELS)
  : [
      {
        id: 'gpt-fake',
        model: 'gpt-fake',
        displayName: 'GPT Fake',
        description: 'The default',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [effort('low', 'Fast'), effort('medium', 'Balanced'), effort('high', 'Deep')],
      },
      {
        id: 'gpt-fake-mini',
        model: 'gpt-fake-mini',
        displayName: 'GPT Fake Mini',
        description: 'Small',
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [effort('low', 'Fast'), effort('medium', 'Balanced')],
      },
      {
        id: 'gpt-fake-hidden',
        model: 'gpt-fake-hidden',
        displayName: 'Hidden',
        description: '',
        hidden: true,
        isDefault: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [],
      },
    ]

log('start', { cwd: process.cwd(), argv: args, mode: 'app-server', codexPath: env.CODEX_PATH ?? null })
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => Math.floor(Date.now() / 1000)

/** Threads by ID: what thread/list, thread/read and thread/resume see, shared through FAKE_CODEX_STATE. */
function threads() {
  if (!STATE || !existsSync(STATE)) return memory
  try {
    return { ...JSON.parse(readFileSync(STATE, 'utf8')), ...memory }
  } catch {
    return memory
  }
}
const memory = {}
function save(thread) {
  memory[thread.id] = thread
  if (STATE) writeFileSync(STATE, JSON.stringify(threads()))
}
const shown = thread => ({
  id: thread.id,
  sessionId: thread.id,
  cwd: thread.cwd,
  name: null,
  preview: thread.preview ?? '',
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  modelProvider: 'openai',
  model: thread.model,
  status: { type: 'idle' },
  turns: [],
})

let thread
/** The running turn: its ID, what it is waiting on, and how to end it. */
let turn
const asks = new Map()
let nextAsk = 0

function ask(method, params) {
  const id = `ask-${nextAsk++}`
  send({ id, method, params })
  return new Promise(resolve => asks.set(id, resolve))
}

function item(started, done) {
  notify('item/started', { threadId: thread.id, turnId: turn.id, item: started, startedAtMs: Date.now() })
  return () => notify('item/completed', { threadId: thread.id, turnId: turn.id, item: done(), completedAtMs: Date.now() })
}

async function reply(text) {
  const id = `msg-${randomUUID()}`
  const end = item({ type: 'agentMessage', id, text: '' }, () => ({ type: 'agentMessage', id, text }))
  for (const piece of text.match(/.{1,4}/gsu) ?? []) {
    notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: id, delta: piece })
    await sleep(5)
  }
  end()
  turn.items.push({ type: 'agentMessage', id, text })
}

/** Whether a call goes ahead: asked first unless the policy is `never`; `cancel` ends the turn. */
async function allowed(method, params) {
  if (turn.policy.approvalPolicy === 'never') return 'accept'
  const answer = await ask(method, { threadId: thread.id, turnId: turn.id, startedAtMs: Date.now(), ...params })
  return answer?.decision ?? 'cancel'
}

async function play(text) {
  const word = text.trim().split(/\s+/u)[0]
  if (word === 'echo') return reply(`echo: ${text}`)
  if (word === 'think') {
    const id = `think-${randomUUID()}`
    const end = item({ type: 'reasoning', id, summary: [], content: [] }, () => ({
      type: 'reasoning',
      id,
      summary: ['Thought it over'],
      content: [],
    }))
    notify('item/reasoning/summaryTextDelta', {
      threadId: thread.id,
      turnId: turn.id,
      itemId: id,
      delta: 'Thought it over',
      summaryIndex: 0,
    })
    end()
    return reply('thought')
  }
  if (word === 'crash') process.exit(3)
  if (word === 'widen' || word === 'elicit' || word === 'odd') {
    const [method, params] =
      word === 'widen'
        ? [
            'item/permissions/requestApproval',
            {
              itemId: 'perm-1',
              cwd: thread.cwd,
              reason: 'needs the network',
              permissions: { network: { enabled: true }, fileSystem: null },
            },
          ]
        : word === 'elicit'
          ? [
              'mcpServer/elicitation/request',
              { serverName: 'docs', mode: 'form', message: 'Which page?', requestedSchema: {}, _meta: null },
            ]
          : ['item/tool/requestUserInput', { itemId: 'odd-1', questions: [] }]
    const answer = await ask(method, { threadId: thread.id, turnId: turn.id, ...params })
    log('answered', { method, answer })
    return reply(`asked ${word}`)
  }
  if (word === 'legacy') {
    const exec = await ask('execCommandApproval', {
      conversationId: thread.id,
      callId: 'legacy-1',
      command: ['ls'],
      cwd: thread.cwd,
      parsedCmd: [],
    })
    log('answered', { method: 'execCommandApproval', answer: exec })
    const patch = await ask('applyPatchApproval', { conversationId: thread.id, callId: 'legacy-2', fileChanges: {} })
    log('answered', { method: 'applyPatchApproval', answer: patch })
    return reply('asked legacy')
  }
  if (word === 'tool') {
    // Codex starts the MCP call, then asks whether to run it, as the server's elicitation it marks as an approval.
    const id = `mcp-${randomUUID()}`
    const call = { type: 'mcpToolCall', id, server: 'docs', tool: 'search', arguments: { q: 'latch' }, status: 'inProgress' }
    notify('item/started', { threadId: thread.id, turnId: turn.id, startedAtMs: Date.now(), item: call })
    const answer = await ask('mcpServer/elicitation/request', {
      threadId: thread.id,
      turnId: turn.id,
      serverName: 'docs',
      mode: 'form',
      message: 'Allow the docs tool?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'search', tool_params: { q: 'latch' } },
    })
    log('answered', { method: 'tool', answer })
    const ran = answer?.action === 'accept'
    notify('item/completed', {
      threadId: thread.id,
      turnId: turn.id,
      completedAtMs: Date.now(),
      item: { ...call, status: ran ? 'completed' : 'declined', result: ran ? { content: [] } : null, error: null },
    })
    return reply(ran ? 'tool ran' : 'tool not run')
  }
  if (word === 'fetch') {
    const id = `cmd-${randomUUID()}`
    const decision = await allowed('item/commandExecution/requestApproval', {
      itemId: id,
      kind: 'command',
      command: 'curl https://example.com',
      cwd: thread.cwd,
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
    })
    return decision === 'cancel' ? 'interrupted' : reply(`network ${decision}`)
  }
  if (word === 'sub') {
    const child = `thread-sub-${randomUUID()}`
    const id = `cmd-${randomUUID()}`
    const command = 'rm -rf build'
    notify('item/started', {
      threadId: child,
      turnId: 'sub-turn',
      startedAtMs: Date.now(),
      item: { type: 'commandExecution', id, command, cwd: thread.cwd, status: 'inProgress' },
    })
    let answer
    if (turn.policy.approvalsReviewer === 'auto_review') {
      // Codex's review model decides the subagent's call, on the subagent's thread.
      const reviewId = `review-${randomUUID()}`
      const action = { type: 'command', source: 'shell', command, cwd: thread.cwd }
      const common = { threadId: child, turnId: 'sub-turn', startedAtMs: Date.now(), reviewId, targetItemId: id, action }
      notify('item/autoApprovalReview/started', {
        ...common,
        review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null },
      })
      notify('item/autoApprovalReview/completed', {
        ...common,
        completedAtMs: Date.now(),
        decisionSource: 'agent',
        review: { status: 'denied', riskLevel: 'high', userAuthorization: null, rationale: 'Removes the build' },
      })
      answer = { decision: 'decline' }
    } else
      answer = await ask('item/commandExecution/requestApproval', {
        threadId: child,
        turnId: 'sub-turn',
        itemId: id,
        startedAtMs: Date.now(),
        command,
        cwd: thread.cwd,
      })
    log('answered', { method: 'subagent', answer })
    notify('item/completed', {
      threadId: child,
      turnId: 'sub-turn',
      completedAtMs: Date.now(),
      item: {
        type: 'commandExecution',
        id,
        command,
        cwd: thread.cwd,
        status: answer?.decision === 'accept' ? 'completed' : 'declined',
        aggregatedOutput: null,
        exitCode: answer?.decision === 'accept' ? 0 : null,
      },
    })
    return reply('subagent done')
  }
  if (word === 'run' || (word === 'risky' && text.includes('run'))) {
    const id = `cmd-${randomUUID()}`
    const command = 'ls -la'
    if (turn.policy.approvalsReviewer === 'auto_review') {
      // Codex's review model decides instead of the person; a denied call is reported declined and never runs.
      const reviewId = `review-${randomUUID()}`
      const action = { type: 'command', source: 'shell', command, cwd: thread.cwd }
      notify('item/started', {
        threadId: thread.id,
        turnId: turn.id,
        startedAtMs: Date.now(),
        item: { type: 'commandExecution', id, command, cwd: thread.cwd, status: 'inProgress' },
      })
      notify('item/autoApprovalReview/started', {
        threadId: thread.id,
        turnId: turn.id,
        startedAtMs: Date.now(),
        reviewId,
        targetItemId: id,
        review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null },
        action,
      })
      const denied = word === 'risky'
      notify('item/autoApprovalReview/completed', {
        threadId: thread.id,
        turnId: turn.id,
        startedAtMs: Date.now(),
        completedAtMs: Date.now(),
        reviewId,
        targetItemId: id,
        decisionSource: 'agent',
        review: {
          status: denied ? 'denied' : 'approved',
          riskLevel: 'high',
          userAuthorization: null,
          rationale: denied ? 'Deletes too much' : 'Harmless listing',
        },
        action,
      })
      notify('item/completed', {
        threadId: thread.id,
        turnId: turn.id,
        completedAtMs: Date.now(),
        item: {
          type: 'commandExecution',
          id,
          command,
          cwd: thread.cwd,
          status: denied ? 'declined' : 'completed',
          aggregatedOutput: denied ? null : 'file-a\n',
          exitCode: denied ? null : 0,
        },
      })
      return reply(denied ? 'not run' : 'ran it')
    }
    const decision = await allowed('item/commandExecution/requestApproval', { itemId: id, command, cwd: thread.cwd, reason: 'list files' })
    if (decision === 'cancel') return 'interrupted'
    if (decision !== 'accept') {
      item({ type: 'commandExecution', id, command, cwd: thread.cwd, status: 'inProgress' }, () => ({
        type: 'commandExecution',
        id,
        command,
        cwd: thread.cwd,
        status: 'declined',
        aggregatedOutput: null,
        exitCode: null,
      }))()
      return reply('not run')
    }
    const end = item({ type: 'commandExecution', id, command, cwd: thread.cwd, status: 'inProgress' }, () => ({
      type: 'commandExecution',
      id,
      command,
      cwd: thread.cwd,
      status: 'completed',
      aggregatedOutput: 'file-a\nfile-b\n',
      exitCode: 0,
    }))
    notify('item/commandExecution/outputDelta', { threadId: thread.id, turnId: turn.id, itemId: id, delta: 'file-a\n' })
    notify('item/commandExecution/outputDelta', { threadId: thread.id, turnId: turn.id, itemId: id, delta: 'file-b\n' })
    end()
    turn.items.push({
      type: 'commandExecution',
      id,
      command,
      cwd: thread.cwd,
      status: 'completed',
      aggregatedOutput: 'file-a\nfile-b\n',
      exitCode: 0,
    })
    return reply('ran it')
  }
  if (word === 'edit') {
    const id = `patch-${randomUUID()}`
    const changes = [{ path: 'notes.txt', kind: { type: 'add' }, diff: '+hello\n' }]
    const decision = await allowed('item/fileChange/requestApproval', { itemId: id, reason: 'write notes' })
    if (decision === 'cancel') return 'interrupted'
    item({ type: 'fileChange', id, changes, status: 'inProgress' }, () => ({
      type: 'fileChange',
      id,
      changes,
      status: decision === 'accept' ? 'completed' : 'declined',
    }))()
    return reply(decision === 'accept' ? 'edited' : 'not edited')
  }
  if (word === 'plan') {
    notify('turn/plan/updated', {
      threadId: thread.id,
      turnId: turn.id,
      explanation: null,
      plan: [
        { step: 'Read', status: 'completed' },
        { step: 'Write', status: 'inProgress' },
      ],
    })
    return reply('planned')
  }
  if (word === 'sleep') {
    await new Promise(resolve => {
      turn.interrupt = resolve
    })
    return 'interrupted'
  }
  if (word === 'fail') {
    notify('error', { threadId: thread.id, turnId: turn.id, willRetry: true, error: { message: 'stream disconnected, retrying' } })
    notify('error', { threadId: thread.id, turnId: turn.id, willRetry: false, error: { message: 'The model service failed' } })
    return { status: 'failed', error: { message: 'The model service failed', codexErrorInfo: null, additionalDetails: null } }
  }
  return reply(`echo: ${text}`)
}

async function runTurn(input) {
  const text = input.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
  turn.text = text
  turn.items.push({ type: 'userMessage', id: `user-${randomUUID()}`, clientId: null, content: input })
  notify('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress', items: [] } })
  let outcome
  try {
    // A login gone since the thread started fails the turn as Codex reports an expired login.
    if (env.FAKE_ACP_LOGIN_FILE && !existsSync(env.FAKE_ACP_LOGIN_FILE))
      outcome = { status: 'failed', error: { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized' } }
    else outcome = await play(text)
    while (outcome === undefined && turn.steered.length) outcome = await reply(`steered: ${turn.steered.shift()}`)
  } catch (error) {
    outcome = { status: 'failed', error: { message: String(error) } }
  }
  if (turn.cancelled && outcome === undefined) outcome = 'interrupted'
  notify('thread/tokenUsage/updated', {
    threadId: thread.id,
    turnId: turn.id,
    tokenUsage: {
      total: {
        totalTokens: 30,
        inputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 30,
        inputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200000,
    },
  })
  const status = outcome === 'interrupted' ? 'interrupted' : typeof outcome === 'object' ? outcome.status : 'completed'
  thread.turns.push({ id: turn.id, items: turn.items, status })
  thread.preview ||= text.slice(0, 80)
  thread.updatedAt = now()
  save(thread)
  const done = turn
  turn = undefined
  log('completed', { turnId: done.id, status })
  notify('turn/completed', {
    threadId: thread.id,
    turn: { id: done.id, status, error: typeof outcome === 'object' ? outcome.error : null, items: [] },
  })
  done.settled?.()
}

function opened(record) {
  return {
    thread: shown(record),
    model: record.model,
    modelProvider: 'openai',
    serviceTier: null,
    reasoningEffort: record.effort,
    sandbox: {},
  }
}

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      if (env.FAKE_ACP_INIT_AUTH === '1') throw Object.assign(new Error('Authentication required'), { code: -32000 })
      return { userAgent: `latch/${VERSION} (fake)`, codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'macos' }
    case 'config/read':
      return { config: { model: env.FAKE_CODEX_MODEL ?? null, model_reasoning_effort: null }, origins: {}, layers: null }
    case 'account/logout':
      if (env.FAKE_ACP_LOGIN_FILE && existsSync(env.FAKE_ACP_LOGIN_FILE)) rmSync(env.FAKE_ACP_LOGIN_FILE)
      return {}
    case 'account/read':
      return env.FAKE_CODEX_LOGGED_OUT === '1' || (env.FAKE_ACP_LOGIN_FILE && !existsSync(env.FAKE_ACP_LOGIN_FILE))
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: 'chatgpt', email: 'person@example.com', planType: 'plus' }, requiresOpenaiAuth: true }
    case 'model/list': {
      if (env.FAKE_CODEX_LIST_ERROR) throw Object.assign(new Error(env.FAKE_CODEX_LIST_ERROR), { code: -32603 })
      const start = params.cursor ? Number(params.cursor) : 0
      // FAKE_ACP_MODELS_FILE, read on every list, lets a later list leave models out, as the fake ACP agent's does.
      const offered =
        env.FAKE_ACP_MODELS_FILE && existsSync(env.FAKE_ACP_MODELS_FILE)
          ? readFileSync(env.FAKE_ACP_MODELS_FILE, 'utf8').trim().split(',').filter(Boolean)
          : undefined
      const data = models.filter(item => (params.includeHidden || !item.hidden) && (!offered || offered.includes(item.id)))
      const next = start + 2 < data.length ? String(start + 2) : null
      return { data: data.slice(start, start + 2), nextCursor: next }
    }
    case 'thread/start': {
      thread = {
        id: `thread-${randomUUID()}`,
        cwd: params.cwd,
        model: params.model ?? env.FAKE_CODEX_MODEL ?? 'gpt-fake',
        effort: 'medium',
        createdAt: now(),
        updatedAt: now(),
        turns: [],
        preview: '',
      }
      save(thread)
      return opened(thread)
    }
    case 'thread/resume': {
      const found = threads()[params.threadId]
      if (!found) throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: -32600 })
      if (env.FAKE_CODEX_RESUME_ERROR) throw Object.assign(new Error(env.FAKE_CODEX_RESUME_ERROR), { code: -32600 })
      thread = found
      return opened(found)
    }
    case 'thread/read': {
      const found = threads()[params.threadId]
      if (!found) throw Object.assign(new Error(`thread not loaded: ${params.threadId}`), { code: -32600 })
      return { thread: { ...shown(found), turns: params.includeTurns ? found.turns : [] } }
    }
    case 'thread/list':
      return { data: Object.values(threads()).map(shown), nextCursor: null, backwardsCursor: null }
    case 'turn/start': {
      if (!thread || params.threadId !== thread.id) throw Object.assign(new Error('thread not loaded'), { code: -32600 })
      if (turn) throw Object.assign(new Error('a turn is already running'), { code: -32600 })
      turn = { id: `turn-${randomUUID()}`, items: [], steered: [], policy: params, cancelled: false }
      if (params.model) thread.model = params.model
      const id = turn.id
      setImmediate(() => void runTurn(params.input))
      return { turn: { id, status: 'inProgress', items: [], error: null } }
    }
    case 'turn/steer': {
      if (!turn || params.expectedTurnId !== turn.id) throw Object.assign(new Error('no running turn'), { code: -32600 })
      turn.steered.push(params.input.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'))
      return { turnId: turn.id }
    }
    case 'turn/interrupt': {
      if (!turn || params.turnId !== turn.id) return {}
      const running = turn
      running.cancelled = true
      // Codex answers once the turn has aborted.
      const settled = new Promise(resolve => {
        running.settled = resolve
      })
      log('interrupting', { turnId: running.id })
      if (running.text?.includes('late')) {
        const answer = await ask('item/commandExecution/requestApproval', {
          threadId: thread.id,
          turnId: running.id,
          itemId: 'late-1',
          startedAtMs: Date.now(),
          command: 'echo late',
        })
        log('answered', { method: 'late', answer })
      }
      if (env.FAKE_CODEX_INTERRUPT_NEVER === '1') return new Promise(() => {})
      await sleep(Number(env.FAKE_CODEX_INTERRUPT_MS ?? 20))
      running.interrupt?.()
      for (const resolve of asks.values()) resolve({ decision: 'cancel' })
      asks.clear()
      await settled
      log('interrupted', { turnId: running.id })
      return {}
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
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
    const message = JSON.parse(line)
    log('recv', { method: message.method ?? null, id: message.id ?? null, params: message.params, result: message.result })
    if (message.method === undefined && message.id !== undefined) {
      const resolve = asks.get(message.id)
      asks.delete(message.id)
      resolve?.(message.result)
      continue
    }
    if (message.id === undefined || message.method === undefined) continue
    handle(message.method, message.params ?? {}).then(
      result => send({ id: message.id, result }),
      error => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
    )
  }
})
process.stdin.on('end', () => {
  log('exit')
  process.exit(0)
})
