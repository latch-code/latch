import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexWire } from '../src/wires/codex.ts'

const binary = process.env.LATCH_CODEX_SPEED_BINARY
const OUT = 'test-results/codex-speed-live.json'

interface Option {
  id: string
  currentValue: string
  options: Array<{ value: string; name: string }>
}

/**
 * 速度 on a real Codex with its own login: the installed binary in a temporary folder, one thread, one one-word turn.
 * The wire sends the tier picked in Latch (the other one than the thread starts on) and a second process reads it back
 * from the resumed thread. Owner-approved
 * runs only; it reads none of Codex's files (Codex reads its own login) and archives the thread it made. Only the model,
 * the tiers and the outcome are written to test-results/.
 */
it.skipIf(!binary)(
  'sends the picked tier on a turn and reads it back from the thread',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-speed-live-')))
    const project = join(root, 'project')
    await mkdir(project)
    const record: Record<string, unknown> = {}
    const env: Record<string, string> = {}
    for (const name of ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'USER', 'LANG'])
      if (process.env[name] !== undefined) env[name] = process.env[name]!
    const handlers = {
      // A one-word reply asks for nothing; anything asked is declined.
      request: async () => ({ outcome: { outcome: 'cancelled' } }),
      notification: () => {},
      exit: () => {},
    }
    const spawn = () =>
      CodexWire.spawn({ command: binary!, args: [], cwd: project, env, maxLineBytes: 16 * 1024 * 1024, redact: text => text }, handlers)
    const tierOf = (answer: unknown) =>
      ((answer as { configOptions?: Option[] }).configOptions ?? []).find(option => option.id === 'service_tier')
    let first: CodexWire | undefined
    let second: CodexWire | undefined
    let threadId = ''
    try {
      first = spawn()
      const sentTiers: Array<string | null> = []
      const native = first as unknown as { process: { write(message: Record<string, unknown>): void } }
      const write = native.process.write.bind(native.process)
      native.process.write = message => {
        if (message.method === 'turn/start') {
          const params = message.params as Record<string, unknown>
          sentTiers.push(typeof params.serviceTier === 'string' ? params.serviceTier : null)
        }
        write(message)
      }
      await first.request('initialize', {}, 60_000)
      const opened = (await first.request('session/new', { cwd: project, mcpServers: [] }, 120_000)) as {
        sessionId: string
        configOptions: Option[]
      }
      threadId = opened.sessionId
      const model = opened.configOptions.find(option => option.id === 'model')?.currentValue
      const offered = tierOf(opened)
      record.model = model
      record.offered = offered ? offered.options.map(option => `${option.value}=${option.name}`) : null
      record.startedOn = offered?.currentValue ?? null
      if (!offered?.options.some(option => option.value === 'priority')) {
        record.outcome = 'this login’s model offers no Fast tier'
        return
      }
      // The other tier than the thread started on, so what is read back can only be the pick.
      const target = offered.currentValue === 'priority' ? 'default' : 'priority'
      record.picked = target
      await first.request('session/set_config_option', { sessionId: threadId, configId: 'service_tier', value: target }, 10_000)
      const answer = (await first.request(
        'session/prompt',
        { sessionId: threadId, prompt: [{ type: 'text', text: 'Reply with the single word OK.' }] },
        180_000,
      )) as { stopReason?: string }
      record.stopReason = answer.stopReason
      record.sentTiers = sentTiers
      await first.stop('stop', 2_000)
      first = undefined

      second = spawn()
      await second.request('initialize', {}, 60_000)
      const resumed = await second.request('session/resume', { sessionId: threadId, cwd: project, mcpServers: [] }, 120_000)
      record.readBack = tierOf(resumed)?.currentValue ?? null
      record.outcome = 'sent and read back'
      expect(sentTiers).toEqual([target])
      expect(record.readBack).toBe(target)
    } finally {
      const live = second ?? first
      if (live && threadId) {
        const send = (live as unknown as { send(method: string, params: unknown, timeoutMs?: number): Promise<unknown> }).send.bind(live)
        record.archived = await send('thread/archive', { threadId }, 10_000).then(
          () => true,
          () => false,
        )
      }
      await first?.stop('stop', 2_000).catch(() => {})
      await second?.stop('stop', 2_000).catch(() => {})
      await mkdir('test-results', { recursive: true })
      await writeFile(OUT, JSON.stringify(record, null, 2) + '\n')
      await rm(root, { recursive: true, force: true })
    }
  },
  300_000,
)
