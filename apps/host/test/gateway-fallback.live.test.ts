import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPreset, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { assertNoGatewayCredentials } from './helpers/gateway-evidence.ts'

const binary = process.env.LATCH_PI_GATEWAY_BINARY
afterEach(() => vi.unstubAllEnvs())

/**
 * A real pi, pointed at the gateway with two local fake services: the first refuses its key before any reply begins,
 * and the turn completes on the one the model falls back to. Opt-in: only with the owner's leave and
 * `LATCH_PI_GATEWAY_BINARY`. pi runs under a temporary HOME, so none of its own logins is read or used.
 */
it.skipIf(!binary)(
  'completes a real pi turn on the fallback service when the first refuses before its reply begins',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-gateway-fallback-live-'))
    for (const [name, directory] of Object.entries({
      HOME: 'home',
      PI_CODING_AGENT_DIR: 'pi-agent',
      XDG_CONFIG_HOME: 'config',
      XDG_DATA_HOME: 'data',
      XDG_CACHE_HOME: 'cache',
      XDG_STATE_HOME: 'state',
    })) {
      const path = join(root, directory)
      await mkdir(path, { recursive: true })
      vi.stubEnv(name, path)
    }
    const failing = await startFakeModels({ replies: [{ error: { status: 401, message: 'invalid api key' } }] })
    const working = await startFakeModels({ replies: [{ text: 'answered by the fallback service' }] })
    const host = await startTestHost({
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'workspace'),
      commandDirectories: () => [dirname(binary!)],
      loginPrograms: (name: string) => (name === 'pi' ? binary : undefined),
      detectPreset: (preset: AgentPreset) => (preset.id === 'pi' ? { found: true, path: binary! } : { found: false }),
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const service = async (name: string, origin: string, apiKey: string) => {
        const added = await owner.confirmed('providers', {
          method: 'POST',
          body: {
            name,
            kind: 'openai-compatible',
            baseURL: `${origin}/v1`,
            apiKey,
            models: ['service-only-model'],
            defaultModel: 'service-only-model',
            confirmOrigin: true,
          },
        })
        expect(added.status).toBe(201)
        return ((await added.json()) as { provider: ProviderSettings }).provider
      }
      const first = await service('First service', failing.origin, 'sk-test-first-fallback-0123456789')
      const second = await service('Second service', working.origin, 'sk-test-second-fallback-012345678')
      expect(
        (
          await owner.request(`providers/${first.id}`, {
            method: 'PUT',
            body: { fallbacks: { 'service-only-model': [{ providerId: second.id, model: 'service-only-model' }] } },
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await owner.confirmed('agents', {
            method: 'POST',
            body: {
              id: 'pi',
              name: 'pi',
              presetId: 'pi',
              command: 'pi',
              args: [],
              env: { PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' },
            },
          })
        ).status,
      ).toBe(201)
      const started = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'pi',
          prompt: 'Say hello.',
          requestId: randomUUID(),
          model: { providerId: first.id, model: 'service-only-model' },
        },
      })
      let detail: TaskDetail | undefined
      await vi.waitFor(
        async () => {
          detail = await owner.json<TaskDetail>(`tasks/${started.sessionId}`)
          expect(['running', 'waiting-approval']).not.toContain(detail.summary.status)
        },
        { timeout: 60_000, interval: 100 },
      )
      const said = detail!.messages.map(message => `${message.role}: ${message.text}`).join('\n')
      expect(detail!.summary.status, said).toBe('idle')
      expect(said).toContain('answered by the fallback service')
      // One refused request at the first service, never tried again; the reply came from the second, with its own key.
      expect(failing.requests).toHaveLength(1)
      expect(working.requests.length).toBeGreaterThan(0)
      expect(failing.requests[0]?.key).toBe('sk-test-first-fallback-0123456789')
      expect(working.requests.every(request => request.key === 'sk-test-second-fallback-012345678')).toBe(true)
      // What the page draws the 备选 tag from: the turn says another service answered.
      const routed = detail!.messages.find(message => message.role === 'user')?.turn?.routed
      expect(routed?.models[0]).toMatchObject({ provider: second.id })
      expect(routed?.models[0]?.fallback).toBeGreaterThan(0)
      expect(detail!.summary.modelRoute?.fallbacks).toEqual([
        { providerId: second.id, model: 'service-only-model', name: 'Second service' },
      ])
      const records = (await readFile(join(root, 'host', 'audit', 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { action: string; target?: string; detail: Record<string, unknown> })
      expect(records.find(record => record.action === 'task.model.fallback')).toMatchObject({
        target: started.sessionId,
        detail: { sessionId: started.sessionId, providerId: first.id, candidate: 1, errorClass: 'auth' },
      })
      if (process.env.LATCH_GATEWAY_EVIDENCE_DIR) {
        await mkdir(process.env.LATCH_GATEWAY_EVIDENCE_DIR, { recursive: true })
        await writeFile(
          join(process.env.LATCH_GATEWAY_EVIDENCE_DIR, 'fallback-pi.json'),
          JSON.stringify(
            {
              status: detail!.summary.status,
              firstServiceRequests: failing.requests.length,
              secondServiceRequests: working.requests.length,
              routed,
              route: detail!.summary.modelRoute,
              audit: records.filter(record => record.action === 'task.model.fallback'),
            },
            null,
            2,
          ),
        )
      }
    } finally {
      await host.close()
      await failing.close()
      await working.close()
      try {
        await assertNoGatewayCredentials(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  90_000,
)
