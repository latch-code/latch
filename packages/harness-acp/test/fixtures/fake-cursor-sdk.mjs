// A stand-in for `@cursor/sdk` that the Cursor SDK runner loads in tests (`--sdk`): the same exports and shapes the
// runner uses, no network and no Cursor account. Each call is appended to the JSON-lines file FAKE_CURSOR_LOG names,
// read from the environment before the runner removes anything from it. What a prompt does depends on its text.
import { appendFileSync } from 'node:fs'

const LOG = process.env.FAKE_CURSOR_LOG
const log = entry => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
}

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 15, reasoningTokens: 3 }

export class JsonlLocalAgentStore {
  constructor(root) {
    this.root = root
  }
}

class FakeRun {
  constructor(agent, text, onDelta, apiKey) {
    this.id = `run-${++agent.runs}`
    this.agentId = agent.agentId
    this.status = 'running'
    this.usage = undefined
    this.text = text
    this.onDelta = onDelta
    this.apiKey = apiKey
    this.cancelled = new Promise(resolve => {
      this.cancel = async () => {
        log({ call: 'cancel', runId: this.id })
        this.status = 'cancelled'
        resolve()
      }
    })
  }

  async *stream() {
    const say = text => this.onDelta?.({ update: { type: 'text-delta', text } })
    if (this.text === 'crash') process.exit(7)
    if (this.text === 'env') {
      say(JSON.stringify({ names: Object.keys(process.env).sort(), key: process.env.CURSOR_API_KEY ?? null }))
      return
    }
    if (this.text === 'slow' || this.text === 'late') {
      say('working')
      await this.cancelled
      return
    }
    if (this.text === 'whole') {
      yield {
        type: 'assistant',
        agent_id: this.agentId,
        run_id: this.id,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Whole reply' }] },
      }
      return
    }
    this.onDelta?.({ update: { type: 'thinking-delta', text: 'Thinking it over' } })
    say('Hel')
    say('lo')
    yield {
      type: 'assistant',
      agent_id: this.agentId,
      run_id: this.id,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    }
    yield {
      type: 'tool_call',
      agent_id: this.agentId,
      run_id: this.id,
      call_id: 'call-1',
      name: 'read',
      status: 'running',
      args: { path: 'README.md' },
    }
    yield {
      type: 'tool_call',
      agent_id: this.agentId,
      run_id: this.id,
      call_id: 'call-1',
      name: 'read',
      status: 'completed',
      args: { path: 'README.md' },
      result: 'file body',
    }
    yield {
      type: 'tool_call',
      agent_id: this.agentId,
      run_id: this.id,
      call_id: 'call-2',
      name: 'shell',
      status: 'running',
      args: { command: 'false' },
    }
    yield {
      type: 'tool_call',
      agent_id: this.agentId,
      run_id: this.id,
      call_id: 'call-2',
      name: 'shell',
      status: 'error',
      result: { exitCode: 1 },
    }
    say('Done')
    yield { type: 'usage', agent_id: this.agentId, run_id: this.id, usage: USAGE }
  }

  async wait() {
    if (this.text === 'slow' || this.text === 'late') await this.cancelled
    if (this.status === 'cancelled') return { id: this.id, status: 'cancelled' }
    if (this.text === 'fail') {
      this.status = 'error'
      return { id: this.id, status: 'error', error: { message: `Unauthorized key ${this.apiKey}` } }
    }
    this.status = 'finished'
    this.usage = USAGE
    return { id: this.id, status: 'finished', usage: USAGE }
  }

  async steer(text) {
    log({ call: 'steer', text })
    return 'complete_delivered'
  }
}

class FakeAgent {
  constructor(agentId, options) {
    this.agentId = agentId
    this.options = options
    this.runs = 0
  }

  async send(message, options) {
    const text = typeof message === 'string' ? message : message.text
    log({
      call: 'send',
      agentId: this.agentId,
      text,
      model: options?.model,
      images: typeof message === 'string' ? 0 : (message.images?.length ?? 0),
    })
    // Sent but not yet a run: a stop that arrives now must still reach the run.
    if (text === 'late') await new Promise(resolve => setTimeout(resolve, 300))
    return new FakeRun(this, text, options?.onDelta, this.options.apiKey)
  }

  async getUsage() {
    return { usage: USAGE, cost: { rawCostCents: 3, chargedCents: 2.5 }, runs: [] }
  }

  close() {
    log({ call: 'close', agentId: this.agentId })
  }

  async [Symbol.asyncDispose]() {
    log({ call: 'dispose', agentId: this.agentId })
  }
}

const describe = options => ({
  apiKey: options.apiKey,
  model: options.model,
  tools: options.tools ?? null,
  mcpServers: options.mcpServers ? Object.keys(options.mcpServers) : null,
  cwd: options.local?.cwd,
  settingSources: options.local?.settingSources ?? null,
  sandbox: options.local?.sandboxOptions?.enabled ?? null,
  store: options.local?.store instanceof JsonlLocalAgentStore ? options.local.store.root : null,
})

let agents = 0
export const Agent = {
  async create(options) {
    log({ call: 'create', ...describe(options) })
    return new FakeAgent(`agent-${++agents}`, options)
  },
  async resume(agentId, options) {
    log({ call: 'resume', agentId, ...describe(options) })
    if (options.local?.sandboxOptions?.enabled && process.env.FAKE_CURSOR_NO_SANDBOX) {
      const error = new Error('Sandboxing is not supported on this host')
      error.name = 'ConfigurationError'
      throw error
    }
    if (agentId === 'gone') {
      const error = new Error('No such agent')
      error.name = 'AgentNotFoundError'
      throw error
    }
    return new FakeAgent(agentId, options)
  },
}

export const Cursor = {
  models: {
    async list(options) {
      log({ call: 'models', apiKey: options?.apiKey ?? null })
      if (!options?.apiKey) throw new Error('no key given')
      return [
        {
          id: 'composer-2',
          displayName: 'Composer 2',
          variants: [
            { params: [{ id: 'thinking', value: 'high' }], displayName: 'Composer 2 High', isDefault: true },
            { params: [], displayName: 'Composer 2' },
          ],
        },
        { id: 'gpt-5', displayName: 'GPT-5' },
      ]
    },
  },
}
