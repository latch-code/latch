import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ClaudeStore } from '../src/claude-store.ts'
import { agentEnvironment } from '../src/environment.ts'
import { ClaudeWire } from '../src/wires/claude.ts'
import type { WireHandlers } from '../src/wires/types.ts'

const claude = process.env.LATCH_CLAUDE_STORE_LIVE

/**
 * Claude's own store with the person's own `claude` and its own login: one tiny real prompt in a temporary project, a
 * native fork of it at its first message, the import listing, a replay, and real deletion of both transcripts. Opt-in
 * (`LATCH_CLAUDE_STORE_LIVE=<path to claude>`) with the owner's leave. Prints counts and booleans only, never a title or
 * text: the listing covers the person's real sessions.
 */
it.skipIf(!claude)(
  'forks natively, lists, replays and deletes for real in the person’s own Claude store',
  async () => {
    const project = await realpath(await mkdtemp(join(tmpdir(), 'latch-claude-store-live-')))
    const handlers: WireHandlers = {
      // Nothing here needs a call; anything it asks is refused.
      request: async method => (method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : {}),
      notification: () => {},
      exit: () => {},
    }
    const env = agentEnvironment({ resolvedCommand: claude!, definitionEnv: {}, sessionTmpDir: project })
    const spec = { command: claude!, args: [], cwd: project, env, maxLineBytes: 16 * 1024 * 1024, redact: (text: string) => text }
    const store = new ClaudeStore(env)
    const wire = ClaudeWire.spawn(spec, handlers, undefined, { store: true })
    const facts: Record<string, number | boolean> = {}
    let original: string | undefined
    let forked: string | undefined
    try {
      const init = (await wire.request('initialize', {})) as { agentCapabilities: { loadSession: boolean; sessionCapabilities: object } }
      facts.advertisesLoad = init.agentCapabilities.loadSession
      const opened = (await wire.request('session/new', { cwd: project, mcpServers: [] }, 60_000)) as { sessionId: string }
      original = opened.sessionId
      const messageId = randomUUID()
      await wire.request(
        'session/prompt',
        { sessionId: original, prompt: [{ type: 'text', text: 'Reply with just: ok' }] },
        120_000,
        undefined,
        undefined,
        { messageId },
      )
      await wire.request('session/close', { sessionId: original })
      facts.originalStored = (await store.info(original, project)).exists

      const fork = (await wire.request(
        '_latch/session/fork',
        { sessionId: original, cwd: project, through: messageId, before: new Date().toISOString(), mcpServers: [] },
        60_000,
      )) as { sessionId: string }
      forked = fork.sessionId
      facts.forkedNatively = forked !== original
      await wire.request('session/close', { sessionId: forked })
      facts.forkStored = (await store.info(forked, project)).exists

      const listed = (await wire.request('session/list', {}, 60_000)) as { sessions: Array<{ sessionId: string; cwd: string }> }
      facts.listedRows = listed.sessions.length
      // Sessions an SDK started, Latch's own and its forks, are not offered, as in the terminal's `/resume`.
      facts.latchSessionListed = listed.sessions.some(row => row.sessionId === original || row.sessionId === forked)

      let replayed = 0
      const counting = ClaudeWire.spawn(
        spec,
        { ...handlers, notification: (_method, params) => void ((params as { sessionId?: string }).sessionId === original && replayed++) },
        undefined,
        { store: true },
      )
      await counting.request('initialize', {})
      await counting.request('session/load', { sessionId: original, cwd: project, mcpServers: [] }, 60_000)
      facts.replayedUpdates = replayed
      await counting.request('session/close', { sessionId: original })
      await counting.stop('stop', 5_000)

      for (const id of [forked, original]) await wire.request('session/delete', { sessionId: id }, 30_000)
      facts.originalGone = !(await store.info(original, project)).exists
      facts.forkGone = !(await store.info(forked, project)).exists
      console.log(`[claude-store live] ${JSON.stringify(facts)}`)
      expect(facts).toMatchObject({
        advertisesLoad: true,
        originalStored: true,
        forkedNatively: true,
        forkStored: true,
        latchSessionListed: false,
        originalGone: true,
        forkGone: true,
      })
      expect(facts.replayedUpdates).toBeGreaterThanOrEqual(2)
    } finally {
      for (const id of [forked, original]) if (id) await store.delete(id, project).catch(() => {})
      await wire.stop('stop', 5_000)
      await rm(project, { recursive: true, force: true })
    }
  },
  240_000,
)
