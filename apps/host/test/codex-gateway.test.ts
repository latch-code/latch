import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ownChoice, serviceChoice, type HarnessInfo, type ProviderSettings, type TaskDetail } from '@latch/protocol'
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

it.each([
  ['openai-responses', 'responses'],
  ['openai-compatible', 'chat-completions'],
  ['anthropic', 'anthropic-messages'],
] as const)('keeps Codex Team members on the %s gateway lease and counts them in the root turn', async (kind, wire) => {
  const root = await mkdtemp(join(tmpdir(), 'latch-codex-team-gateway-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const command = join(bin, 'codex')
  const log = join(root, 'agent.jsonl')
  await writeFile(
    command,
    `#!/bin/sh\nexport FAKE_ACP_LOG='${log}' FAKE_CODEX_STATE='${join(root, 'threads.json')}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
  )
  await chmod(command, 0o755)
  const models = await startFakeModels({ replies: [{ text: 'Team summary' }, { text: 'Cedar report' }, { text: 'Maple report' }] })
  const host = await startTestHost({
    demo: false,
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, 'project'),
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const key = 'sk-test-codex-team-loopback-only'
    const model = 'service-team-model'
    const created = await owner.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'Team service',
        kind,
        baseURL: `${models.origin}/v1`,
        apiKey: key,
        models: [model],
        defaultModel: model,
        confirmOrigin: true,
      },
    })
    expect(created.status).toBe(201)
    const { provider } = (await created.json()) as { provider: ProviderSettings }
    expect(
      (
        await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} },
        })
      ).status,
    ).toBe(201)
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'codex', prompt: 'team 服务模型分工', requestId: randomUUID(), model: { providerId: provider.id, model } },
    })
    const read = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await vi.waitFor(async () => expect((await read()).summary.status).toBe('idle'), { timeout: 10_000 })
    const detail = await read()
    expect(detail.codexTeam).toBe('available')
    expect(detail.summary.modelRoute).toEqual({ providerId: provider.id, model, name: 'Team service' })
    expect(
      detail.messages.flatMap(message => (message.subagent?.team ? [message.subagent] : [])).sort((a, b) => a.title.localeCompare(b.title)),
    ).toMatchObject([
      { title: 'Cedar', status: 'done', team: { result: 'Cedar report' } },
      { title: 'Maple', status: 'done', team: { result: 'Maple report' } },
      { title: 'Pine', status: 'failed', team: { failure: expect.stringContaining('gateway-model') } },
    ])
    expect(detail.messages.find(message => message.role === 'user')?.turn?.routed).toMatchObject({
      chosen: model,
      requests: 4,
      models: [
        { model, requests: 3, measured: 3 },
        { model: 'model-outside-this-lease', requests: 1, failed: 1 },
      ],
    })
    expect(models.requests).toHaveLength(3)
    expect(models.requests).toMatchObject(Array.from({ length: 3 }, () => ({ wire, model, key })))
    expect(JSON.stringify(detail)).not.toMatch(/lmg1\.|sk-test-codex-team-loopback-only|child-[a-f0-9]/u)
    const trace = await readFile(log, 'utf8')
    expect(trace).not.toContain('lmg1.')
    expect(trace).not.toContain(key)
    expect(trace).not.toContain('"method":"model/list"')
    if (kind === 'openai-responses') {
      const member = detail.messages.find(message => message.subagent?.team)!
      const stop = (target: string, subagentId: string) =>
        owner.request(`tasks/${target}/stop-subagent`, {
          method: 'POST',
          body: { subagentId },
        })
      expect((await stop(sessionId, 'foreign-upstream-thread')).status).toBe(409)
      const otherHost = await startTestHost()
      try {
        const otherOwner = await otherHost.enroll({ listener: 'unix' })
        expect((await otherOwner.request(`tasks/${sessionId}`)).status).toBe(404)
        expect(
          (
            await otherOwner.request(`tasks/${sessionId}/stop-subagent`, {
              method: 'POST',
              body: { subagentId: member.id },
            })
          ).status,
        ).toBe(404)
      } finally {
        await otherHost.close()
      }
    }
  } finally {
    await host.close()
    await models.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('offers a new session the thinking levels the service declared, before it starts, and sends the one picked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-codex-pre-start-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const command = join(bin, 'codex')
  await writeFile(
    command,
    `#!/bin/sh\nexport FAKE_ACP_LOG='${join(root, 'agent.jsonl')}' FAKE_CODEX_STATE='${join(root, 'threads.json')}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
  )
  await chmod(command, 0o755)
  const models = await startFakeModels({ replies: [{ text: 'thought hard' }] })
  const host = await startTestHost({
    demo: false,
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, 'project'),
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const created = await owner.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'Flash service',
        kind: 'openai-responses',
        baseURL: `${models.origin}/v1`,
        apiKey: 'sk-test-pre-start-service-0123456789',
        models: ['flash', 'plain'],
        modelCapabilities: { flash: { thinking: ['low', 'high'] } },
        defaultModel: 'flash',
        confirmOrigin: true,
      },
    })
    const provider = ((await created.json()) as { provider: ProviderSettings }).provider
    await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} },
    })
    const codex = (await owner.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')).catalog.harnesses.find(
      item => item.id === 'codex',
    )!
    // Only the model with declared levels has a choice; the other is 默认 alone.
    expect(codex.serviceOptions).toEqual([
      {
        providerId: provider.id,
        model: 'flash',
        source: 'declared',
        options: [
          {
            id: 'reasoning_effort',
            name: '思考',
            category: 'thought_level',
            currentValue: '~default',
            options: [
              { value: '~default', name: '默认' },
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
    ])
    expect(JSON.stringify(codex)).not.toContain('sk-test-pre-start')
    const start = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        harnessId: 'codex',
        prompt: 'think',
        requestId: randomUUID(),
        model: { providerId: provider.id, model: 'flash' },
        config: [{ configId: 'reasoning_effort', value: 'high' }],
      },
    })
    const detail = () => owner.json<TaskDetail>(`tasks/${start.sessionId}`)
    await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
    expect((await detail()).config?.find(option => option.id === 'reasoning_effort')?.currentValue).toBe('high')
    expect(models.requests).toHaveLength(1)
    expect(models.requests[0]!.body).toHaveProperty('reasoning.effort', 'high')
  } finally {
    await host.close()
    await models.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  ['reports its own window', '0', 64_000],
  ['reports none', '1', 64_000],
])(
  'opens a Codex thread with the context window the service declared for its model, and the session %s',
  async (_case, noWindow, shown) => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-window-'))
    const bin = join(root, 'bin')
    await mkdir(bin)
    const command = join(bin, 'codex')
    const log = join(root, 'agent.jsonl')
    await writeFile(
      command,
      `#!/bin/sh\nexport FAKE_ACP_LOG='${log}' FAKE_CODEX_STATE='${join(root, 'threads.json')}' FAKE_CODEX_NO_CONTEXT_WINDOW='${noWindow}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
    )
    await chmod(command, 0o755)
    const models = await startFakeModels({ replies: [{ text: 'small window' }] })
    const host = await startTestHost({
      demo: false,
      dataDir: join(root, 'data'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [bin],
      loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
      detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const body = {
        name: 'Small service',
        kind: 'openai-responses',
        baseURL: `${models.origin}/v1`,
        apiKey: 'sk-test-small-window-service-0123456789',
        models: ['small'],
        defaultModel: 'small',
        confirmOrigin: true,
      }
      // A window outside the bounds a declaration may hold is refused, not clamped.
      const refused = await owner.request('providers', {
        method: 'POST',
        body: { ...body, modelCapabilities: { small: { contextTokens: 100 } } },
      })
      expect(refused.status).toBe(400)
      const created = await owner.confirmed('providers', {
        method: 'POST',
        body: { ...body, modelCapabilities: { small: { contextTokens: 64_000 } } },
      })
      const provider = ((await created.json()) as { provider: ProviderSettings }).provider
      expect(provider.modelCapabilities).toEqual({ small: { contextTokens: 64_000 } })
      await owner.confirmed('agents', {
        method: 'POST',
        body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} },
      })
      const start = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'codex', prompt: 'hello', requestId: randomUUID(), model: { providerId: provider.id, model: 'small' } },
      })
      const detail = () => owner.json<TaskDetail>(`tasks/${start.sessionId}`)
      await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
      const started = (await readFile(log, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { event: string; method?: string; params?: { config?: Record<string, unknown> } })
        .find(event => event.event === 'recv' && event.method === 'thread/start')
      expect(started?.params?.config?.model_context_window).toBe(64_000)
      expect((await detail()).usageReport).toMatchObject({ contextSize: shown })
    } finally {
      await host.close()
      await models.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('moves a Codex session between services by resuming it, and onto its own login and back by carrying the thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-codex-move-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const command = join(bin, 'codex')
  const log = join(root, 'agent.jsonl')
  await writeFile(
    command,
    `#!/bin/sh\nexport FAKE_ACP_LOG='${log}' FAKE_CODEX_STATE='${join(root, 'threads.json')}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
  )
  await chmod(command, 0o755)
  const first = await startFakeModels({ replies: [{ text: 'from the first service' }] })
  const second = await startFakeModels({ replies: [{ text: 'from the second service' }] })
  const dataDir = join(root, 'data')
  const host = await startTestHost({
    demo: false,
    dataDir,
    workspaceRoot: join(root, 'project'),
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const service = async (name: string, origin: string, apiKey: string, model: string) => {
      const created = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name,
          kind: 'openai-responses',
          baseURL: `${origin}/v1`,
          apiKey,
          models: [model],
          defaultModel: model,
          confirmOrigin: true,
        },
      })
      expect(created.status).toBe(201)
      return ((await created.json()) as { provider: ProviderSettings }).provider
    }
    const a = await service('First', first.origin, 'sk-test-first-service-0123456789', 'first-model')
    const b = await service('Second', second.origin, 'sk-test-second-service-0123456789', 'second-model')
    expect(
      (
        await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} },
        })
      ).status,
    ).toBe(201)
    const snapshot = await owner.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')
    expect(snapshot.catalog.harnesses.find(item => item.id === 'codex')?.capabilities.models).toMatchObject({ routeSwitch: 'any' })
    const start = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'codex', prompt: 'first', requestId: randomUUID(), model: { providerId: a.id, model: 'first-model' } },
    })
    const detail = () => owner.json<TaskDetail>(`tasks/${start.sessionId}`)
    await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
    const modelId = (await detail()).config!.find(option => option.category === 'model')!.id

    const value = serviceChoice({ providerId: b.id, model: 'second-model' })
    const requestId = randomUUID()
    await owner.json(`tasks/${start.sessionId}/config`, { method: 'POST', body: { configId: modelId, value, requestId } })
    const moved = await detail()
    expect(moved.summary.modelRoute).toMatchObject({ providerId: b.id, model: 'second-model', name: 'Second' })
    expect(moved.messages.map(message => message.text)).toContain('模型改为 second-model · 经 Latch · Second')
    expect(await owner.json(`tasks/${start.sessionId}/config-requests/${requestId}`)).toEqual({ state: 'applied' })
    const audit = (await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; stepup: string; detail: Record<string, unknown> })
    expect(audit.find(record => record.action === 'task.model.route-changed')).toMatchObject({
      stepup: 'none',
      detail: { sessionId: start.sessionId, providerId: b.id, routeHash: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    })

    await owner.json(`tasks/${start.sessionId}/prompt`, { method: 'POST', body: { prompt: 'second', requestId: randomUUID() } })
    await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
    expect((await detail()).messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual([
      'from the first service',
      'from the second service',
    ])
    expect(first.requests.map(request => request.model)).toEqual(['first-model'])
    expect(second.requests).toMatchObject([{ model: 'second-model', key: 'sk-test-second-service-0123456789' }])
    // One thread throughout, resumed on the new route.
    const frames = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; method?: string })
      .filter(frame => frame.event === 'recv')
    expect(frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
    expect(frames.filter(frame => frame.method === 'thread/resume')).toHaveLength(1)

    // Codex resumes a thread only on its provider, so a move to its own login carries the thread as a fork onto it.
    const own = randomUUID()
    await owner.json(`tasks/${start.sessionId}/config`, {
      method: 'POST',
      body: { configId: modelId, value: ownChoice(''), requestId: own },
    })
    expect(await owner.json(`tasks/${start.sessionId}/config-requests/${own}`)).toEqual({ state: 'applied' })
    expect((await detail()).summary.modelRoute).toBeUndefined()
    await owner.json(`tasks/${start.sessionId}/prompt`, { method: 'POST', body: { prompt: 'own', requestId: randomUUID() } })
    await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    // And back onto a service, the same way; the history stays the session's throughout.
    await owner.json(`tasks/${start.sessionId}/config`, {
      method: 'POST',
      body: { configId: modelId, value: serviceChoice({ providerId: a.id, model: 'first-model' }), requestId: randomUUID() },
    })
    await owner.json(`tasks/${start.sessionId}/prompt`, { method: 'POST', body: { prompt: 'first again', requestId: randomUUID() } })
    await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
    expect(first.requests).toHaveLength(2)
    expect((await detail()).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([
      'first',
      'second',
      'own',
      'first again',
    ])
    const after = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; method?: string })
      .filter(frame => frame.event === 'recv')
    expect(after.filter(frame => frame.method === 'thread/fork')).toHaveLength(2)
  } finally {
    await host.close()
    await first.close()
    await second.close()
    await rm(root, { recursive: true, force: true })
  }
})
