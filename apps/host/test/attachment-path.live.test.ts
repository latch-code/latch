// A real CLI, through Latch's gateway to a local fake model, gets each attachment it does not take natively by its path
// and opens it with its own shell tool. Runs for every harness switch that is set (docs/TESTING.md); no real service.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPreset, AttachmentRef, ProviderKind, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels, type FakeModelRequest } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

afterEach(() => vi.unstubAllEnvs())
const HOMES = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']
const HARNESSES: Array<{
  name: string
  binary: string | undefined
  preset: string
  program: string
  command: (binary: string) => string
  args: (binary: string) => string[]
  homes: string[]
  kind: ProviderKind
  env?: Record<string, string>
}> = [
  {
    name: 'codex',
    binary: process.env.LATCH_CODEX_GATEWAY_BINARY,
    preset: 'codex',
    program: 'codex',
    command: binary => binary,
    args: () => [],
    homes: [...HOMES, 'CODEX_HOME'],
    kind: 'openai-responses',
  },
  {
    name: 'claude',
    binary: process.env.LATCH_CLAUDE_GATEWAY_BINARY,
    preset: 'claude-agent',
    program: 'claude-agent-acp',
    command: binary => binary,
    // The person's own `claude` is the Agent SDK wire, which takes no arguments; the adapter keeps its own.
    args: binary => (binary.endsWith('/claude') ? [] : ['--hide-claude-auth']),
    homes: [...HOMES, 'CLAUDE_CONFIG_DIR'],
    kind: 'anthropic',
  },
  {
    name: 'opencode',
    binary: process.env.LATCH_OPENCODE_GATEWAY_BINARY,
    preset: 'opencode',
    program: 'opencode',
    command: () => 'opencode',
    args: () => [],
    homes: HOMES,
    kind: 'openai-responses',
  },
  {
    name: 'pi',
    binary: process.env.LATCH_PI_GATEWAY_BINARY,
    preset: 'pi',
    program: 'pi',
    command: () => 'pi',
    args: () => [],
    homes: [...HOMES, 'PI_CODING_AGENT_DIR'],
    kind: 'openai-responses',
    env: { PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' },
  },
]

type Tool = { name: string; parameters: Record<string, unknown> }
function offeredTools(body: unknown): Tool[] {
  const tools = ((body as { tools?: unknown[] }).tools ?? []) as Array<Record<string, unknown>>
  return tools.flatMap(tool => {
    const fn = tool.function as Record<string, unknown> | undefined
    const name = (fn?.name ?? tool.name) as string | undefined
    const parameters = (fn?.parameters ?? tool.parameters ?? tool.input_schema ?? {}) as Record<string, unknown>
    return name ? [{ name, parameters }] : []
  })
}
/** The shell tool the agent offers, called with `command`, in the shape that tool takes. */
function shellCall(body: unknown, command: string) {
  const named = offeredTools(body).find(tool => /^(exec_command|shell_command|shell|bash|Bash)$/u.test(tool.name))
  if (!named) return undefined
  const properties = (named.parameters.properties ?? {}) as Record<string, { type?: unknown }>
  const input: Record<string, unknown> =
    'cmd' in properties ? { cmd: command } : properties.command?.type === 'array' ? { command: ['bash', '-lc', command] } : { command }
  if ('description' in properties) input.description = 'Hash the attached files'
  if ('timeout_ms' in properties) input.timeout_ms = 10_000
  if ('yield_time_ms' in properties) input.yield_time_ms = 2000
  return { name: named.name, input }
}
const hasToolResult = (request: FakeModelRequest) => {
  const text = JSON.stringify(request.body)
  return /"function_call_output"|"tool_result"|"role":"tool"/u.test(text)
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
)
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const runnable = HARNESSES.filter(harness => harness.binary)
if (!runnable.length) it.skip('opens attachments by path in a real CLI (no harness switch set)', () => {})
else
  it.each(runnable)(
    'gives real $name a PDF and a picture its model cannot see by path, and it opens both with its own shell',
    async setup => {
      const binary = setup.binary!
      const root = await mkdtemp(join(tmpdir(), 'latch-attachment-path-live-'))
      vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1')
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(name, 'http://127.0.0.1:9')
      for (const name of setup.homes) {
        const path = join(root, name.toLowerCase())
        await mkdir(path, { recursive: true })
        vi.stubEnv(name, path)
      }
      let paths: string[] = []
      const upstream = await startFakeModels({
        replyFor: request => {
          if (hasToolResult(request)) return { text: 'hashed both' }
          const listed = [...JSON.stringify(request.body).matchAll(/：(\/[^"\\]+)/gu)].map(match => match[1]!)
          const call = listed.length ? shellCall(request.body, `shasum -a 256 ${listed.map(path => `'${path}'`).join(' ')}`) : undefined
          if (!call) return { text: 'no tool' }
          paths = listed
          return { tool: call, text: 'hashing' }
        },
      })
      const host = await startTestHost({
        demo: false,
        dataDir: join(root, 'host'),
        workspaceRoot: join(root, 'project'),
        commandDirectories: () => [dirname(binary)],
        loginPrograms: (name: string) => (name === (binary.endsWith('/claude') ? 'claude' : setup.program) ? binary : undefined),
        detectPreset: (preset: AgentPreset) => (preset.id === setup.preset ? { found: true, path: binary } : { found: false }),
      })
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const added = await owner.confirmed('providers', {
          method: 'POST',
          body: {
            name: 'Text-only service',
            kind: setup.kind,
            baseURL: `${upstream.origin}/v1`,
            apiKey: 'sk-test-attachment-path-0123456789',
            models: ['text-only'],
            defaultModel: 'text-only',
            modelCapabilities: { 'text-only': { vision: false } },
            confirmOrigin: true,
          },
        })
        expect(added.status).toBe(201)
        const provider = ((await added.json()) as { provider: ProviderSettings }).provider
        const model = { providerId: provider.id, model: 'text-only' }
        const agent = await owner.confirmed('agents', {
          method: 'POST',
          body: {
            id: 'live',
            name: setup.name,
            presetId: setup.preset,
            command: setup.command(binary),
            args: setup.args(binary),
            env: setup.env ?? {},
          },
        })
        expect(agent.status, await agent.clone().text()).toBe(201)
        const refs: AttachmentRef[] = []
        for (const [name, bytes] of [
          ['季度报告（最终版）.pdf', pdf],
          ['pixel.png', png],
        ] as const)
          refs.push(
            (
              await owner.json<{ attachment: AttachmentRef }>('attachments', {
                method: 'POST',
                headers: {
                  'content-type': 'application/octet-stream',
                  'x-latch-attachment': Buffer.from(
                    JSON.stringify({ requestId: randomUUID(), name, size: bytes.length, selection: { harnessId: 'live', model } }),
                  ).toString('base64url'),
                },
                rawBody: bytes,
              })
            ).attachment,
          )
        const started = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            harnessId: 'live',
            prompt: 'Hash the attached files.',
            requestId: randomUUID(),
            model,
            attachmentIds: refs.map(ref => ref.id),
          },
        })
        let detail: TaskDetail | undefined
        let approvals = 0
        await vi.waitFor(
          async () => {
            detail = await owner.json<TaskDetail>(`tasks/${started.sessionId}`)
            for (const approval of detail.approvals) {
              approvals++
              await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
            }
            expect(['running', 'waiting-approval']).not.toContain(detail.summary.status)
          },
          { timeout: 90_000, interval: 150 },
        )
        const failure = detail!.messages
          .filter(message => message.role === 'system')
          .map(message => message.text)
          .join('\n')
        expect(detail!.summary.status, failure).toBe('idle')
        // The model saw no picture: the service declares it text-only, so the PNG went by its path with the PDF.
        expect(upstream.requests.some(request => JSON.stringify(request.body).includes(png.toString('base64')))).toBe(false)
        expect(paths.map(path => path.split('/').at(-1))).toEqual(['季度报告（最终版）.pdf', 'pixel.png'])
        const outputs = upstream.requests.filter(hasToolResult).map(request => JSON.stringify(request.body))
        expect(
          outputs.some(text => text.includes(sha(pdf)) && text.includes(sha(png))),
          outputs.join('\n').slice(-2000),
        ).toBe(true)
        console.log(`${setup.name}: opened both by path; approvals answered: ${approvals}`)
      } finally {
        await host.close()
        await upstream.close()
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
