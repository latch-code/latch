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
// Speed: FAKE_CODEX_TIERS=1 gives the default model Codex 0.169's Fast tier (`serviceTiers`); FAKE_CODEX_SERVICE_TIER is
// the configured `service_tier` a new thread starts on. A turn's `serviceTier` moves the thread to that tier.
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
// config/read reports each `-c` key's origin as `sessionFlags`; FAKE_CODEX_CONFIG is more effective config (merged under
// `config`) and FAKE_CODEX_ORIGINS more origins by key, as a person's own config.toml or a managed layer would add.
//
// Deletion (0.170): thread/delete removes a thread and the subagent threads under it, refusing while a fork made by
// thread/fork still refers to it (as a paginated history does) or when FAKE_CODEX_DELETE_FAIL says why; a thread it does
// not know is `thread not found`. fs/readDirectory and fs/remove act only inside FAKE_CODEX_IMAGE_DIR, where pictures
// are kept as Codex keeps them, `generated_images/<thread>/<call>.<ext>`; `initialize` names its parent as the home.
// Policy: FAKE_CODEX_REQUIREMENTS is configRequirements/read's `requirements` (JSON; none: null), and a turn whose
// approval policy, sandbox or reviewer it does not allow is refused as Codex refuses one. FAKE_CODEX_HOOKS is the
// hooks hooks/list reports for every folder (JSON array of `HookMetadata`). A turn `system-error` reports an error and the
// thread's `systemError` status and never completes; `system-quiet` reports the status alone and completes later. Threads carry a `source` (`vscode`; FAKE_CODEX_EXEC_THREADS is a
// JSON array of `exec` threads listed only for `sourceKinds: ["exec"]`).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { png } from './png.mjs'

const env = process.env
// Codex keeps its threads across processes; so does this fake, beside the fake ACP agent's state when no file is named.
const STATE = env.FAKE_CODEX_STATE ?? (env.FAKE_ACP_STATE ? `${env.FAKE_ACP_STATE}.codex-threads.json` : undefined)
const VERSION = env.FAKE_CODEX_VERSION ?? '0.167.0'
const IMAGE_DIR = env.FAKE_CODEX_IMAGE_DIR ?? join(tmpdir(), `latch-fake-codex-images-${process.pid}`, 'generated_images')
// The simulator its latch-browser calls name, in the exact shape the Host's own tools take.
const SIMULATOR_FIXTURE_UDID = '22222222-2222-4222-8222-222222222222'
/** A 1×1 GIF, as Codex's image tool may make one (`GeneratedImageFormat::Gif`). */
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')
const REQUIREMENTS = env.FAKE_CODEX_REQUIREMENTS ? JSON.parse(env.FAKE_CODEX_REQUIREMENTS) : null
const args = process.argv.slice(2)
// `codex debug models`: the bundled catalog, or the one a `-c model_catalog_json=` names, read back.
if (args[0] === 'debug' && args[1] === 'models') {
  process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-5.5', context_window: 272000 }] }))
  process.exit(0)
}
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
  : env.FAKE_ACP_MODELS
    ? env.FAKE_ACP_MODELS.split(',')
        .filter(Boolean)
        .map((id, index) => ({
          id,
          model: id,
          displayName: id,
          description: '',
          hidden: false,
          isDefault: index === 0,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [effort('low', 'Fast'), effort('medium', 'Balanced'), effort('high', 'Deep')],
        }))
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
          ...(env.FAKE_CODEX_TIERS === '1'
            ? {
                serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
                additionalSpeedTiers: ['fast'],
              }
            : {}),
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
async function viaProvider(model, text, effort, onText = reply) {
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
  return onText(said)
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
/** Gone from this process and from the shared file. */
function drop(ids) {
  const all = threads()
  for (const id of ids) {
    delete memory[id]
    delete all[id]
  }
  if (STATE) writeFileSync(STATE, JSON.stringify(all))
}
/** Inside the folder its pictures are kept in, and nowhere else. */
const insideImages = path => typeof path === 'string' && path.startsWith(`${IMAGE_DIR}/`) && !path.includes('..')
/** What configRequirements/read would refuse of a turn's settings, in Codex's words. */
function forbidden(params) {
  if (!REQUIREMENTS) return undefined
  const { allowedApprovalPolicies: policies, allowedSandboxModes: sandboxes, allowedApprovalsReviewers: reviewers } = REQUIREMENTS
  const sandbox =
    params.sandboxPolicy?.type === 'readOnly'
      ? 'read-only'
      : params.sandboxPolicy?.type === 'workspaceWrite'
        ? 'workspace-write'
        : params.sandboxPolicy?.type === 'dangerFullAccess'
          ? 'danger-full-access'
          : params.sandbox
  if (params.approvalPolicy && policies && !policies.includes(params.approvalPolicy)) return `approval_policy ${params.approvalPolicy}`
  if (sandbox && sandboxes && !sandboxes.includes(sandbox)) return `sandbox ${sandbox}`
  if (params.approvalsReviewer && reviewers && !reviewers.includes(params.approvalsReviewer)) return `reviewer ${params.approvalsReviewer}`
  return undefined
}
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
  source: thread.source ?? 'vscode',
  status: { type: 'idle' },
  turns: [],
  ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId, agentNickname: thread.agentNickname } : {}),
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

function announceMember(id, name, parentThreadId = thread.id, report = true) {
  const member = { id, parentThreadId, agentNickname: name, cwd: thread.cwd, provider: thread.provider, turns: [] }
  save(member)
  if (report) notify('thread/started', { thread: shown(member) })
  return member
}

const backgroundMembers = new Map()

function memberTurn(member) {
  return env.FAKE_CODEX_TEAM === 'v2' && member.agentNickname === 'Cedar' ? '00000002-0000-7000-8000-000000000001' : `turn-${member.id}`
}

function finishMember(member, text, status, error) {
  const id = memberTurn(member)
  const item = text === undefined ? undefined : { type: 'agentMessage', id: `answer-${member.id}`, text }
  const terminal = { id, status, items: item ? [item] : [], ...(error ? { error } : {}) }
  member.turns.push(terminal)
  save(member)
  if (env.FAKE_CODEX_TEAM_RECOVERY === '1') return
  if (item) notify('item/completed', { threadId: member.id, turnId: id, item })
  notify('turn/completed', { threadId: member.id, turn: terminal })
}

async function reply(text) {
  const id = `msg-${randomUUID()}`
  // Codex times its items itself: when the message began and ended.
  const startedAtMs = Date.now()
  const end = item({ type: 'agentMessage', id, text: '', startedAtMs }, () => ({
    type: 'agentMessage',
    id,
    text,
    startedAtMs,
    completedAtMs: startedAtMs + 400,
  }))
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
  if (word === 'late-usage') {
    reportTokenUsage(thread.turns.at(-1)?.id, 1, { extraInput: 5, used: 35 })
    await reply('Previous usage arrived.')
    while (!turn.cancelled && !existsSync(join(thread.cwd, 'release-token-usage'))) await sleep(10)
    return turn.cancelled ? 'interrupted' : undefined
  }
  if (word === 'echo') return reply(`echo: ${text}`)
  // `image <result|saved|failed|big|bad|two> [WxH]`: Codex's image tool as 0.170 reports it (`imageGeneration`). Each
  // picture is also saved under FAKE_CODEX_IMAGE_DIR, as Codex keeps them in its home; `saved` sends only that path,
  // with an empty `result` and a `fileId` (as the migration does), for fs/readFile. `big` is over 5 MiB; `bad` is not a
  // picture; `two` makes two pictures in the turn. `WxH` sizes the picture (96x64 by default). With
  // FAKE_CODEX_IMAGE_GATE set, each item stays in progress until that file exists or the turn is interrupted.
  if (word === 'image') {
    const [, how = 'result', size] = text.trim().split(/\s+/u)
    const [width, height] = /^\d+x\d+$/u.test(size ?? '') ? size.split('x').map(Number) : [96, 64]
    let savedPath = ''
    for (const colour of how === 'two'
      ? [
          [74, 120, 220],
          [220, 130, 74],
        ]
      : [[74, 120, 220]]) {
      const id = `ig_${randomUUID()}`
      const bytes =
        how === 'big'
          ? Buffer.concat([png(4, 4), Buffer.alloc(6 * 1024 * 1024)])
          : how === 'bad'
            ? Buffer.from('not a picture')
            : how === 'gif'
              ? GIF
              : png(width, height, colour)
      // One folder per thread, as Codex keeps them, so deleting a thread can take its pictures.
      const folder = join(IMAGE_DIR, thread.id)
      mkdirSync(folder, { recursive: true })
      savedPath = join(folder, `${id}.${how === 'gif' ? 'gif' : 'png'}`)
      writeFileSync(savedPath, bytes)
      const base = { type: 'imageGeneration', id, revisedPrompt: 'a blue gradient', generationId: null, transparentBackground: null }
      notify('item/started', { threadId: thread.id, turnId: turn.id, item: { ...base, status: 'in_progress', result: '' } })
      // An interrupted turn leaves the item in progress, as Codex does.
      while (env.FAKE_CODEX_IMAGE_GATE && !existsSync(env.FAKE_CODEX_IMAGE_GATE)) {
        if (turn.cancelled) return 'interrupted'
        await sleep(10)
      }
      const done =
        how === 'failed'
          ? { ...base, status: 'failed', result: '', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: null } }
          : how === 'saved'
            ? { ...base, status: 'completed', result: '', fileId: 'file_fake', savedPath }
            : { ...base, status: 'completed', result: bytes.toString('base64'), savedPath }
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item: done })
      turn.items.push(done)
    }
    return reply(`[下载 PNG 原图](${savedPath})`)
  }
  // What the thread holds before this turn, as Codex's own record: `remembers: a | b`.
  if (word === 'recall') {
    const said = thread.turns.flatMap(item =>
      item.items
        .filter(entry => entry.type === 'userMessage')
        .map(entry => entry.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')),
    )
    return reply(`remembers: ${said.length ? said.join(' | ') : 'nothing'}`)
  }
  // `ask-user`: Codex's request_user_input with a choice and a free answer (`ask-user secret`: one marked secret);
  // the reply is the answers it got.
  if (word === 'ask-user') {
    const secret = text.includes('secret')
    // `ask-user secret many`: more questions than Latch reads, one of them secret.
    if (text.includes('many')) {
      const answer = await ask('item/tool/requestUserInput', {
        threadId: thread.id,
        turnId: turn.id,
        itemId: `ask-${randomUUID()}`,
        isBlocking: true,
        autoResolutionMs: null,
        questions: Array.from({ length: 11 }, (_, n) => ({
          id: `q${n}`,
          header: 'H',
          question: n === 0 ? 'SECRET-QUESTION-TEXT' : `Question ${n}`,
          isOther: false,
          isSecret: n === 0,
          options: null,
        })),
      })
      return reply(`answers: ${JSON.stringify(answer?.answers ?? null)}`)
    }
    const answer = await ask('item/tool/requestUserInput', {
      threadId: thread.id,
      turnId: turn.id,
      itemId: `ask-${randomUUID()}`,
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'colour',
          header: 'Colour',
          question: 'Which colour?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Red', description: 'Warm' },
            { label: 'Blue', description: 'Cool' },
          ],
        },
        { id: 'name', header: 'Name', question: 'What is it called?', isOther: false, isSecret: secret, options: null },
      ],
    })
    return reply(`answers: ${JSON.stringify(answer?.answers ?? null)}`)
  }
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
      'tool-simulator-input',
    ].includes(word)
  ) {
    // Codex starts the MCP call, then asks whether to run it, as the server's elicitation it marks as an approval.
    const simulator = word === 'tool-simulator-input'
    const tools = simulator
      ? [
          { server: 'latch-browser', tool: 'device_type_text', arguments: { udid: SIMULATOR_FIXTURE_UDID, text: 'violet ocean note' } },
          { server: 'latch-browser', tool: 'device_tap', arguments: { udid: SIMULATOR_FIXTURE_UDID, x: 91.125, y: 213.375 } },
          {
            server: 'latch-browser',
            tool: 'device_swipe',
            arguments: { udid: SIMULATOR_FIXTURE_UDID, fromX: 197.25, fromY: 433.625, toX: 81.125, toY: 193.375 },
          },
        ]
      : (['tool-parallel', 'tool-ambiguous', 'tool-child'].includes(word) ? [0, 1] : [0]).map(index => ({
          server: 'docs',
          tool: 'search',
          arguments: { q: word === 'tool-parallel' ? `latch-${index}` : 'latch' },
        }))
    const calls = tools.map(tool => ({
      type: 'mcpToolCall',
      id: `mcp-${randomUUID()}`,
      status: 'inProgress',
      ...tool,
    }))
    if (word === 'tool-child') calls[1].id = calls[0].id
    if (word === 'tool-missing-fields') {
      delete calls[0].server
      delete calls[0].tool
    }
    if (word === 'tool-child') announceMember('thread-mcp-child', 'MCP Agent')
    const callThread = call => (word === 'tool-child' && call === calls[1] ? 'thread-mcp-child' : thread.id)
    if (word !== 'tool-not-started')
      for (const call of calls) notify('item/started', { threadId: callThread(call), turnId: turn.id, startedAtMs: Date.now(), item: call })
    if (simulator && env.FAKE_CODEX_SIMULATOR_APPROVAL_GATE) while (!existsSync(env.FAKE_CODEX_SIMULATOR_APPROVAL_GATE)) await sleep(10)
    const answers = await Promise.all(
      calls.map(call =>
        ask('mcpServer/elicitation/request', {
          threadId: callThread(call),
          turnId: word === 'tool-wrong-turn' ? 'another-turn' : turn.id,
          serverName: call.server,
          mode: 'form',
          message: simulator ? `Allow ${JSON.stringify(call.arguments)}?` : 'Allow the docs tool?',
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
  if (word === 'team' || text.startsWith('请启动 Codex 的子 Agent')) {
    const source = thread.id
    const ordering = text.includes('审批排序夹具')
    const a = announceMember(`child-${randomUUID()}`, 'Cedar')
    const b = announceMember(`child-${randomUUID()}`, 'Maple', thread.id, ordering)
    const c = provider || ordering ? announceMember(`child-${randomUUID()}`, 'Pine') : undefined
    const assignments = [[a, '检查窄屏'], [b, '核对回执'], ...(c ? [[c, '检查模型授权']] : [])]
    const memberApproval = () =>
      ask('item/commandExecution/requestApproval', {
        threadId: b.id,
        turnId: memberTurn(b),
        itemId: 'team-command',
        command: 'ls -la',
        cwd: thread.cwd,
      })
    const earlyApproval = env.FAKE_CODEX_TEAM_EARLY_APPROVAL === '1' ? memberApproval() : undefined
    if (earlyApproval) await sleep(150)
    for (const [member, prompt] of assignments) {
      const event = {
        threadId: source,
        turnId: turn.id,
        item:
          env.FAKE_CODEX_TEAM === 'v2'
            ? {
                type: 'subAgentActivity',
                id: `spawn-${member.id}`,
                agentThreadId: member.id,
                agentPath: member.agentNickname,
                kind: 'started',
              }
            : {
                type: 'collabAgentToolCall',
                id: `spawn-${member.id}`,
                tool: 'spawnAgent',
                status: 'completed',
                senderThreadId: source,
                receiverThreadIds: [member.id],
                prompt,
                agentsStates: { [member.id]: { status: 'running' } },
              },
      }
      notify('turn/started', { threadId: member.id, turn: { id: memberTurn(member), status: 'inProgress' } })
      notify('item/completed', event)
      notify('item/completed', event)
    }
    if (provider) {
      const lead = await viaProvider(thread.model, text, thread.effort, result => result)
      if (typeof lead !== 'string') return lead
      for (const [member, assignment] of assignments) {
        const model = member === c ? 'model-outside-this-lease' : thread.model
        const answer = await viaProvider(model, assignment, thread.effort, result => result)
        if (typeof answer === 'string') finishMember(member, answer, 'completed')
        else finishMember(member, undefined, 'failed', answer.error)
      }
      return reply(lead)
    }
    if (ordering) {
      const answers = assignments.map(([member], index) =>
        ask('item/commandExecution/requestApproval', {
          threadId: member.id,
          turnId: memberTurn(member),
          itemId: `ordered-${index}`,
          command: `echo approval ${index + 1}`,
          cwd: thread.cwd,
        }),
      )
      await Promise.all(answers)
      for (const [member] of assignments) finishMember(member, 'Member decisions settled', 'completed')
      return reply('All member decisions settled')
    }
    const nestedOnly = text.includes('孙成员停止夹具')
    const background = Number(env.FAKE_CODEX_TEAM_BACKGROUND_MS ?? (text.includes('后台停止夹具') || nestedOnly ? 5000 : 0))
    if (background) {
      const call =
        env.FAKE_CODEX_TEAM_BACKGROUND_COMMAND || text.includes('后台停止夹具')
          ? { type: 'commandExecution', id: 'background-member-command', command: 'ls', cwd: thread.cwd, status: 'inProgress' }
          : undefined
      if (call) {
        // Tool item IDs are scoped to their native threads. Maple's same-named tool completing leaves Cedar's live.
        notify('item/started', { threadId: a.id, turnId: memberTurn(a), item: call })
        notify('item/started', { threadId: b.id, turnId: memberTurn(b), item: call })
        notify('item/completed', { threadId: b.id, turnId: memberTurn(b), item: { ...call, status: 'completed' } })
      }
      finishMember(b, 'Maple finished before the lead', 'completed')
      if (nestedOnly || env.FAKE_CODEX_TEAM_NESTED === '1') {
        const descendant = announceMember(`child-${randomUUID()}`, 'Cedar delegate', a.id)
        notify('turn/started', { threadId: descendant.id, turn: { id: memberTurn(descendant), status: 'inProgress' } })
        const end = setTimeout(() => {
          backgroundMembers.delete(descendant.id)
          finishMember(descendant, 'Nested finished on its own', 'completed')
        }, background)
        backgroundMembers.set(descendant.id, {
          id: memberTurn(descendant),
          stop: () => {
            clearTimeout(end)
            backgroundMembers.delete(descendant.id)
            setTimeout(() => {
              finishMember(descendant, undefined, 'interrupted')
              log('nested-member-interrupted')
            }, 800)
          },
        })
      }
      if (nestedOnly) {
        finishMember(a, 'Cedar finished its own work', 'completed')
        return reply('Lead and direct members have finished')
      }
      const commandEnded = () => {
        if (call)
          notify('item/completed', { threadId: a.id, turnId: memberTurn(a), item: { ...call, status: 'completed', aggregatedOutput: '' } })
      }
      const timer = setTimeout(() => {
        backgroundMembers.delete(a.id)
        finishMember(a, 'Cedar finished after the lead', 'completed')
        commandEnded()
      }, background)
      backgroundMembers.set(a.id, {
        id: memberTurn(a),
        stop: () => {
          clearTimeout(timer)
          backgroundMembers.delete(a.id)
          setTimeout(() => {
            finishMember(a, undefined, 'interrupted')
            log('background-member-interrupted')
            const done = () => {
              if (env.FAKE_CODEX_TEAM_STOP_GATE && !existsSync(env.FAKE_CODEX_TEAM_STOP_GATE)) {
                setTimeout(done, 25)
                return
              }
              commandEnded()
              log('background-command-ended')
            }
            setTimeout(done, 350)
          }, 50)
        },
      })
      return reply('Lead finished before Cedar')
    }
    const foreign = announceMember(`child-${randomUUID()}`, '外部成员', 'another-root')
    notify('item/completed', {
      threadId: source,
      turnId: turn.id,
      item: {
        type: 'collabAgentToolCall',
        id: 'invalid-parent-spawn',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: source,
        receiverThreadIds: [foreign.id],
        prompt: '不属于这次任务',
        agentsStates: {},
      },
    })
    notify('item/completed', {
      threadId: foreign.id,
      turnId: 'foreign-turn',
      item: { type: 'agentMessage', id: 'foreign-result', text: '不属于这次任务' },
    })
    const rejected = await ask('item/commandExecution/requestApproval', {
      threadId: foreign.id,
      turnId: 'foreign-turn',
      itemId: 'foreign-command',
      command: 'pwd',
    })
    log('answered', { method: 'foreign-team-approval', answer: rejected })
    const answer = await (earlyApproval ?? memberApproval())
    const cedarResult = env.FAKE_CODEX_TEAM_MARKDOWN === '1' ? '**已核对手机布局**\n\n```sh\npnpm test\n```' : '已核对手机布局'
    finishMember(a, cedarResult, 'completed')
    if (env.FAKE_CODEX_TEAM_SECOND_TURN === '1') {
      const id = 'cedar-second-turn'
      notify('turn/started', { threadId: a.id, turn: { id, status: 'inProgress' } })
      notify('turn/completed', { threadId: a.id, turn: { id, status: 'failed', error: { message: '下一轮失败' } } })
    }
    if (env.FAKE_CODEX_TEAM_SETTLE_MS && answer?.decision === 'accept') {
      const call = { type: 'commandExecution', id: 'team-command', command: 'ls -la', cwd: thread.cwd, status: 'inProgress' }
      notify('item/started', { threadId: b.id, turnId: memberTurn(b), item: call })
      log('team-command-started')
      await new Promise(resolve => {
        turn.interrupt = resolve
      })
      finishMember(b, undefined, 'interrupted')
      log('team-child-interrupted')
      setTimeout(() => {
        notify('item/completed', { threadId: b.id, turnId: memberTurn(b), item: { ...call, status: 'declined', aggregatedOutput: '' } })
        log('team-command-ended')
      }, Number(env.FAKE_CODEX_TEAM_SETTLE_MS))
      return 'interrupted'
    }
    if (answer?.decision === 'cancel') {
      finishMember(b, undefined, 'interrupted')
      return 'interrupted'
    }
    finishMember(b, '回执检查被拒绝', env.FAKE_CODEX_TEAM_RECOVERY === '1' ? 'interrupted' : 'failed')
    if (env.FAKE_CODEX_TEAM === 'v2') {
      const old = '00000001-0000-7000-8000-000000000001'
      notify('turn/started', { threadId: a.id, turn: { id: old, status: 'inProgress' } })
      notify('item/completed', {
        threadId: a.id,
        turnId: old,
        item: { type: 'agentMessage', id: 'late-child-output', text: '旧轮迟到' },
      })
    }
    return reply(`team summary: ${answer?.decision}`)
  }
  if (word === 'sub') {
    const child = `thread-sub-${randomUUID()}`
    announceMember(child, '子 Agent')
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
    const threadId = has('sub') ? announceMember(`thread-sub-${randomUUID()}`, '子 Agent').id : thread.id
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
  // As Codex marks a thread after an error event it cannot attach to the turn: the status, and no turn/completed.
  if (word === 'system-error') {
    notify('error', { threadId: thread.id, turnId: turn.id, willRetry: false, error: { message: 'The session hit an internal error' } })
    notify('thread/status/changed', { threadId: thread.id, status: { type: 'systemError' } })
    await new Promise(resolve => {
      turn.interrupt = resolve
    })
    return 'interrupted'
  }
  // As after an error Codex does not end turns for (a failed rollback): the status alone, then the turn goes on quietly.
  if (word === 'system-quiet') {
    notify('thread/status/changed', { threadId: thread.id, status: { type: 'systemError' } })
    await sleep(400)
    return reply('went on')
  }
  if (word === 'fail') {
    notify('error', { threadId: thread.id, turnId: turn.id, willRetry: true, error: { message: 'stream disconnected, retrying' } })
    notify('error', { threadId: thread.id, turnId: turn.id, willRetry: false, error: { message: 'The model service failed' } })
    return { status: 'failed', error: { message: 'The model service failed', codexErrorInfo: null, additionalDetails: null } }
  }
  return reply(`echo: ${text}`)
}

// The thread's whole count grows by one model call a turn; each call after the first reads 16 of its 20 from the cache.
function reportTokenUsage(turnId, calls, { used = 30, extraInput = 0 } = {}) {
  notify('thread/tokenUsage/updated', {
    threadId: thread.id,
    ...(turnId ? { turnId } : {}),
    tokenUsage: {
      total: {
        totalTokens: 30 * calls + extraInput,
        inputTokens: 20 * calls + extraInput,
        cachedInputTokens: 16 * (calls - 1),
        cacheWriteInputTokens: 0,
        outputTokens: 10 * calls,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: used,
        inputTokens: used - 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      },
      // The thread's configured window; FAKE_CODEX_NO_CONTEXT_WINDOW: none reported, as for a model Codex cannot size.
      ...(env.FAKE_CODEX_NO_CONTEXT_WINDOW === '1' ? {} : { modelContextWindow: threadWindow ?? 200000 }),
    },
  })
}

async function runTurn(input, clientId = null) {
  const text = input.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
  if (text === 'skills-changed') notify('skills/changed', {})
  turn.text = text
  // As Codex 0.169: `clientUserMessageId` stays on the turn's user message, unless FAKE_CODEX_NO_CLIENT_ID drops it.
  turn.items.push({
    type: 'userMessage',
    id: `user-${randomUUID()}`,
    clientId: env.FAKE_CODEX_NO_CLIENT_ID === '1' ? null : clientId,
    content: input,
  })
  notify('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress', items: [] } })
  let outcome
  try {
    // A login gone since the thread started fails the turn as Codex reports an expired login.
    if (env.FAKE_ACP_LOGIN_FILE && !existsSync(env.FAKE_ACP_LOGIN_FILE))
      outcome = { status: 'failed', error: { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized' } }
    else if (!provider || text.trim().split(/\s+/u)[0] === 'team' || text.startsWith('请启动 Codex 的子 Agent')) outcome = await play(text)
    else outcome = await viaProvider(thread.model, text, thread.effort)
    while (outcome === undefined && turn.steered.length) outcome = await reply(`steered: ${turn.steered.shift()}`)
  } catch (error) {
    outcome = { status: 'failed', error: { message: String(error) } }
  }
  if (turn.cancelled && outcome === undefined) outcome = 'interrupted'
  const calls = thread.turns.length + 1
  const late = text === 'late-usage'
  const lateAfter = text === 'late-usage-after'
  reportTokenUsage(text === 'legacy-usage' ? undefined : turn.id, calls, { extraInput: late || lateAfter ? 5 : 0 })
  if (late) {
    reportTokenUsage(thread.turns.at(-1)?.id, calls, { extraInput: 7, used: 35 })
    reportTokenUsage(thread.turns.at(-1)?.id, 1, { extraInput: 5, used: 35 })
  }
  if (lateAfter) {
    await reply('Current usage arrived.')
    while (!turn.cancelled && !existsSync(join(thread.cwd, 'release-token-usage'))) await sleep(10)
    reportTokenUsage('other-older-turn', 1, { extraInput: 8, used: 38 })
    reportTokenUsage(thread.turns.at(-1)?.id, 1, { extraInput: 5, used: 35 })
  }
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
    serviceTier: record.tier ?? null,
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
/** The `model_context_window` the thread was opened or resumed with. */
let threadWindow

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
    // Only the pictures it saved itself, as a fake has no business reading anything else.
    case 'fs/readFile': {
      if (typeof params.path !== 'string' || !params.path.startsWith(`${IMAGE_DIR}/`) || params.path.includes('..'))
        throw Object.assign(new Error('not found'), { code: -32603 })
      return { dataBase64: readFileSync(params.path).toString('base64') }
    }
    case 'fs/readDirectory': {
      if (!insideImages(params.path) || !existsSync(params.path)) throw Object.assign(new Error('not found'), { code: -32603 })
      return {
        entries: readdirSync(params.path, { withFileTypes: true }).map(entry => ({
          fileName: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        })),
      }
    }
    // Only what it keeps itself; a directory goes only when empty unless `recursive`, as Codex's `remove_dir`.
    case 'fs/remove': {
      if (!insideImages(params.path)) throw Object.assign(new Error('outside the fake home'), { code: -32603 })
      log('removed', { path: params.path, recursive: params.recursive ?? true })
      if (!existsSync(params.path)) {
        if (params.force === false) throw Object.assign(new Error('not found'), { code: -32603 })
        return {}
      }
      if (statSync(params.path).isDirectory()) {
        if (params.recursive === false) rmdirSync(params.path)
        else rmSync(params.path, { recursive: true })
      } else rmSync(params.path)
      return {}
    }
    case 'thread/delete': {
      const all = threads()
      if (!all[params.threadId]) throw Object.assign(new Error(`thread not found: ${params.threadId}`), { code: -32600 })
      if (env.FAKE_CODEX_DELETE_FAIL)
        throw Object.assign(new Error(`thread ${params.threadId} cannot be deleted: ${env.FAKE_CODEX_DELETE_FAIL}`), { code: -32600 })
      if (Object.values(all).some(item => item.forkedFrom === params.threadId))
        throw Object.assign(new Error(`thread ${params.threadId} cannot be deleted because forked history still references it`), {
          code: -32600,
        })
      const subtree = [params.threadId]
      for (let index = 0; index < subtree.length; index++)
        for (const item of Object.values(all)) if (item.parentThreadId === subtree[index]) subtree.push(item.id)
      drop(subtree.toReversed())
      for (const id of subtree.toReversed()) notify('thread/deleted', { threadId: id })
      log('deleted', { threadId: params.threadId, subtree })
      return {}
    }
    // FAKE_CODEX_REQUIREMENTS_HIDDEN: enforced, but not said (a Codex whose answer Latch cannot read).
    case 'configRequirements/read':
      return { requirements: env.FAKE_CODEX_REQUIREMENTS_HIDDEN === '1' ? null : REQUIREMENTS }
    case 'hooks/list': {
      const hooks = env.FAKE_CODEX_HOOKS ? JSON.parse(env.FAKE_CODEX_HOOKS) : []
      // No folders named: the process's own, as Codex 0.170 answers.
      const cwds = params.threadId ? [thread?.cwd ?? ''] : params.cwds?.length ? params.cwds : [process.cwd()]
      return { data: cwds.map(cwd => ({ cwd, hooks, warnings: [], errors: [] })) }
    }
    case 'initialize':
      if (env.FAKE_ACP_INIT_AUTH === '1') throw Object.assign(new Error('Authentication required'), { code: -32000 })
      return { userAgent: `latch/${VERSION} (fake)`, codexHome: dirname(IMAGE_DIR), platformFamily: 'unix', platformOs: 'macos' }
    case 'config/read': {
      const flags = Object.fromEntries(Object.keys(overrides).map(key => [key, { name: { type: 'sessionFlags' }, version: 'flags' }]))
      return {
        config: {
          model: env.FAKE_CODEX_MODEL ?? null,
          model_reasoning_effort: null,
          service_tier: env.FAKE_CODEX_SERVICE_TIER ?? null,
          shell_environment_policy: JSON.parse(env.FAKE_CODEX_SHELL_ENVIRONMENT ?? '{}'),
          ...JSON.parse(env.FAKE_CODEX_CONFIG ?? '{}'),
        },
        origins: { ...flags, ...JSON.parse(env.FAKE_CODEX_ORIGINS ?? '{}') },
        layers: null,
      }
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
      const refused = forbidden(params)
      if (refused) throw Object.assign(new Error(`invalid config override: ${refused} is not allowed by requirements`), { code: -32600 })
      if (
        env.FAKE_CODEX_PERSIST_START_TRUST === '1'
        && params.cwd
        && params.sandbox !== 'read-only'
        && existsSync(join(params.cwd, '.git'))
      ) {
        const config = join(env.CODEX_HOME, 'config.toml')
        writeFileSync(config, `${readFileSync(config, 'utf8')}\n[projects.${JSON.stringify(params.cwd)}]\ntrust_level = "trusted"\n`)
      }
      thread = {
        id: `thread-${randomUUID()}`,
        cwd: params.cwd,
        model: params.model ?? env.FAKE_CODEX_MODEL ?? 'gpt-fake',
        provider: providerId ?? 'openai',
        effort: 'medium',
        tier: params.serviceTier ?? env.FAKE_CODEX_SERVICE_TIER ?? null,
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
      threadWindow = params.config?.model_context_window
      announceMcp(thread.id)
      return opened(thread)
    }
    case 'thread/resume': {
      if (params.cwd === undefined) await sleep(Number(env.FAKE_CODEX_CONTEXT_MS ?? 0))
      const found = threads()[params.threadId]
      if (!found) throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: -32600 })
      if (env.FAKE_CODEX_RESUME_ERROR) throw Object.assign(new Error(env.FAKE_CODEX_RESUME_ERROR), { code: -32600 })
      // As Codex 0.169: a thread resumes only on the provider it began on, and only where that provider is configured.
      const began = found.provider ?? 'openai'
      if (params.modelProvider && params.modelProvider !== began)
        throw Object.assign(
          new Error(
            `failed to load configuration: Cannot change this thread's model provider from \`${began}\` to \`${params.modelProvider}\` on resume.`,
          ),
          { code: -32600 },
        )
      if (began !== 'openai' && began !== providerId && overrides[`model_providers.${began}.base_url`] === undefined)
        throw Object.assign(new Error(`This chat uses model provider “${began}”, which is no longer configured.`), { code: -32600 })
      thread = found
      if (params.model) {
        thread.model = params.model
        save(thread)
      }
      threadMcp = Object.keys(params.config?.mcp_servers ?? {})
      threadWindow = params.config?.model_context_window
      announceMcp(found.id)
      return opened(found)
    }
    // As Codex 0.169: a fork may name another provider; it is a new thread with the source's turns.
    case 'thread/fork': {
      const found = threads()[params.threadId]
      if (!found) throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: -32600 })
      // Onto another provider without a model named, the fork takes the process's configured model, as Codex 0.169 does.
      const onto = params.modelProvider ?? providerId ?? 'openai'
      // `lastTurnId`: through that turn only, as Codex 0.169 forks; FAKE_CODEX_FORK_WHOLE: a Codex that ignores it.
      const through =
        env.FAKE_CODEX_FORK_WHOLE === '1' || !params.lastTurnId ? -1 : found.turns.findIndex(item => item.id === params.lastTurnId)
      if (params.lastTurnId && env.FAKE_CODEX_FORK_WHOLE !== '1' && through < 0)
        throw Object.assign(new Error(`turn not found: ${params.lastTurnId}`), { code: -32600 })
      thread = {
        ...structuredClone(found),
        ...(through >= 0 ? { turns: structuredClone(found.turns.slice(0, through + 1)) } : {}),
        id: `thread-${randomUUID()}`,
        forkedFrom: found.id,
        provider: onto,
        model: params.model ?? (onto === (found.provider ?? 'openai') ? found.model : (env.FAKE_CODEX_MODEL ?? 'gpt-fake')),
        createdAt: now(),
        updatedAt: now(),
      }
      save(thread)
      threadMcp = Object.keys(params.config?.mcp_servers ?? {})
      threadWindow = params.config?.model_context_window
      announceMcp(thread.id)
      return opened(thread)
    }
    case 'thread/archive': {
      if (env.FAKE_CODEX_ARCHIVE_FAIL === '1') throw Object.assign(new Error('archive failed'), { code: -32603 })
      log('archived', { threadId: params.threadId })
      return {}
    }
    case 'thread/read': {
      const found = threads()[params.threadId]
      if (!found) throw Object.assign(new Error(`thread not loaded: ${params.threadId}`), { code: -32600 })
      return { thread: { ...shown(found), turns: params.includeTurns ? found.turns : [] } }
    }
    case 'thread/turns/list': {
      const found = threads()[params.threadId]
      if (!found) throw Object.assign(new Error('thread not found'), { code: -32600 })
      const turns = found.turns.toReversed().slice(0, params.limit ?? 1)
      return {
        data: turns.map(turn => ({ ...turn, items: params.itemsView === 'notLoaded' ? [] : turn.items })),
        nextCursor: null,
        backwardsCursor: null,
      }
    }
    case 'thread/items/list': {
      const found = threads()[params.threadId]
      const selected = found?.turns.find(turn => turn.id === params.turnId)
      if (!selected) throw Object.assign(new Error('turn not found'), { code: -32600 })
      return { data: selected.items.toReversed().slice(0, params.limit ?? 24), nextCursor: null, backwardsCursor: null }
    }
    case 'experimentalFeature/list':
      return { data: [{ name: 'multi_agent', enabled: env.FAKE_CODEX_TEAM !== 'off' }], nextCursor: null }
    // As Codex: only the process's provider's threads, unless `modelProviders` names others (`[]`: every provider's).
    // `sourceKinds` absent or empty: the interactive sources only; `exec` threads only when asked for. `sortKey`:
    // `updated_at`, else by creation, newest first. `limit` and a numeric `cursor` page the result.
    case 'thread/list': {
      const wanted = Array.isArray(params.modelProviders) ? params.modelProviders : [providerId ?? 'openai']
      const kinds = Array.isArray(params.sourceKinds) && params.sourceKinds.length ? params.sourceKinds : ['cli', 'vscode']
      const exec = env.FAKE_CODEX_EXEC_THREADS ? JSON.parse(env.FAKE_CODEX_EXEC_THREADS).map(item => ({ ...item, source: 'exec' })) : []
      const data = [...Object.values(threads()), ...exec]
        .filter(item => {
          if (params.parentThreadId ? item.parentThreadId !== params.parentThreadId : item.parentThreadId) return false
          if (!params.parentThreadId && !kinds.includes(item.source ?? 'vscode')) return false
          return !wanted.length || wanted.includes(item.provider ?? 'openai')
        })
        .toSorted((a, b) =>
          params.sortKey === 'updated_at' ? (b.updatedAt ?? 0) - (a.updatedAt ?? 0) : (b.createdAt ?? 0) - (a.createdAt ?? 0),
        )
      log('listed', { params })
      const start = params.cursor ? Number(params.cursor) : 0
      const limit = params.limit ?? data.length
      const next = start + limit < data.length ? String(start + limit) : null
      return { data: data.slice(start, start + limit).map(shown), nextCursor: next, backwardsCursor: null }
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
      const refused = forbidden(params)
      if (refused)
        throw Object.assign(new Error(`invalid thread settings override: ${refused} is not allowed by requirements`), { code: -32600 })
      if (turn) throw Object.assign(new Error('a turn is already running'), { code: -32600 })
      turn = { id: `turn-${randomUUID()}`, items: [], steered: [], policy: params, cancelled: false }
      if (params.model) thread.model = params.model
      if (params.effort) thread.effort = params.effort
      if (params.serviceTier !== undefined) thread.tier = params.serviceTier
      thread.policy = params
      save(thread)
      const id = turn.id
      // A slow answer: a stop sent meanwhile learns the turn's ID from this answer and again from `turn/started`.
      if (env.FAKE_CODEX_START_MS) await new Promise(resolve => setTimeout(resolve, Number(env.FAKE_CODEX_START_MS)))
      setImmediate(() => void runTurn(params.input, params.clientUserMessageId ?? null))
      return { turn: { id, status: 'inProgress', items: [], error: null } }
    }
    case 'turn/steer': {
      if (!turn || params.expectedTurnId !== turn.id) throw Object.assign(new Error('no running turn'), { code: -32600 })
      turn.steered.push(params.input.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'))
      return { turnId: turn.id }
    }
    case 'turn/interrupt': {
      const background = backgroundMembers.get(params.threadId)
      if (background?.id === params.turnId) {
        background.stop()
        return {}
      }
      if (!turn || params.turnId !== turn.id || params.threadId !== thread.id) return {}
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
