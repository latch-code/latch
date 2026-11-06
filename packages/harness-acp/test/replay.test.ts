import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_PRESETS, type DriverTaskDetail, type Message } from '@latch/protocol'
import { readTranscript, replayFixtures, type ReplayEntry, type Transcript } from '@latch/testkit'
import { forgetCommandLookups, setCommandSearch } from '../src/index.ts'
import { replayTranscript } from './helpers/replay.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  forgetCommandLookups()
})

const inbound = (transcript: Transcript, kind: string): Array<Record<string, unknown>> =>
  transcript.entries.flatMap((entry: ReplayEntry) => {
    if (entry.type !== 'emit_inbound' || entry.frame.method !== 'session/update') return []
    const update = (entry.frame.params as { update: Record<string, unknown> }).update
    return update.sessionUpdate === kind ? [update] : []
  })
const chunkText = (transcript: Transcript, kind: string) =>
  inbound(transcript, kind)
    .map(update => (update.content as { text?: string }).text ?? '')
    .join('')
/** Where each process begins: the first entry, and the one after each exit. */
const starts = (transcript: Transcript) => [
  0,
  ...transcript.entries.flatMap((entry, index) =>
    entry.type === 'runtime_exit' && index + 1 < transcript.entries.length ? [index + 1] : [],
  ),
]
const assistants = (detail: DriverTaskDetail) => detail.messages.filter(message => message.role === 'assistant')
const tools = (detail: DriverTaskDetail) => detail.messages.filter(message => message.role === 'tool')
const system = (detail: DriverTaskDetail) => detail.messages.filter(message => message.role === 'system')

/** What a person must see after each scenario, whichever harness played it. */
const SCENARIOS: Record<string, (detail: DriverTaskDetail, transcript: Transcript) => void> = {
  simple(detail, transcript) {
    expect(detail.summary.status).toBe('idle')
    // One reply, its thinking with it, in the words the agent sent.
    expect(assistants(detail)).toHaveLength(1)
    expect(assistants(detail)[0]!.text).toBe(chunkText(transcript, 'agent_message_chunk'))
    const thinking = chunkText(transcript, 'agent_thought_chunk')
    if (thinking) expect(assistants(detail)[0]!.reasoning).toBe(thinking)
    expect(detail.config?.some(option => option.category === 'model')).toBe(true)
    // Where Latch reads the mode back, the agent reported the one Latch expects before the turn, and nothing drifted.
    if (detail.permission?.readback === 'mode') {
      expect(detail.permission.drift).toBeUndefined()
      expect(detail.config?.find(option => option.category === 'mode')?.currentValue).toBe(detail.permission.expectedMode)
    }
  },
  tool_approve(detail, transcript) {
    expect(detail.summary.status).toBe('idle')
    const ran = tools(detail).filter(message => message.tool?.decision)
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatchObject({ state: 'completed', tool: { decision: { outcome: 'allowed' } } })
    // Named as the agent names it: its tool name where it gives one, never just "other".
    const call = inbound(transcript, 'tool_call')[0]!
    const meta = call._meta as { toolName?: string } | undefined
    const named = (call.name as string | undefined) ?? meta?.toolName ?? (call.kind === 'other' ? call.title : call.kind)
    expect(ran[0]!.toolName).toBe(named)
  },
  tool_reject(detail) {
    expect(detail.summary.status).toBe('idle')
    expect(tools(detail)).toHaveLength(1)
    expect(tools(detail)[0]).toMatchObject({ state: 'failed', tool: { decision: { outcome: 'rejected' } } })
  },
  stop_mid_tool(detail) {
    expect(detail.summary.status).toBe('cancelled')
    expect(tools(detail).length).toBeGreaterThan(0)
    expect(tools(detail).every(message => message.state !== 'running' && message.state !== 'queued')).toBe(true)
  },
  // A plan the agent asks the person to accept in its own request, outside ACP's permission request.
  plan_approve(detail) {
    expect(detail.summary.status).toBe('idle')
    const plan = tools(detail).find(message => message.tool?.decision)
    expect(plan).toMatchObject({ state: 'completed', tool: { decision: { outcome: 'allowed' } } })
    expect(detail.plan?.map(entry => entry.status)).toEqual(['completed', 'in_progress'])
    expect(system(detail)).toEqual([])
  },
  auth_required(detail) {
    expect(detail.summary.status).toBe('failed')
    expect(detail.summary.runEnd?.reason).toBe('login-required')
    expect(
      system(detail)
        .map(message => message.text)
        .join('\n'),
    ).toContain('还没登录')
  },
  notice(detail, transcript) {
    expect(detail.summary.status).toBe('idle')
    const notes = system(detail).map(message => message.text)
    for (const notice of inbound(transcript, 'notice')) expect(notes.some(text => text.includes(notice.title as string))).toBe(true)
    expect(notes.some(text => text.includes('in ~/.codex/config.toml'))).toBe(true)
    expect(
      assistants(detail)
        .map(message => message.text)
        .join(''),
    ).toBe(chunkText(transcript, 'agent_message_chunk'))
  },
  compaction(detail) {
    expect(detail.summary.status).toBe('idle')
    const rows = detail.messages.map((message: Message) => `${message.role}:${message.text}`)
    // One row, between the text before it and the text after it, with its final state.
    expect(rows).toEqual([
      'user:Say hello',
      'assistant:Looking at the repository.',
      'system:Codex 已压缩上下文',
      'assistant:Hello after compacting.',
    ])
  },
  resume(detail, transcript) {
    expect(detail.summary.status).toBe('idle')
    expect(assistants(detail).map(message => message.text)).toEqual(
      inbound(transcript, 'agent_message_chunk').map(update => (update.content as { text: string }).text),
    )
  },
  process_exit_mid_turn(detail) {
    expect(detail.summary.status).toBe('failed')
    expect(detail.summary.runEnd?.reason).toBe('process-exited')
    // A command that was running when the agent went away may have done anything: it says so, and is not left running.
    expect(tools(detail)).toHaveLength(1)
    expect(tools(detail)[0]).toMatchObject({ state: 'failed', tool: { output: expect.stringContaining('结果未知') } })
  },
  subagent_ask(detail) {
    expect(detail.summary.status).toBe('idle')
    // The subagent is one row where it began; its call, and the answer the person gave it, are among its steps.
    const row = tools(detail).find(message => message.subagent)
    expect(row).toMatchObject({ state: 'completed', subagent: { title: 'worker', description: 'Run the test suite', status: 'done' } })
    expect(row!.subagent!.steps.find(step => step.tool?.decision)).toMatchObject({
      state: 'completed',
      tool: { decision: { outcome: 'allowed' } },
    })
    expect(row!.subagent!.steps.at(-1)).toMatchObject({ role: 'assistant', text: 'All 12 tests pass.' })
    expect(tools(detail).every(message => message.state === 'completed')).toBe(true)
    expect(
      tools(detail)
        .filter(message => !message.subagent)
        .some(message => message.tool?.decision),
    ).toBe(false)
  },
}

describe('replaying each harness', () => {
  const fixtures = replayFixtures()

  it('has a fixture for every preset, and every fixture says how it was made', () => {
    expect(new Set(fixtures.map(fixture => fixture.harness))).toEqual(new Set(AGENT_PRESETS.map(preset => preset.id)))
    for (const fixture of fixtures) {
      const { header } = readTranscript(fixture.path)
      expect(header).toMatchObject({ harness: fixture.harness, scenario: fixture.scenario, protocol: 'acp', version: 1 })
      expect(['hand-written', 'recorded']).toContain(header.source)
      expect(header.basis.length).toBeGreaterThan(0)
      expect(SCENARIOS[fixture.scenario], `no expectations for ${fixture.scenario}`).toBeDefined()
      // A version line's directory holds frames of that major version only.
      if (fixture.line) expect(header.agent.version.split('.')[0], fixture.path).toBe(fixture.line.split('.')[0])
    }
  })

  for (const fixture of fixtures) {
    it([fixture.harness, fixture.line, fixture.scenario].filter(Boolean).join('/'), async () => {
      const { transcript, detail, pending, status, bin, marks } = await replayTranscript(fixture.path, cleanups)
      expect(status?.failure).toBeUndefined()
      expect(status).toMatchObject({ cursor: status?.total })
      expect(pending).toEqual([])
      // Only the replay agent ran, once, and the programs a preset points its adapter at were the fakes.
      expect(marks).toEqual([])
      // One process per run of the agent the transcript holds; a test that started more found something it did not expect.
      expect(status!.starts.map(start => start.at)).toEqual(starts(transcript))
      for (const start of status!.starts) {
        expect(start.argv).toEqual([])
        for (const name of ['CODEX_PATH', 'PI_ACP_PI_COMMAND']) {
          const value = start.env[name]
          if (value !== null) expect(value.startsWith(`${bin}/`)).toBe(true)
        }
      }
      if (fixture.harness === 'codex') expect(status!.starts[0]!.env.CODEX_PATH).toBe(join(bin, 'codex'))
      if (fixture.harness === 'pi') expect(status!.starts[0]!.env.PI_ACP_PI_COMMAND).toBe(join(bin, 'pi'))
      SCENARIOS[fixture.scenario]!(detail, transcript)
    })
  }
})
