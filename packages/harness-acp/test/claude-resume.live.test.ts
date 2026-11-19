import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentEnvironment } from '../src/environment.ts'
import { AcpWire } from '../src/wires/acp.ts'
import { ClaudeWire } from '../src/wires/claude.ts'
import type { AgentWire, WireHandlers } from '../src/wires/types.ts'

const direct = process.env.LATCH_CLAUDE_DIRECT_BINARY
const adapter = process.env.LATCH_CLAUDE_ADAPTER_BINARY

/**
 * A session the adapter `claude-agent-acp` started, resumed by its ID on the Agent SDK wire with the person's own
 * `claude`: the conversation goes on. Opt-in, with both programs' paths and the owner's leave: two tiny real prompts.
 */
it.skipIf(!direct || !adapter)(
  'resumes a session the adapter started on the direct wire',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-claude-resume-')))
    const wires: AgentWire[] = []
    const said: string[] = []
    const handlers: WireHandlers = {
      // Nothing here needs a call; anything it asks is refused.
      request: async method => (method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : {}),
      notification: (_method, params) => {
        const update = (params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) said.push(update.content.text)
      },
      exit: () => {},
    }
    const spec = (command: string) => ({
      command,
      args: [],
      cwd: root,
      env: agentEnvironment({ resolvedCommand: command, definitionEnv: {}, sessionTmpDir: root }),
      maxLineBytes: 16 * 1024 * 1024,
      redact: (text: string) => text,
    })
    try {
      const first = AcpWire.spawn(spec(adapter!), handlers)
      wires.push(first)
      await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60_000)
      const opened = (await first.request('session/new', { cwd: root, mcpServers: [] }, 60_000)) as { sessionId: string }
      await first.request('session/set_config_option', { sessionId: opened.sessionId, configId: 'mode', value: 'default' }, 30_000)
      await first.request(
        'session/prompt',
        { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'Remember the word kiwi. Reply with just: ok' }] },
        120_000,
      )
      await first.stop('stop', 5_000)
      said.length = 0

      const second = ClaudeWire.spawn(spec(direct!), handlers)
      wires.push(second)
      await second.request('initialize', {})
      const resumed = (await second.request('session/resume', { sessionId: opened.sessionId, cwd: root, mcpServers: [] }, 60_000)) as {
        sessionId: string
        configOptions: Array<{ id: string }>
      }
      expect(resumed.sessionId).toBe(opened.sessionId)
      expect(resumed.configOptions.map(option => option.id)).toEqual(expect.arrayContaining(['mode', 'model']))
      await second.request(
        'session/prompt',
        { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'Which word did I ask you to remember? Reply with it only.' }] },
        120_000,
      )
      expect(said.join('').toLowerCase()).toContain('kiwi')
    } finally {
      for (const wire of wires) await wire.stop('stop', 5_000).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  },
  300_000,
)
