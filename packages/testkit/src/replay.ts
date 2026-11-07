/**
 * Replay transcripts: one harness's conversation as NDJSON, in ACP or in the harness's own protocol, played back by
 * `fixtures/replay-agent.mjs` in place of the real agent, so the driver, its wire, its mapping and the session it builds
 * are exercised against the frames that agent sends.
 * A transcript is hand-written from the agent's public protocol and source, or recorded from the real agent against a
 * fake model service; its header says which.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Approval, DriverTaskDetail } from '@latch/protocol'

/** The replay agent; run it as `process.execPath` with this argument and `replayEnv`. */
export const REPLAY_AGENT: string = fileURLToPath(new URL('../fixtures/replay-agent.mjs', import.meta.url))
/**
 * `<harness>/<scenario>.ndjson` below this directory, and `<harness>/<major>.x/<scenario>.ndjson` for another major version
 * of the same agent whose frames differ.
 */
export const REPLAY_FIXTURES: string = fileURLToPath(new URL('../fixtures/replay/', import.meta.url))

export interface LogicalFrame {
  kind: 'request' | 'notification' | 'response'
  method: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export type ReplayEntry =
  | { type: 'expect_outbound'; label?: string; frame: LogicalFrame }
  | { type: 'emit_inbound'; label?: string; frame: LogicalFrame }
  /** `code`: the agent exits with it by itself. Absent: the client ends the process, and what follows is the next one. */
  | { type: 'runtime_exit'; code?: number }

/** What a person does in the scenario, in order; the same steps drive a replay and a recording. */
export type ScenarioStep =
  /** `fresh`: the turn starts a new context, as 清空上下文 sends it. */
  | { step: 'prompt'; text: string; fresh?: true }
  /** Waits until the turn has ended. */
  | { step: 'settle' }
  /** Waits for the session's approval and answers it. */
  | { step: 'answer'; decision: 'allow' | 'reject' }
  /** Waits until the turn shows a tool call (`tool`) or text (`text`), then stops the turn. */
  | { step: 'cancel'; when: 'tool' | 'text' }
  /** Waits as `cancel` does, then adds text to the running turn. */
  | { step: 'steer'; text: string; when: 'tool' | 'text' }
  /** Sets an option of the session by its category, as the composer does. */
  | { step: 'set'; category: string; value: string }
  /** Closes the driver and opens it again on the same data, as a Host restart does. */
  | { step: 'reopen' }

export interface ReplayHeader {
  type: 'transcript_start'
  /** The preset ID. */
  harness: string
  /** `pi-rpc`: pi's RPC records, whose `type` is a frame's method. */
  protocol: 'acp' | 'pi-rpc'
  version: 1
  scenario: string
  /** `hand-written`: from the agent's protocol and source, not captured; `recorded`: captured by `pnpm harness:record`. */
  source: 'hand-written' | 'recorded'
  /** The agent and version the frames follow. */
  agent: { name: string; version: string }
  /** Where the frames come from: source files at a commit, or the recording's normalisation. */
  basis: string[]
  steps: ScenarioStep[]
}

export interface Transcript {
  header: ReplayHeader
  entries: ReplayEntry[]
}

const KINDS = new Set(['request', 'notification', 'response'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entryOf(value: unknown, line: number): ReplayEntry {
  if (!isRecord(value)) throw new Error(`line ${line}: not an object`)
  if (value.type === 'runtime_exit') {
    if (value.code !== undefined && typeof value.code !== 'number') throw new Error(`line ${line}: code is not a number`)
    return value as ReplayEntry
  }
  if (value.type !== 'expect_outbound' && value.type !== 'emit_inbound') throw new Error(`line ${line}: unknown type`)
  const frame = value.frame
  if (!isRecord(frame) || !KINDS.has(frame.kind as string) || typeof frame.method !== 'string')
    throw new Error(`line ${line}: frame needs kind and method`)
  return value as ReplayEntry
}

export function parseTranscript(text: string): Transcript {
  const lines = text.split('\n').filter(line => line.trim())
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      throw new Error(`line ${index + 1}: not JSON`)
    }
  })
  const header = records[0]
  if (!isRecord(header) || header.type !== 'transcript_start') throw new Error('line 1: transcript_start header missing')
  for (const key of ['harness', 'scenario', 'source'] as const)
    if (typeof header[key] !== 'string') throw new Error(`line 1: ${key} missing`)
  if (header.source !== 'hand-written' && header.source !== 'recorded') throw new Error('line 1: source is hand-written or recorded')
  if (!Array.isArray(header.steps) || !Array.isArray(header.basis) || !isRecord(header.agent))
    throw new Error('line 1: steps, basis and agent missing')
  return { header: header as unknown as ReplayHeader, entries: records.slice(1).map((record, index) => entryOf(record, index + 2)) }
}

export function formatTranscript(transcript: Transcript): string {
  return [transcript.header, ...transcript.entries].map(record => JSON.stringify(record)).join('\n') + '\n'
}

export function readTranscript(path: string): Transcript {
  return parseTranscript(readFileSync(path, 'utf8'))
}

export interface ReplayFixture {
  harness: string
  scenario: string
  /** `<major>.x` when the file is in such a directory: the agent's version line its frames follow. */
  line?: string
  path: string
}

function scenarioFiles(directory: string): string[] {
  return readdirSync(directory).filter(name => name.endsWith('.ndjson'))
}

/** Every fixture below `REPLAY_FIXTURES`, by harness, then version line, then scenario. */
export function replayFixtures(root = REPLAY_FIXTURES): ReplayFixture[] {
  const scenario = (name: string) => name.slice(0, -'.ndjson'.length)
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap((directory): ReplayFixture[] => {
      const base = join(root, directory.name)
      const lines = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+\.x$/u.test(entry.name))
      return [
        ...scenarioFiles(base).map(name => ({ harness: directory.name, scenario: scenario(name), path: join(base, name) })),
        ...lines.flatMap(line =>
          scenarioFiles(join(base, line.name)).map(name => ({
            harness: directory.name,
            scenario: scenario(name),
            line: line.name,
            path: join(base, line.name, name),
          })),
        ),
      ]
    })
    .sort((a, b) => `${a.harness}/${a.line ?? ''}/${a.scenario}`.localeCompare(`${b.harness}/${b.line ?? ''}/${b.scenario}`))
}

/** The variables a definition around the replay agent sets. */
export function replayEnv(input: { transcript: string; status: string; workspace?: string }): Record<string, string> {
  return {
    REPLAY_TRANSCRIPT: input.transcript,
    REPLAY_STATUS: input.status,
    ...(input.workspace ? { REPLAY_WORKSPACE: input.workspace } : {}),
  }
}

export interface ReplayStatus {
  scenario: string
  cursor: number
  total: number
  failure?: { detail: string; cursor: number; expected: unknown; actual?: unknown }
  /** One per process: its arguments, directory, the entry it began at, and the watched variables it was given. */
  starts: Array<{ argv: string[]; cwd: string; at: number; env: Record<string, string | null> }>
}

export function readReplayStatus(path: string): ReplayStatus | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReplayStatus
  } catch {
    return undefined
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gu
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Makes a recording safe to keep and stable to replay: the workspace becomes `<workspace>`, the home directory `/home/replay`,
 * UUIDs are numbered in order of appearance, times move to 2026-01-01 keeping their spacing, email addresses become
 * `person@example.invalid`, and `redact` (the Host's `redactSecrets`) runs over every string last. Both directions are
 * rewritten alike, so an ID the agent sends and the client echoes still matches.
 */
export function sanitizeEntries(
  entries: ReplayEntry[],
  input: { workspace: string; home: string; others?: Record<string, string>; redact: (text: string) => string },
): ReplayEntry[] {
  const uuids = new Map<string, string>()
  let anchor: number | undefined
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  // Longer paths first, so a workspace inside the home directory keeps its own placeholder.
  const paths = [[input.workspace, '<workspace>'], [input.home, '/home/replay'], ...Object.entries(input.others ?? {})]
    .filter(([path]) => path && path.length > 1)
    .sort((a, b) => b[0]!.length - a[0]!.length)
    .map(([path, placeholder]) => [new RegExp(escaped(path!), 'gu'), placeholder!] as const)
  const text = (value: string): string => {
    let next = value
    for (const [pattern, placeholder] of paths) next = next.replace(pattern, placeholder)
    next = next
      .replace(UUID, uuid => {
        const key = uuid.toLowerCase()
        if (!uuids.has(key)) uuids.set(key, `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, '0')}`)
        return uuids.get(key)!
      })
      .replace(ISO_TIME, time => {
        const ms = Date.parse(time)
        if (Number.isNaN(ms)) return time
        anchor ??= ms
        return new Date(base + (ms - anchor)).toISOString()
      })
      .replace(EMAIL, 'person@example.invalid')
    return input.redact(next)
  }
  const value = (item: unknown): unknown => {
    if (typeof item === 'string') return text(item)
    if (Array.isArray(item)) return item.map(value)
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [text(key), value(entry)]))
    return item
  }
  return entries.map(entry => (entry.type === 'runtime_exit' ? entry : { ...entry, frame: value(entry.frame) as LogicalFrame }))
}

/** The parts of a driver's session that a scenario uses; an ACP `Bridge` has them all. */
export interface ScenarioBridge {
  createTask(input: { prompt: string; requestId: string; cwd?: string }): Promise<{ sessionId: string }>
  prompt(sessionId: string, prompt: string, requestId: string, options?: { freshContext?: true }): Promise<void>
  detail(sessionId: string): Promise<DriverTaskDetail>
  approvals(): Approval[]
  decide(approvalId: string, decision: 'allow' | 'reject'): Promise<boolean>
  cancel(sessionId: string): Promise<boolean | void>
  setConfig?(sessionId: string, configId: string, value: string): Promise<void>
  steer?(sessionId: string, prompt: string, requestId: string): Promise<unknown>
  close(): Promise<void>
}

async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
  stopped?: () => string | undefined,
): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    const reason = stopped?.()
    if (reason) throw new Error(`stopped waiting for ${what}: ${reason}`)
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const busy = (detail: DriverTaskDetail) => detail.summary.status === 'running' || detail.summary.status === 'waiting-approval'

/**
 * Plays `steps` against the bridges `open` returns, the way a person would, and returns the session. Every wait ends after
 * `timeoutMs` with an error that names it.
 */
export async function playScenario(input: {
  open: () => Promise<ScenarioBridge>
  steps: ScenarioStep[]
  cwd?: string
  timeoutMs?: number
  /** Says why waiting is pointless, such as the replay agent's mismatch, so a step fails at once. */
  stopped?: () => string | undefined
}): Promise<{ bridge: ScenarioBridge; sessionId: string }> {
  const timeout = input.timeoutMs ?? 10_000
  const stopped = input.stopped
  let bridge = await input.open()
  let sessionId: string | undefined
  let requests = 0
  const id = () => `replay-${++requests}`
  const session = () => {
    if (!sessionId) throw new Error('a step before the first prompt needs a session')
    return sessionId
  }
  for (const step of input.steps) {
    switch (step.step) {
      case 'prompt':
        if (sessionId) await bridge.prompt(sessionId, step.text, id(), step.fresh ? { freshContext: true } : {})
        else
          sessionId = (await bridge.createTask({ prompt: step.text, requestId: id(), ...(input.cwd ? { cwd: input.cwd } : {}) })).sessionId
        break
      case 'settle':
        await waitFor('the turn to end', async () => (busy(await bridge.detail(session())) ? undefined : true), timeout, stopped)
        break
      case 'answer': {
        const approval = await waitFor('an approval', () => bridge.approvals().find(item => item.sessionId === session()), timeout, stopped)
        await bridge.decide(approval.id, step.decision)
        break
      }
      case 'cancel':
      case 'steer':
        await waitFor(
          step.when === 'tool' ? 'a tool call' : 'text',
          async () => {
            const detail = await bridge.detail(session())
            if (step.when === 'tool') return detail.messages.some(message => message.role === 'tool') ? true : undefined
            return detail.liveText || detail.messages.some(message => message.role === 'assistant') ? true : undefined
          },
          timeout,
          stopped,
        )
        if (step.step === 'cancel') await bridge.cancel(session())
        else if (bridge.steer) await bridge.steer(session(), step.text, id())
        else throw new Error('the session takes no addition to a running turn')
        break
      case 'set': {
        const option = (await bridge.detail(session())).config?.find(item => item.category === step.category)
        if (!option || !bridge.setConfig) throw new Error(`the session has no ${step.category} option`)
        await bridge.setConfig(session(), option.id, step.value)
        break
      }
      case 'reopen':
        await bridge.close()
        bridge = await input.open()
        break
    }
  }
  return { bridge, sessionId: session() }
}
