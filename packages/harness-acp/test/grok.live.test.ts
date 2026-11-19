import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentEnvironment } from '../src/environment.ts'
import { grokGatewayModels, grokProfile } from '../src/profiles/grok.ts'

/**
 * The real Grok Build in temporary homes: no login, nothing of the person's read, and never a prompt. Opt-in by
 * `LATCH_NO_LOGIN_GROK` naming its binary, as for `gateway-no-login.live.test.ts`. Only control requests are sent:
 * initialize, session/new, session/list, session/load, session/close and its own delete and MCP list.
 */
const binary = process.env.LATCH_NO_LOGIN_GROK
const SENTINEL = `lmg1.${'s'.repeat(40)}`
const ARGS = ['--no-auto-update', '--permission-mode', 'default', 'agent', 'stdio']

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Json = Record<string, unknown>

/** A JSON-RPC client over the agent's stdio that answers every request of the agent with an error. */
class Client {
  readonly notes: Array<{ method: string; params: Json }> = []
  private readonly waiting = new Map<number, (message: Json) => void>()
  private next = 0
  private buffer = ''
  readonly exited: Promise<void>

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', chunk => {
      this.buffer += String(chunk)
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        let message: Json
        try {
          message = JSON.parse(line) as Json
        } catch {
          continue
        }
        if (typeof message.id === 'number' && this.waiting.has(message.id) && message.method === undefined) {
          this.waiting.get(message.id)!(message)
          this.waiting.delete(message.id)
        } else if (typeof message.method === 'string' && message.id !== undefined)
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } })}\n`)
        else if (typeof message.method === 'string') this.notes.push({ method: message.method, params: (message.params ?? {}) as Json })
      }
    })
    child.stderr.resume()
    this.exited = new Promise(resolve => child.on('exit', () => resolve()))
  }

  request(method: string, params: Json, ms = 30_000): Promise<Json> {
    if (method === 'session/prompt') throw new Error('no prompts in this test')
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`${method} timed out`))
      }, ms)
      this.waiting.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async note(method: string, ms = 15_000): Promise<Json> {
    const deadline = Date.now() + ms
    for (;;) {
      const found = this.notes.find(note => note.method === method)
      if (found) return found.params
      if (Date.now() > deadline) throw new Error(`no ${method}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  async stop(): Promise<void> {
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3_000)
    this.child.kill('SIGTERM')
    await this.exited
    clearTimeout(timer)
  }
}

interface Homes {
  root: string
  home: string
  grokHome: string
  project: string
  seen: string
  recorder: string
}

async function homes(): Promise<Homes> {
  const root = await mkdtemp(join(tmpdir(), 'latch-grok-live-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const paths = {
    root,
    home: join(root, 'home'),
    grokHome: join(root, 'grok-home'),
    project: join(root, 'project'),
    seen: join(root, 'seen.jsonl'),
    recorder: join(root, 'recorder.cjs'),
  }
  await mkdir(paths.home, { recursive: true })
  await mkdir(paths.grokHome, { recursive: true, mode: 0o700 })
  await mkdir(paths.project, { recursive: true })
  return paths
}

/**
 * A stdio MCP server that writes down whether it saw the sentinel token, then answers `initialize` and `tools/list`
 * so the agent counts it as ready.
 */
const RECORDER = `
const { appendFileSync } = require('node:fs')
const [out, tag] = process.argv.slice(2)
appendFileSync(out, JSON.stringify({ tag, token: process.env.LMG_TOKEN ?? null }) + '\\n')
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    let message; try { message = JSON.parse(line) } catch { continue }
    if (message.id === undefined) continue
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: tag, version: '1' } }
      : message.method === 'tools/list' ? { tools: [] } : {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})`

const recorderEntry = (paths: Homes, tag: string) => ({ command: process.execPath, args: [paths.recorder, paths.seen, tag] })

/** MCP servers configured for Claude Code and Cursor in the home and the project, and a Claude plugin that has one. */
async function otherTools(paths: Homes): Promise<void> {
  await writeFile(paths.recorder, RECORDER)
  const servers = (tag: string) => JSON.stringify({ mcpServers: { [tag]: recorderEntry(paths, tag) } })
  await writeFile(join(paths.home, '.claude.json'), servers('claude-home'))
  await mkdir(join(paths.home, '.cursor'))
  await writeFile(join(paths.home, '.cursor', 'mcp.json'), servers('cursor-home'))
  const plugin = join(paths.home, '.claude', 'plugins', 'recorder-plugin')
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
  await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'recorder-plugin', version: '1.0.0' }))
  await writeFile(join(plugin, '.mcp.json'), servers('claude-plugin'))
  await writeFile(join(paths.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'recorder-plugin@local': true } }))
  await writeFile(join(paths.project, '.mcp.json'), servers('project-mcp-json'))
  await mkdir(join(paths.project, '.cursor'))
  await writeFile(join(paths.project, '.cursor', 'mcp.json'), servers('cursor-project'))
}

/** Starts the binary as a launch on a gateway route would, from the profile's own delivery and environment. */
/** `earlier`: the version 2 home, which held the custom models alone and set no variable but its path. */
async function startRouted(paths: Homes, options: { earlier?: true; definitionEnv?: Record<string, string> } = {}): Promise<Client> {
  const gateway = grokProfile.gateway
  if (gateway?.via !== 'launch') throw new Error('Grok is a launch route')
  const launch = gateway.deliver(
    { baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'main-model' }], file: name => join(paths.grokHome, name) },
    { providerId: 'svc', model: 'main-model', wire: 'chat-completions', origin: 'https://service.example' },
  )
  const config = options.earlier
    ? grokGatewayModels('http://127.0.0.1:9/v1', 'chat-completions', 'main-model', ['main-model'])
    : launch.files!['config.toml']!
  await writeFile(join(paths.grokHome, 'config.toml'), config, { mode: 0o600 })
  await chmod(join(paths.grokHome, 'config.toml'), 0o600)
  const env = agentEnvironment({
    resolvedCommand: binary!,
    profile: grokProfile.permission,
    definitionEnv: options.definitionEnv ?? {},
    sessionTmpDir: paths.root,
    gatewayEnv: { ...(options.earlier ? { GROK_HOME: launch.env!.GROK_HOME! } : launch.env), [gateway.tokenEnv]: SENTINEL },
    hostEnv: { HOME: paths.home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    shellEnv: {},
  })
  const child = spawn(binary!, ARGS, { cwd: paths.project, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const client = new Client(child)
  cleanups.push(() => client.stop())
  const answer = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  expect(answer.error).toBeUndefined()
  return client
}

async function seen(paths: Homes): Promise<Array<{ tag: string; token: string | null }>> {
  const text = await readFile(paths.seen, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { tag: string; token: string | null })
    .sort((a, b) => a.tag.localeCompare(b.tag))
}

/** Opens a session with these servers, waits until Grok says its MCP servers are up, and closes it. */
async function openSession(client: Client, paths: Homes, mcpServers: unknown[] = []): Promise<string[]> {
  const created = await client.request('session/new', { cwd: paths.project, mcpServers })
  const sessionId = (created.result as Json | undefined)?.sessionId
  expect(typeof sessionId, JSON.stringify(created.error)).toBe('string')
  await client.note('_x.ai/mcp_initialized')
  type Server = { name: string; session?: { enabled?: boolean; status?: string } }
  // A server may still be starting when Grok says the first ones are up.
  let servers: Server[] = []
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 200))) {
    const listed = await client.request('_x.ai/mcp/list', { sessionId })
    servers = ((listed.result as Json | undefined)?.result as { servers?: Server[] } | undefined)?.servers ?? []
    if (servers.every(server => !server.session?.enabled || server.session.status === 'ready')) break
  }
  await client.request('session/close', { sessionId }, 5_000)
  return servers
    .filter(server => server.session?.enabled)
    .map(server => server.name)
    .sort()
}

describe.skipIf(!binary)('Grok Build, real program, temporary homes', () => {
  it('keeps the gateway token from the MCP servers other tools configured, which the earlier home started', async () => {
    // Before: the version 2 home held only the custom models, and three of the person's servers got the token.
    const before = await homes()
    await otherTools(before)
    const client = await startRouted(before, { earlier: true })
    expect(await openSession(client, before)).toEqual(['claude-home', 'claude-plugin', 'cursor-home'])
    expect(await seen(before)).toEqual([
      { tag: 'claude-home', token: SENTINEL },
      { tag: 'claude-plugin', token: SENTINEL },
      { tag: 'cursor-home', token: SENTINEL },
    ])

    // After: the profile's home starts none of them, even for a definition that turns Cursor's back on, and the server
    // Latch gives it sees the token blanked as the runtime blanks it.
    const after = await homes()
    await otherTools(after)
    const launch = await startRouted(after, { definitionEnv: { GROK_CURSOR_MCPS_ENABLED: '1' } })
    const given = { name: 'latch-given', ...recorderEntry(after, 'latch-given'), env: [{ name: 'LMG_TOKEN', value: '' }] }
    expect(await openSession(launch, after, [given])).toEqual(['latch-given'])
    expect(await seen(after)).toEqual([{ tag: 'latch-given', token: '' }])
  }, 90_000)
})
