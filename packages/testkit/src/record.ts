/**
 * Records a scenario from a real agent, for the owner of this computer to run by hand (`pnpm harness:record`): the real
 * ACP driver plays the scenario while `fixtures/record-tee.mjs` starts the agent in a sandbox with a home of
 * its own and writes every frame. Its only network connections are to the fake model services' port on this computer, so
 * neither a host elsewhere nor a local proxy is reachable; local sockets stay open. The result is normalised and redacted,
 * and written to a directory for a person to read before it joins the fixtures.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeModels, type FakeReply } from './fake-models.ts'
import {
  formatTranscript,
  playScenario,
  sanitizeEntries,
  type LogicalFrame,
  type ReplayEntry,
  type ScenarioBridge,
  type ScenarioStep,
  type Transcript,
} from './replay.ts'

export const RECORD_TEE: string = fileURLToPath(new URL('../fixtures/record-tee.mjs', import.meta.url))
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** The scenarios a recording can play, with what the fake model answers in each. */
export const RECORD_SCENARIOS: Record<string, { steps: ScenarioStep[]; replies: FakeReply[] }> = {
  simple: {
    steps: [{ step: 'prompt', text: 'Say hello' }, { step: 'settle' }],
    replies: [{ reasoning: 'A greeting.', text: 'Hello! What should we work on?' }],
  },
  tool_approve: {
    steps: [{ step: 'prompt', text: 'Run the tests' }, { step: 'answer', decision: 'allow' }, { step: 'settle' }],
    replies: [{ tool: { name: /shell|bash|command|exec/iu, input: { command: 'echo 12 passing' } } }, { text: 'All 12 tests pass.' }],
  },
  tool_reject: {
    steps: [{ step: 'prompt', text: 'Run the tests' }, { step: 'answer', decision: 'reject' }, { step: 'settle' }],
    replies: [{ tool: { name: /shell|bash|command|exec/iu, input: { command: 'echo 12 passing' } } }, { text: 'I did not run them.' }],
  },
  stop_mid_tool: {
    steps: [{ step: 'prompt', text: 'Run the tests' }, { step: 'cancel', when: 'tool' }, { step: 'settle' }],
    replies: [{ tool: { name: /shell|bash|command|exec/iu, input: { command: 'sleep 30' } } }, { text: 'Stopped.' }],
  },
  resume: {
    steps: [
      { step: 'prompt', text: 'Say hello' },
      { step: 'settle' },
      { step: 'reopen' },
      { step: 'prompt', text: 'And again' },
      { step: 'settle' },
    ],
    replies: [{ text: 'Hello!' }, { text: 'Hello again!' }],
  },
}

/**
 * Connections only to `port` on this computer, the fake model services': any other loopback port may be a proxy off it.
 * Nothing from the keychain or the real home's agent logins.
 */
export function sandboxProfile(realHome: string, port: number): string {
  const denied = [
    'Library/Keychains',
    '.codex',
    '.gemini',
    '.qwen',
    '.pi',
    '.config',
    '.local/share',
    '.claude',
    '.cursor',
    '.ssh',
    '.aws',
    '.npmrc',
  ]
  const quote = (path: string) => JSON.stringify(join(realHome, path))
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    '(allow network-outbound (remote unix-socket))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))',
    `(deny file-read* file-write* ${denied.map(path => `(subpath ${quote(path)})`).join(' ')})`,
  ].join('\n')
}

interface LogLine {
  at: number
  dir?: 'out' | 'in'
  line?: string
  start?: unknown
  exit?: { code: number | null; signal: string | null }
  refused?: string
}

/** Pairs JSON-RPC IDs with their methods, as the replay agent reads frames, and marks where each process ended. */
export function entriesFromLog(lines: LogLine[]): ReplayEntry[] {
  const entries: ReplayEntry[] = []
  let client = new Map<string, string>()
  let agent = new Map<string, string>()
  let started = false
  for (const item of lines) {
    if (item.start) {
      if (started && entries.at(-1)?.type !== 'runtime_exit') entries.push({ type: 'runtime_exit' })
      started = true
      client = new Map()
      agent = new Map()
      continue
    }
    if (item.exit) {
      // An exit the driver did not cause (it stops agents with a signal) is the agent's own.
      if (item.exit.code !== null && item.exit.code !== 0 && item.exit.signal === null)
        entries.push({ type: 'runtime_exit', code: item.exit.code })
      continue
    }
    if (!item.dir || !item.line) continue
    let message: { id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(item.line) as typeof message
    } catch {
      continue
    }
    const type = item.dir === 'out' ? 'expect_outbound' : 'emit_inbound'
    if (typeof message.method === 'string') {
      const request = message.id !== undefined && message.id !== null
      if (request) (item.dir === 'out' ? client : agent).set(String(message.id), message.method)
      const kind = request ? 'request' : 'notification'
      const update = (message.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update?.sessionUpdate
      const frame: LogicalFrame = { kind, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) }
      entries.push({ type, label: `${kind}:${message.method}${typeof update === 'string' ? `:${update}` : ''}`, frame })
      continue
    }
    const pending = item.dir === 'out' ? agent : client
    const method = pending.get(String(message.id))
    if (!method) continue
    pending.delete(String(message.id))
    const frame: LogicalFrame = {
      kind: 'response',
      method,
      ...(message.result === undefined ? {} : { result: message.result }),
      ...(message.error === undefined ? {} : { error: message.error }),
    }
    entries.push({ type, label: `response:${method}`, frame })
  }
  return entries
}

export interface RecordInput {
  /** Preset ID. */
  harness: string
  scenario: string
  /** The agent's program, found where the person's commands are, and its arguments. */
  command: string
  args: string[]
  /** Variables for the agent, such as the fake model's address; `{{MODEL_ORIGIN}}` becomes it. */
  env?: Record<string, string>
  /** Files to place in the agent's home before it starts, by path below the home; `{{MODEL_ORIGIN}}` becomes the address. */
  homeFiles?: Record<string, string>
  /** Names of the variables the driver gives the agent that it keeps, such as a profile's defaults. */
  keep?: string[]
  /** Where the transcript, the agent's error output and the fake model's requests go. */
  outDir: string
  /** The Host's `redactSecrets`. */
  redact: (text: string) => string
  /** Opens the real driver on a definition around the tee. */
  open: (input: {
    definition: { command: string; args: string[]; env: Record<string, string> }
    dataDir: string
    workspace: string
    tmpRoot: string
  }) => Promise<ScenarioBridge>
  /** Tests only: a sandbox-exec to use instead of the system's. */
  sandboxExec?: string
  /** Tests only: the home whose agent logins the sandbox hides; the person's own by default. */
  realHome?: string
}

/** Records one scenario and returns where the transcript went. Refuses without the macOS sandbox. */
export async function recordHarness(input: RecordInput): Promise<{ path: string; transcript: Transcript }> {
  const scenario = RECORD_SCENARIOS[input.scenario]
  if (!scenario) throw new Error(`unknown scenario ${input.scenario}; known: ${Object.keys(RECORD_SCENARIOS).join(', ')}`)
  const sandboxExec = input.sandboxExec ?? SANDBOX_EXEC
  if (process.platform !== 'darwin' || !existsSync(sandboxExec))
    throw new Error('recording needs the macOS sandbox (sandbox-exec), which keeps the agent off the network; refusing without it')
  const realHome = input.realHome ?? homedir()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-record-')))
  const paths = {
    home: join(root, 'home'),
    workspace: join(root, 'workspace'),
    dataDir: join(root, 'data'),
    tmpRoot: join(root, 'run-tmp'),
  }
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 })
  const models = await startFakeModels({ replies: scenario.replies })
  const fill = (text: string) => text.replaceAll('{{MODEL_ORIGIN}}', models.origin)
  for (const [path, text] of Object.entries(input.homeFiles ?? {})) {
    const target = join(paths.home, path)
    if (!target.startsWith(`${paths.home}/`)) throw new Error(`${path} is outside the agent's home`)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, fill(text), { mode: 0o600 })
  }
  await mkdir(input.outDir, { recursive: true })
  const log = join(root, 'frames.ndjson')
  const definition = {
    command: process.execPath,
    args: [RECORD_TEE],
    env: {
      RECORD_LOG: log,
      RECORD_COMMAND: JSON.stringify([input.command, ...input.args]),
      RECORD_HOME: paths.home,
      RECORD_KEEP: JSON.stringify(input.keep ?? []),
      RECORD_ENV: JSON.stringify(Object.fromEntries(Object.entries(input.env ?? {}).map(([name, value]) => [name, fill(value)]))),
      RECORD_SANDBOX: sandboxExec,
      RECORD_PROFILE: sandboxProfile(realHome, Number(new URL(models.origin).port)),
      RECORD_STDERR: join(input.outDir, `${input.harness}-${input.scenario}.stderr.txt`),
    },
  }
  let lines: LogLine[]
  let failure: unknown
  try {
    const played = await playScenario({
      open: () => input.open({ definition, dataDir: paths.dataDir, workspace: paths.workspace, tmpRoot: paths.tmpRoot }),
      steps: scenario.steps,
      cwd: paths.workspace,
      timeoutMs: 120_000,
    })
    await played.bridge.close()
  } catch (error) {
    failure = error
  } finally {
    await models.close()
    lines = (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as LogLine)
    // The agent's home may hold what it wrote at startup, a login among it; only the transcript is kept.
    await rm(root, { recursive: true, force: true })
  }
  const refused = lines.find(line => line.refused)
  if (refused) throw new Error(`the agent was not started: ${refused.refused}`)
  if (failure) throw failure
  const entries = sanitizeEntries(entriesFromLog(lines), {
    workspace: paths.workspace,
    home: paths.home,
    others: {
      [paths.dataDir]: '<data>',
      [paths.tmpRoot]: '<tmp>',
      [root]: '<root>',
      [models.origin]: '<model>',
      [realHome]: '/home/person',
    },
    redact: input.redact,
  })
  const initialize = entries.find(entry => entry.type === 'emit_inbound' && entry.frame.method === 'initialize')
  const info =
    initialize?.type === 'emit_inbound'
      ? (initialize.frame.result as { agentInfo?: { name?: string; version?: string } } | undefined)?.agentInfo
      : undefined
  const transcript: Transcript = {
    header: {
      type: 'transcript_start',
      harness: input.harness,
      protocol: 'acp',
      version: 1,
      scenario: input.scenario,
      source: 'recorded',
      agent: { name: info?.name ?? input.harness, version: info?.version ?? 'unknown' },
      basis: [
        `recorded on ${new Date().toISOString().slice(0, 10)} against the fake model services, in a sandbox that reaches only their port, with a home of its own`,
        'normalised: workspace, home, data and temporary paths, UUIDs in order, times from 2026-01-01, email addresses; then redactSecrets',
      ],
      steps: scenario.steps,
    },
    entries,
  }
  const text = formatTranscript(transcript)
  // Nothing that names this computer's person may leave: a hit means the normalisation missed something.
  const name = userInfo().username
  for (const leak of [realHome, root, name.length >= 3 ? name : undefined].filter(Boolean) as string[])
    if (text.includes(leak)) throw new Error('the transcript still holds a local path or the user name; nothing was written')
  const path = join(input.outDir, `${input.harness}-${input.scenario}.ndjson`)
  await writeFile(path, text, { mode: 0o600 })
  await writeFile(
    join(input.outDir, `${input.harness}-${input.scenario}.model-requests.json`),
    `${JSON.stringify(
      models.requests.map(request => ({ wire: request.wire, model: request.model, stream: request.stream })),
      null,
      2,
    )}\n`,
  )
  return { path, transcript }
}
