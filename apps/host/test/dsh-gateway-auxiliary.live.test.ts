import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderSettings, TaskDetail } from '@latch/protocol'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

const binary = process.env.LATCH_DSH_GATEWAY_BINARY
afterEach(() => vi.unstubAllEnvs())

it.skipIf(!binary).each(['subagent', 'compaction'] as const)(
  'keeps real dsh %s calls on the selected gateway service',
  async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'latch-dsh-gateway-aux-'))
    for (const name of ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      const path = join(root, name.toLowerCase())
      await mkdir(path)
      vi.stubEnv(name, path)
    }
    let overflowSent = false
    let compacted = false
    let childCalled = false
    let secondTurn = false
    const upstream = await startFakeModels({
      replyFor: request => {
        const body = request.body as { tools?: unknown[]; messages?: Array<{ role: string; content?: unknown }> }
        const users = (body.messages ?? [])
          .filter(item => item.role === 'user')
          .map(item => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)))
        if (scenario === 'subagent') {
          if (users.some(text => text.startsWith('Return child-route-marker.'))) {
            childCalled = true
            return { text: 'child-route-marker' }
          }
          const hasResult = body.messages?.some(item => item.role === 'tool')
          return hasResult
            ? { text: 'parent-route-marker' }
            : { tool: { name: 'subagent', input: { description: 'Temporary child route', prompt: 'Return child-route-marker.' } } }
        }
        if (!secondTurn) return { text: `Earlier material. ${'The retained marker is earlier-route-marker. '.repeat(100)}` }
        if (!overflowSent) {
          overflowSent = true
          return { error: { status: 400, message: 'maximum context length exceeded (context_length_exceeded)' } }
        }
        if (users.some(text => text.startsWith('You are now acting as a compaction engine'))) {
          compacted = true
          return { text: 'Earlier retained marker: earlier-route-marker.' }
        }
        return { text: 'continued-after-compaction' }
      },
    })
    const host = await startTestHost({
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [dirname(binary!)],
      loginPrograms: name => (name === 'dsh' ? binary : undefined),
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('providers', {
        body: {
          name: 'Temporary Chat',
          kind: 'openai-compatible',
          baseURL: `${upstream.origin}/v1`,
          apiKey: 'sk-test-dsh-auxiliary-0123456789',
          models: ['selected-service-model'],
          defaultModel: 'selected-service-model',
          confirmOrigin: true,
        },
      })
      expect(added.status).toBe(201)
      const provider = ((await added.json()) as { provider: ProviderSettings }).provider
      expect(
        (
          await owner.confirmed('agents', {
            body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
          })
        ).status,
      ).toBe(201)
      const started = await owner.json<{ sessionId: string }>('tasks', {
        body: {
          harnessId: 'dsh',
          prompt: scenario === 'subagent' ? 'Delegate the supplied child task, then answer.' : 'Keep the earlier material.',
          model: { providerId: provider.id, model: 'selected-service-model' },
          requestId: randomUUID(),
        },
      })
      const detail = () => owner.json<TaskDetail>(`tasks/${started.sessionId}`)
      const settle = async () => {
        await vi.waitFor(
          async () => {
            const value = await detail()
            for (const approval of value.approvals)
              await owner.json(`approvals/${approval.id}`, { body: { decision: 'allow', requestId: randomUUID() } })
            expect(['running', 'waiting-approval']).not.toContain(value.summary.status)
          },
          { timeout: 40_000, interval: 100 },
        )
        const value = await detail()
        expect(
          value.summary.status,
          value.messages
            .filter(message => message.role === 'system')
            .map(message => message.text)
            .join('\n'),
        ).toBe('idle')
      }
      const evidence = async () => {
        if (!process.env.LATCH_GATEWAY_EVIDENCE_DIR) return
        await mkdir(process.env.LATCH_GATEWAY_EVIDENCE_DIR, { recursive: true })
        await writeFile(
          join(process.env.LATCH_GATEWAY_EVIDENCE_DIR, `${scenario}.json`),
          redactKnownSecrets(
            JSON.stringify(
              {
                messages: (await detail()).messages.map(message => ({ role: message.role, text: message.text.slice(0, 500) })),
                requests: upstream.requests.map(request => ({ model: request.model, body: request.body })),
              },
              null,
              2,
            ),
          ),
        )
      }
      await settle()
      await evidence()
      if (scenario === 'subagent') expect(childCalled).toBe(true)
      else {
        secondTurn = true
        await owner.json(`tasks/${started.sessionId}/prompt`, {
          body: { prompt: 'Continue after the simulated context pressure.', requestId: randomUUID() },
        })
        await settle()
        await evidence()
        expect(compacted).toBe(true)
        expect((await detail()).messages.some(message => message.text.includes('continued-after-compaction'))).toBe(true)
      }
      expect(upstream.requests.length).toBeGreaterThanOrEqual(3)
      expect(
        upstream.requests.every(
          request =>
            request.wire === 'chat-completions'
            && request.model === 'selected-service-model'
            && request.key === 'sk-test-dsh-auxiliary-0123456789',
        ),
      ).toBe(true)
    } finally {
      await host.close()
      await upstream.close()
      try {
        await assertNoGatewayCredentials(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  90_000,
)
