import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderSettings, TaskDetail } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
afterEach(() => vi.unstubAllEnvs())

interface Seen {
  system: unknown
  tools: string[]
  window: number | undefined
}

/** One short turn of real Codex on a local Chat service; `catalog` false keeps the Host from running Codex's own commands. */
async function turn(model: string, catalog: boolean): Promise<Seen> {
  const root = await mkdtemp(join(tmpdir(), 'latch-codex-catalog-'))
  for (const [key, leaf] of Object.entries({
    HOME: 'home',
    CODEX_HOME: 'codex',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data-home',
    XDG_CACHE_HOME: 'cache',
  })) {
    const path = join(root, leaf)
    await mkdir(path, { recursive: true })
    vi.stubEnv(key, path)
  }
  const bodies: Array<{ messages: Array<{ content: unknown }>; tools?: Array<{ function: { name: string } }> }> = []
  const upstream = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk.toString()
    bodies.push(JSON.parse(text))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 15_000, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`)
    res.end()
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const host = await startTestHost({
    demo: false,
    dataDir: join(root, 'host'),
    workspaceRoot: join(root, 'project'),
    commandDirectories: () => [dirname(binary!)],
    loginPrograms: name => (catalog && name === 'codex' ? binary : undefined),
    detectPreset: preset => (preset.id === 'codex' ? { found: true, path: binary! } : { found: false }),
  })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const added = await owner.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'Temporary Chat',
        kind: 'openai-compatible',
        baseURL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
        apiKey: 'fake-codex-catalog-key',
        models: [model],
        defaultModel: model,
        confirmOrigin: true,
      },
    })
    expect(added.status).toBe(201)
    const provider = ((await added.json()) as { provider: ProviderSettings }).provider
    const agent = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: binary!, args: [], env: {} },
    })
    expect(agent.status).toBe(201)
    const started = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'codex', requestId: randomUUID(), prompt: 'hi', model: { providerId: provider.id, model } },
    })
    const detail = () => owner.json<TaskDetail>(`tasks/${started.sessionId}`)
    await vi.waitFor(async () => expect(['idle', 'failed']).toContain((await detail()).summary.status), { timeout: 60_000, interval: 100 })
    const result = await detail()
    expect(result.summary.status).toBe('idle')
    return {
      system: bodies[0]?.messages[0]?.content,
      tools: (bodies[0]?.tools ?? []).map(tool => tool.function.name).filter(name => !name.startsWith('latch_')),
      window: result.usageReport?.contextSize,
    }
  } finally {
    await host.close()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}

it.skipIf(!binary)(
  "widens the window of a service's model on real Codex and changes nothing else it is told",
  async () => {
    const plain = await turn('service-only-model', false)
    const wide = await turn('service-only-model', true)
    // Codex's own fallback for a model it does not know, and 95% of the window Latch names for it.
    expect(plain.window).toBe(258_400)
    expect(wide.window).toBe(486_400)
    expect(wide.system).toBe(plain.system)
    expect(wide.tools).toEqual(plain.tools)
  },
  120_000,
)

it.skipIf(!binary)(
  'leaves a model Codex knows on its bundled entry',
  async () => {
    const plain = await turn('gpt-5.5', false)
    const kept = await turn('gpt-5.5', true)
    expect(kept.window).toBe(plain.window)
    expect(kept.system).toBe(plain.system)
    expect(kept.tools).toEqual(plain.tools)
  },
  120_000,
)
