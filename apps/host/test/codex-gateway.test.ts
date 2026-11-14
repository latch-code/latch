import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ProviderSettings, TaskDetail } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER, startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

it.each(['openai-responses', 'openai-compatible'] as const)(
  'routes native Codex to a service-only %s model, reports a failure, and restores the same thread with its explicit effort',
  async kind => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-gateway-'))
    const bin = join(root, 'bin')
    await mkdir(bin)
    const command = join(bin, 'codex')
    const log = join(root, 'agent.jsonl')
    await writeFile(
      command,
      `#!/bin/sh\nexport FAKE_ACP_LOG='${log}' FAKE_CODEX_STATE='${join(root, 'threads.json')}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
    )
    await chmod(command, 0o755)
    const models = await startFakeModels({
      replies: [
        { text: 'native gateway first' },
        { error: { status: 429, message: 'planned service refusal' } },
        { text: 'native gateway restored' },
      ],
    })
    const options = {
      demo: false,
      dataDir: join(root, 'data'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [bin],
      loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
      detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
    }
    let host = await startTestHost(options)
    try {
      let owner = await host.enroll({ listener: 'unix' })
      const key = 'sk-test-native-codex-service-0123456789'
      const model = 'outside-native-catalogue'
      const nextModel = `${model}-other`
      const created = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: 'Native service',
          kind,
          baseURL: `${models.origin}/v1`,
          apiKey: key,
          models: [model, nextModel],
          modelCapabilities: { [nextModel]: { thinking: ['high'] } },
          defaultModel: model,
          confirmOrigin: true,
        },
      })
      expect(created.status).toBe(201)
      const provider = ((await created.json()) as { provider: ProviderSettings }).provider
      expect(
        (
          await owner.confirmed('agents', {
            method: 'POST',
            body: {
              id: 'codex',
              name: 'Codex',
              presetId: 'codex',
              command: 'codex',
              args: [],
              env: {},
            },
          })
        ).status,
      ).toBe(201)
      const start = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'codex',
          prompt: 'first',
          requestId: randomUUID(),
          model: { providerId: provider.id, model },
        },
      })
      const detail = () => owner.json<TaskDetail>(`tasks/${start.sessionId}`)
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
      const first = await detail()
      expect(first.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['native gateway first'])
      expect(first.summary.modelRoute).toEqual({ providerId: provider.id, model, name: 'Native service' })
      expect(first.config?.find(option => option.category === 'model')?.options.map(item => item.value)).toEqual([model, nextModel])
      expect(models.requests).toMatchObject([{ wire: kind === 'openai-compatible' ? 'chat-completions' : 'responses', model, key }])

      // A confirmed choice survives a Host restart even before it has been used by a turn.
      const modelId = first.config!.find(option => option.category === 'model')!.id
      await owner.json(`tasks/${start.sessionId}/config`, {
        method: 'POST',
        body: { configId: modelId, value: nextModel, requestId: randomUUID() },
      })
      expect((await detail()).config?.find(option => option.category === 'model')?.currentValue).toBe(nextModel)
      const thinking = (await detail()).config!.find(option => option.category === 'thought_level')!
      expect(thinking).toMatchObject({ currentValue: '~default', options: [{ value: '~default' }, { value: 'high' }] })
      await owner.json(`tasks/${start.sessionId}/config`, {
        method: 'POST',
        body: { configId: thinking.id, value: 'high', requestId: randomUUID() },
      })
      expect((await detail()).config?.find(option => option.category === 'thought_level')?.currentValue).toBe('high')
      // Removing the unused original choice must not invalidate the session's confirmed current model.
      expect(
        (
          await owner.confirmed(`providers/${provider.id}`, {
            method: 'PUT',
            body: { models: [nextModel], defaultModel: nextModel },
          })
        ).status,
      ).toBe(200)
      await host.close()
      host = await startTestHost(options)
      owner = await host.enroll({ listener: 'unix' })

      await owner.json(`tasks/${start.sessionId}/prompt`, { method: 'POST', body: { prompt: 'refused', requestId: randomUUID() } })
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('failed'), { timeout: 10_000 })
      expect((await detail()).messages.map(message => message.text).join('\n')).toContain('planned service refusal')
      expect((await detail()).config?.find(option => option.category === 'thought_level')?.currentValue).toBe('high')

      await host.close()
      host = await startTestHost(options)
      owner = await host.enroll({ listener: 'unix' })
      await owner.json(`tasks/${start.sessionId}/prompt`, { method: 'POST', body: { prompt: 'restored', requestId: randomUUID() } })
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
      expect((await detail()).messages.filter(message => message.role === 'assistant').at(-1)?.text).toBe('native gateway restored')
      expect(models.requests).toHaveLength(3)
      expect(models.requests.every(request => request.key === key)).toBe(true)
      expect(models.requests.map(request => request.model)).toEqual([model, nextModel, nextModel])
      expect((await detail()).config?.find(option => option.category === 'thought_level')?.currentValue).toBe('high')
      for (const request of models.requests.slice(1))
        expect(request.body).toHaveProperty(kind === 'openai-compatible' ? 'reasoning_effort' : 'reasoning.effort', 'high')
      const wire = await readFile(log, 'utf8')
      expect(wire).not.toContain(key)
      expect(wire).not.toContain('lmg1.')
      const frames = wire
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { event: string; method?: string; argv?: string[]; params?: Record<string, unknown> })
      const reads = frames.filter(frame => frame.event === 'recv')
      expect(reads.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
      expect(reads.filter(frame => frame.method === 'thread/resume')).toHaveLength(2)
      expect(reads.filter(frame => frame.method === 'model/list')).toHaveLength(0)
      expect(
        reads
          .filter(frame => frame.method === 'turn/start')
          .slice(1)
          .map(frame => frame.params?.effort),
      ).toEqual(['high', 'high'])
      for (const process of frames.filter(frame => frame.event === 'start')) {
        expect(process.argv).toContain('model_provider="latch"')
        expect(process.argv).not.toContain('shell_environment_policy.exclude=["LMG_TOKEN"]')
      }
    } finally {
      await host.close()
      await models.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
