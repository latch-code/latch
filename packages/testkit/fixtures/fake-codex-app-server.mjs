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
// late` turn asks for a command once interrupted. `hold` asks to run `sleep`, which, allowed, starts a real `sleep` in a
// process group of its own that keeps running after the turn is interrupted, as Codex leaves an allowed command running,
// until thread/backgroundTerminals/terminate or a signal ends it; its pid is logged (`command-started`). With
// FAKE_CODEX_TERMINALS=ignore terminate ends nothing, and with `none` Codex has no such requests. FAKE_CODEX_OS_PID is
// the osPid it lists instead of the command's own. `hold` takes words after it: `sub` runs the command on a subagent's
// thread, `early` reports it started before asking (as for an MCP call), `orphan` runs `sleep` behind a shell that
// exits at once, so the group outlives its leader (the item ends only once the group is gone), `self` interrupts the
// turn by itself with no turn/interrupt; FAKE_CODEX_INTERRUPT_STATUS=failed ends an interrupted turn failed. Anything
// else is echoed as `echo: <text>`, as the fake ACP agent does. Text added with turn/steer is replied to in the same turn.
//
// Its own MCP servers: FAKE_CODEX_MCP is a JSON array of `McpServerStatus` (default none), which mcpServerStatus/list
// pages (by `limit`) together with the thread's `config.mcp_servers`, as Codex lists both. With no thread it lists only
// the configured names, each without a runtimeStatus, and leaves out those marked `threadOnly` (a plugin's), as Codex
// 0.167 does. Once a thread opens, each of its own servers reports `starting`, then `ready`, or `failed` for one
// whose runtimeStatus is `failed` (with `reauthenticationRequired` for `authenticationRequired`). FAKE_CODEX_MCP_LIMIT
// makes its pages smaller and FAKE_CODEX_MCP_PAGE_MS answers each page that much later.
//
// The plan's limits: FAKE_CODEX_RATE_LIMITS is the JSON account/rateLimits/read answers (`GetAccountRateLimitsResponse`;
// without it Codex has no such method), and FAKE_CODEX_RATE_LIMITS_UPDATE the `RateLimitSnapshot` it pushes as
// account/rateLimits/updated when a turn ends, or the path of a file holding it, read at each turn's end.
//
// A model provider of its own: `-c model_provider="<id>"` with `-c model_providers.<id>.base_url=…` and `.env_key=…`
// (TOML values, as Codex reads them) makes it the process's provider, as Codex does. account/read then says no OpenAI
// login is needed, and every turn calls `<base_url>/responses` for real, streamed, with the variable `env_key` names as
// its bearer token, replying with the text the service streamed; a failed call fails the turn with the service's words.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

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

/** The `-c key=value` overrides, values read as TOML scalars (a quoted string, a number or a boolean). */
const overrides = {}
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '-c' && args[index] !== '--config') continue
  const setting = args[++index] ?? ''
  const equals = setting.indexOf('=')
  if (equals < 0) continue
  const raw = setting.slice(equals + 1).trim()
  let value = raw
  try {
    value = JSON.parse(raw)
  } catch {}
  overrides[setting.slice(0, equals).trim()] = value
}
const providerId = typeof overrides.model_provider === 'string' ? overrides.model_provider : undefined
const provider = providerId && {
  id: providerId,
  baseURL: overrides[`model_providers.${providerId}.base_url`],
  envKey: overrides[`model_providers.${providerId}.env_key`],
}

/** One turn through the process's own provider: a streamed Responses call, its text deltas joined. */
async function viaProvider(model, text, effort) {
  const token = provider.envKey ? env[provider.envKey] : undefined
  const response = await fetch(`${String(provider.baseURL).replace(/\/+$/u, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      model,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
      ...(effort ? { reasoning: { effort } } : {}),
      stream: true,
    }),
  })
  const body = await response.text()
  log('provider', { status: response.status, model })
  if (!response.ok) return { status: 'failed', error: { message: `unexpected status ${response.status}: ${body.slice(0, 300)}` } }
  let said = ''
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const event = JSON.parse(line.slice(5))
      if (event.type === 'response.output_text.delta') said += event.delta
    } catch {}
  }
  return reply(said)
}
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
  modelProvider: thread.provider ?? 'openai',
  model: thread.model,
  status: { type: 'idle' },
  turns: [],
})

let thread
/** Commands still running, by Codex's process ID: what thread/backgroundTerminals lists and ends. */
const terminals = new Map()
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
  if (word === 'auto-compact-complete' || word === 'auto-compact-unsettled') {
    const item = { type: 'contextCompaction', id: `auto-compact-${randomUUID()}` }
    notify('item/started', { threadId: thread.id, turnId: turn.id, item })
    if (word === 'auto-compact-complete') notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
    return reply('Ordinary turn completed.')
  }
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
  if (word === 'look') {
    // Commands with the actions Codex 0.167 parses for them (shapes recorded from the real binary): a read, a listing,
    // a search, a pipeline it reads as one read, one it does not classify, and one only partly classified.
    const steps = [
      ['cat notes.txt', [{ type: 'read', command: 'cat notes.txt', name: 'notes.txt', path: `${thread.cwd}/notes.txt` }], 'alpha\nbeta\n'],
      ['ls -la docs', [{ type: 'listFiles', command: 'ls -la docs', path: 'docs' }], 'guide.md\n'],
      ["rg -n 'alpha' notes.txt", [{ type: 'search', command: 'rg -n alpha notes.txt', query: 'alpha', path: 'notes.txt' }], '1:alpha\n'],
      ['cat notes.txt | wc -l', [{ type: 'read', command: 'cat notes.txt', name: 'notes.txt', path: `${thread.cwd}/notes.txt` }], '2\n'],
      ['echo ok', [{ type: 'unknown', command: 'echo ok' }], 'ok\n'],
      [
        'cat notes.txt && rm notes.txt',
        [
          { type: 'read', command: 'cat notes.txt', name: 'notes.txt', path: `${thread.cwd}/notes.txt` },
          { type: 'unknown', command: 'rm notes.txt' },
        ],
        '',
      ],
    ]
    for (const [inner, commandActions, aggregatedOutput] of steps) {
      const id = `cmd-${randomUUID()}`
      const command = inner.includes("'") ? `/bin/zsh -lc "${inner}"` : `/bin/zsh -lc '${inner}'`
      const shape = { type: 'commandExecution', id, command, cwd: thread.cwd, commandActions }
      item({ ...shape, status: 'inProgress' }, () => ({ ...shape, status: 'completed', aggregatedOutput, exitCode: 0 }))()
    }
    return reply('looked')
  }
  if (word === 'sections') {
    // A summary in two parts, as Codex streams one: each part starts with its bold title and no break comes between them.
    const id = `think-${randomUUID()}`
    const parts = ['**Checking the project**\n\nReading `AGENTS.md` first.', '**Planning the page**\n\n- one\n- two']
    const end = item({ type: 'reasoning', id, summary: [], content: [] }, () => ({ type: 'reasoning', id, summary: parts, content: [] }))
    for (const [summaryIndex, part] of parts.entries()) {
      notify('item/reasoning/summaryPartAdded', { threadId: thread.id, turnId: turn.id, itemId: id, summaryIndex })
      for (const delta of [part.slice(0, 9), part.slice(9)])
        notify('item/reasoning/summaryTextDelta', { threadId: thread.id, turnId: turn.id, itemId: id, delta, summaryIndex })
    }
    end()
    return reply('planned')
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
  if (
    [
      'tool',
      'tool-fail',
      'tool-unsettled',
      'tool-parallel',
      'tool-ambiguous',
      'tool-wrong-turn',
      'tool-child',
      'tool-missing-fields',
      'tool-not-started',
    ].includes(word)
  ) {
    // Codex starts the MCP call, then asks whether to run it, as the server's elicitation it marks as an approval.
    const calls = (['tool-parallel', 'tool-ambiguous', 'tool-child'].includes(word) ? [0, 1] : [0]).map(index => ({
      type: 'mcpToolCall',
      id: `mcp-${randomUUID()}`,
      server: 'docs',
      tool: 'search',
      arguments: { q: word === 'tool-parallel' ? `latch-${index}` : 'latch' },
      status: 'inProgress',
    }))
    if (word === 'tool-child') calls[1].id = calls[0].id
    if (word === 'tool-missing-fields') {
      delete calls[0].server
      delete calls[0].tool
    }
    const callThread = call => (word === 'tool-child' && call === calls[1] ? 'thread-mcp-child' : thread.id)
    if (word !== 'tool-not-started')
      for (const call of calls) notify('item/started', { threadId: callThread(call), turnId: turn.id, startedAtMs: Date.now(), item: call })
    const answers = await Promise.all(
      calls.map(call =>
        ask('mcpServer/elicitation/request', {
          threadId: callThread(call),
          turnId: word === 'tool-wrong-turn' ? 'another-turn' : turn.id,
          serverName: call.server,
          mode: 'form',
          message: 'Allow the docs tool?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: call.tool, tool_params: call.arguments },
        }),
      ),
    )
    for (let index = calls.length - 1; index >= 0; index--) {
      const answer = answers[index],
        call = calls[index]
      log('answered', { method: 'tool', answer })
      const ran = answer?.action === 'accept'
      if (word !== 'tool-unsettled')
        notify('item/completed', {
          threadId: callThread(call),
          turnId: turn.id,
          completedAtMs: Date.now(),
          item: {
            ...call,
            status: !ran ? 'declined' : word === 'tool-fail' ? 'failed' : 'completed',
            result: ran && word !== 'tool-fail' ? { content: [] } : null,
            error: ran && word === 'tool-fail' ? { message: 'Fixture MCP failure' } : null,
          },
        })
    }
    return reply(answers.some(answer => answer?.action === 'accept') ? 'tool ran' : 'tool not run')
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
  if (word === 'hold') {
    const has = flag => text.split(/\s+/u).includes(flag)
    const id = `cmd-${randomUUID()}`
    const command = 'sleep 40'
    const turnId = turn.id
    const threadId = has('sub') ? `thread-sub-${randomUUID()}` : thread.id
    const shape = { type: 'commandExecution', id, command, cwd: thread.cwd }
    if (has('early')) notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...shape, status: 'inProgress' } })
    const decision =
      turn.policy.approvalPolicy === 'never'
        ? 'accept'
        : ((
            await ask('item/commandExecution/requestApproval', {
              threadId,
              turnId,
              startedAtMs: Date.now(),
              itemId: id,
              command,
              cwd: thread.cwd,
              reason: 'wait',
            })
          )?.decision ?? 'cancel')
    // Unanswered, the item Codex reported started is never reported ended.
    if (decision === 'cancel') return 'interrupted'
    if (decision !== 'accept') return reply('not run')
    const child = has('orphan')
      ? spawn('sh', ['-c', 'sleep 600 >/dev/null 2>&1 & exit 0'], { detached: true, stdio: 'ignore' })
      : spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
    const group = child.pid
    const processId = `proc-${terminals.size + 1}`
    terminals.set(processId, { itemId: id, child, command, threadId })
    log('command-started', { itemId: id, osPid: group })
    const shown = { ...shape, processId }
    if (!has('quiet')) notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...shown, status: 'inProgress' } })
    const ended = code => {
      terminals.delete(processId)
      log('command-ended', { itemId: id })
      notify('item/completed', {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { ...shown, status: 'failed', aggregatedOutput: '', exitCode: code ?? -1 },
      })
    }
    if (has('orphan')) {
      // Done once nothing of its group is left, not when the shell in front of it exits.
      const poll = setInterval(() => {
        try {
          process.kill(-group, 0)
        } catch {
          clearInterval(poll)
          ended(-1)
        }
      }, 50)
    } else child.on('exit', code => ended(code))
    if (has('self')) {
      await sleep(100)
      return 'interrupted'
    }
    // Quiet: no output until it ends. The turn waits on the interrupt, not on the command.
    await new Promise(resolve => {
      turn.interrupt = resolve
    })
    return env.FAKE_CODEX_INTERRUPT_STATUS === 'failed'
      ? { status: 'failed', error: { message: 'Interrupted with an error' } }
      : 'interrupted'
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
  if (text === 'skills-changed') notify('skills/changed', {})
  turn.text = text
  turn.items.push({ type: 'userMessage', id: `user-${randomUUID()}`, clientId: null, content: input })
  notify('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress', items: [] } })
  let outcome
  try {
    // A login gone since the thread started fails the turn as Codex reports an expired login.
    if (env.FAKE_ACP_LOGIN_FILE && !existsSync(env.FAKE_ACP_LOGIN_FILE))
      outcome = { status: 'failed', error: { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized' } }
    else if (provider) outcome = await viaProvider(thread.model, text, thread.effort)
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
  const pushed = env.FAKE_CODEX_RATE_LIMITS_UPDATE
  const limits = pushed?.startsWith('/') ? (existsSync(pushed) ? readFileSync(pushed, 'utf8') : undefined) : pushed
  if (limits) notify('account/rateLimits/updated', { rateLimits: JSON.parse(limits) })
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
    modelProvider: record.provider ?? 'openai',
    serviceTier: null,
    reasoningEffort: record.effort,
    cwd: record.cwd,
    approvalPolicy: record.policy?.approvalPolicy,
    approvalsReviewer: record.policy?.approvalsReviewer,
    sandbox: record.policy?.sandboxPolicy ?? {},
  }
}

const ownMcp = env.FAKE_CODEX_MCP ? JSON.parse(env.FAKE_CODEX_MCP) : []
/** The thread's Latch servers, which Codex lists beside its own. */
let threadMcp = []

function announceMcp(threadId) {
  setTimeout(() => {
    for (const server of ownMcp) notify('mcpServer/startupStatus/updated', { threadId, name: server.name, status: 'starting', error: null })
    setTimeout(() => {
      for (const server of ownMcp) {
        const failed = server.runtimeStatus === 'failed' || server.runtimeStatus === 'authenticationRequired'
        notify('mcpServer/startupStatus/updated', {
          threadId,
          name: server.name,
          status: failed ? 'failed' : 'ready',
          error: failed ? 'start failed' : null,
          ...(server.runtimeStatus === 'authenticationRequired' ? { failureReason: 'reauthenticationRequired' } : {}),
        })
      }
    }, 30)
  }, 10)
}

async function handle(method, params) {
  switch (method) {
    case 'mcpServerStatus/list': {
      if (params.threadId && (!thread || params.threadId !== thread.id))
        throw Object.assign(new Error('thread not loaded'), { code: -32600 })
      const configured = ({ threadOnly, ...server }) => server
      const listed = params.threadId
        ? [
            ...ownMcp.map(configured),
            ...threadMcp.map(name => ({ name, runtimeStatus: 'connected', tools: {}, authStatus: 'unsupported' })),
          ]
        : ownMcp.filter(server => !server.threadOnly).map(server => ({ ...configured(server), runtimeStatus: null, tools: {} }))
      const start = params.cursor ? Number(params.cursor) : 0
      const limit = Number(env.FAKE_CODEX_MCP_LIMIT ?? params.limit ?? 100)
      if (env.FAKE_CODEX_MCP_PAGE_MS) await sleep(Number(env.FAKE_CODEX_MCP_PAGE_MS))
      const next = start + limit < listed.length ? String(start + limit) : null
      return { data: listed.slice(start, start + limit), nextCursor: next }
    }
    case 'thread/backgroundTerminals/list':
      if (env.FAKE_CODEX_TERMINALS === 'none') throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
      return {
        data: [...terminals]
          .filter(([, entry]) => entry.threadId === params.threadId)
          .map(([processId, entry]) => ({
            itemId: entry.itemId,
            processId,
            command: entry.command,
            cwd: thread?.cwd ?? '',
            osPid: env.FAKE_CODEX_OS_PID ? Number(env.FAKE_CODEX_OS_PID) : (entry.child.pid ?? null),
            cpuPercent: null,
            rssKb: null,
          })),
        nextCursor: null,
      }
    case 'thread/backgroundTerminals/terminate': {
      if (env.FAKE_CODEX_TERMINALS === 'none') throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
      const entry = terminals.get(params.processId)
      log('terminate', { processId: params.processId })
      if (!entry || env.FAKE_CODEX_TERMINALS === 'ignore' || entry.threadId !== params.threadId) return { terminated: false }
      process.kill(-entry.child.pid, 'SIGKILL')
      return { terminated: true }
    }
    case 'initialize':
      if (env.FAKE_ACP_INIT_AUTH === '1') throw Object.assign(new Error('Authentication required'), { code: -32000 })
      return { userAgent: `latch/${VERSION} (fake)`, codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'macos' }
    case 'config/read':
      return {
        config: {
          model: env.FAKE_CODEX_MODEL ?? null,
          model_reasoning_effort: null,
          shell_environment_policy: JSON.parse(env.FAKE_CODEX_SHELL_ENVIRONMENT ?? '{}'),
        },
        origins: {},
        layers: null,
      }
    case 'account/logout':
      if (env.FAKE_ACP_LOGIN_FILE && existsSync(env.FAKE_ACP_LOGIN_FILE)) rmSync(env.FAKE_ACP_LOGIN_FILE)
      return {}
    case 'account/rateLimits/read':
      log('rate-limits-read', { params })
      if (!env.FAKE_CODEX_RATE_LIMITS) throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
      return JSON.parse(env.FAKE_CODEX_RATE_LIMITS)
    case 'account/read':
      if (provider) return { account: null, requiresOpenaiAuth: false }
      return env.FAKE_CODEX_LOGGED_OUT === '1' || (env.FAKE_ACP_LOGIN_FILE && !existsSync(env.FAKE_ACP_LOGIN_FILE))
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: 'chatgpt', email: 'person@example.com', planType: 'plus' }, requiresOpenaiAuth: true }
    case 'skills/list': {
      const value = env.FAKE_CODEX_SKILLS_FILE ? readFileSync(env.FAKE_CODEX_SKILLS_FILE, 'utf8') : (env.FAKE_CODEX_SKILLS ?? '[]')
      const report = JSON.parse(value)
      if (report?.error) throw Object.assign(new Error('Directory unavailable: /private/catalogue-error'), { code: -32603 })
      if (typeof report?.waitFor === 'string') while (!existsSync(report.waitFor)) await sleep(10)
      const skills = Array.isArray(report) ? report : report.skills
      return { data: (params.cwds ?? []).map(cwd => ({ cwd, skills, errors: [] })) }
    }
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
        provider: providerId ?? 'openai',
        effort: 'medium',
        policy: {
          approvalPolicy: params.approvalPolicy,
          approvalsReviewer: params.approvalsReviewer,
          sandboxPolicy:
            params.sandbox === 'read-only'
              ? { type: 'readOnly', networkAccess: false }
              : params.sandbox === 'workspace-write'
                ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
                : { type: 'dangerFullAccess' },
        },
        createdAt: now(),
        updatedAt: now(),
        turns: [],
        preview: '',
      }
      save(thread)
      threadMcp = Object.keys(params.config?.mcp_servers ?? {})
      announceMcp(thread.id)
      return opened(thread)
    }
    case 'thread/resume': {
      if (params.cwd === undefined) await sleep(Number(env.FAKE_CODEX_CONTEXT_MS ?? 0))
      const found = threads()[params.threadId]
      if (!found) throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: -32600 })
      if (env.FAKE_CODEX_RESUME_ERROR) throw Object.assign(new Error(env.FAKE_CODEX_RESUME_ERROR), { code: -32600 })
      thread = found
      if (params.model) {
        thread.model = params.model
        save(thread)
      }
      threadMcp = Object.keys(params.config?.mcp_servers ?? {})
      announceMcp(found.id)
      return opened(found)
    }
    case 'thread/read': {
      const found = threads()[params.threadId]
      if (!found) throw Object.assign(new Error(`thread not loaded: ${params.threadId}`), { code: -32600 })
      return { thread: { ...shown(found), turns: params.includeTurns ? found.turns : [] } }
    }
    // As Codex: only the process's provider's threads, unless `modelProviders` names others (`[]`: every provider's).
    case 'thread/list': {
      const wanted = Array.isArray(params.modelProviders) ? params.modelProviders : [providerId ?? 'openai']
      const data = Object.values(threads()).filter(item => !wanted.length || wanted.includes(item.provider ?? 'openai'))
      return { data: data.map(shown), nextCursor: null, backwardsCursor: null }
    }
    case 'thread/compact/start': {
      if (!thread || params.threadId !== thread.id || turn) throw Object.assign(new Error('thread not idle'), { code: -32600 })
      const running = { id: `turn-${randomUUID()}`, items: [], cancelled: false }
      turn = running
      setImmediate(async () => {
        const item = { type: 'contextCompaction', id: `compact-${randomUUID()}` }
        notify('turn/started', { threadId: thread.id, turn: { id: running.id, status: 'inProgress', items: [] } })
        notify('item/started', { threadId: thread.id, turnId: running.id, item })
        if (env.FAKE_CODEX_COMPACT_HOLD === '1')
          await new Promise(resolve => {
            running.interrupt = resolve
          })
        else await sleep(40)
        notify('item/completed', { threadId: thread.id, turnId: running.id, item })
        const status = running.cancelled ? 'interrupted' : env.FAKE_CODEX_COMPACT_FAIL === '1' ? 'failed' : 'completed'
        turn = undefined
        notify('turn/completed', {
          threadId: thread.id,
          turn: { id: running.id, status, error: status === 'failed' ? { message: 'Compaction model unavailable' } : null, items: [] },
        })
        running.settled?.()
      })
      return {}
    }
    case 'turn/start': {
      if (!thread || params.threadId !== thread.id) throw Object.assign(new Error('thread not loaded'), { code: -32600 })
      if (turn) throw Object.assign(new Error('a turn is already running'), { code: -32600 })
      turn = { id: `turn-${randomUUID()}`, items: [], steered: [], policy: params, cancelled: false }
      if (params.model) thread.model = params.model
      if (params.effort) thread.effort = params.effort
      thread.policy = params
      save(thread)
      const id = turn.id
      // A slow answer: a stop sent meanwhile learns the turn's ID from this answer and again from `turn/started`.
      if (env.FAKE_CODEX_START_MS) await new Promise(resolve => setTimeout(resolve, Number(env.FAKE_CODEX_START_MS)))
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
