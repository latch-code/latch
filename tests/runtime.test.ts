import { mkdtemp, readFile, realpath, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPROVAL_OPTIONS, HIGH_RISK_APPROVAL_OPTIONS, createRuntime } from '../src/core/runtime.ts'
import { createSnapshotStore } from '../src/core/store.ts'
import { AppError } from '../src/core/errors.ts'
import type { RuntimeState } from '../src/core/store.ts'
import type { ModelMessage, ModelProvider, ToolDefinition } from '../src/core/plugins.ts'
import type { Bridge } from '../src/host/bridge.ts'
import type { ModelRef, RiskLevel } from '../src/shared/types.ts'
import { standardHarnessDriver } from '../src/plugins/standard-harness.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'harness-runtime-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

function registry(provider: ModelProvider, tools: ToolDefinition[] = []) {
  const release = vi.fn()
  const acquire = vi.fn((id: string) => {
    if (id !== provider.id) throw new Error(`Unknown provider: ${id}`)
    return { provider, tools: [...tools], release }
  })
  return { acquire, release }
}

function own(bridge: Bridge) {
  cleanups.push(() => bridge.close())
  return bridge
}

function textProvider(id = 'fixture'): ModelProvider {
  return {
    id,
    name: 'Fixture provider',
    model: `${id}-model`,
    async *stream({ signal }) {
      signal.throwIfAborted()
      yield { type: 'text', text: '完成' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

function toolProvider(toolName: string, seen: ModelMessage[][] = []): ModelProvider {
  return {
    id: 'fixture',
    name: 'Fixture provider',
    model: 'fixture-model',
    async *stream({ messages, signal }) {
      signal.throwIfAborted()
      seen.push(structuredClone(messages))
      if (messages.at(-1)?.role === 'tool') {
        yield { type: 'text', text: messages.at(-1)?.isError ? '操作未完成' : '操作完成' }
        yield { type: 'finish', reason: 'stop' }
      } else {
        yield { type: 'text', text: '准备执行' }
        yield { type: 'tool-call', call: { id: `call-${seen.length}`, name: toolName, arguments: { text: 'example' } } }
        yield { type: 'finish', reason: 'tool-calls' }
      }
    },
  }
}

function tool(execute: ToolDefinition['execute'], requiresApproval = true): ToolDefinition {
  return { name: 'write_note', description: 'Write a workspace note', parameters: { type: 'object' }, requiresApproval, execute }
}

async function waitStatus(bridge: Bridge, id: string, status: string) {
  await vi.waitFor(async () => expect((await bridge.detail(id)).summary.status).toBe(status), { timeout: 5000 })
}

describe('independent harness runtime', () => {
  it('atomically persists creation receipts, rejects conflicting retries, and does not rerun after restart', async () => {
    const dataDir = await directory()
    const provider = textProvider()
    const backend = registry(provider)
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: provider.id }))
    const [first, second] = await Promise.all([
      bridge.createTask({ prompt: 'hello', requestId: 'same-request' }),
      bridge.createTask({ prompt: 'hello', requestId: 'same-request' }),
    ])
    expect(first).toEqual(second)
    expect(backend.acquire).toHaveBeenCalledTimes(1)
    await expect(bridge.createTask({ prompt: 'different', requestId: 'same-request' })).rejects.toMatchObject({
      status: 409,
      code: 'request-conflict',
    })
    await waitStatus(bridge, first.sessionId, 'idle')
    await bridge.close()
    const restartedBackend = registry(provider)
    const restarted = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: restartedBackend, providerId: provider.id }))
    expect(await restarted.createTask({ prompt: 'hello', requestId: 'same-request' })).toEqual(first)
    expect(restartedBackend.acquire).not.toHaveBeenCalled()
    expect((await restarted.detail(first.sessionId)).messages.filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('admits one approval winner, executes once, and rebuilds repeated client snapshots without duplication', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'note saved' }))
    const seen: ModelMessage[][] = []
    const backend = registry(toolProvider('write_note', seen), [tool(execute)])
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: 'fixture' }))
    const listener = vi.fn()
    const unsubscribe = bridge.subscribe(listener)
    const { sessionId } = await bridge.createTask({ prompt: 'write a note', requestId: 'create' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    const approval = bridge.approvals()[0]!
    expect(execute).not.toHaveBeenCalled()
    expect(await bridge.detail(sessionId)).toEqual(await bridge.detail(sessionId))
    expect(await Promise.all([bridge.decide(approval.id, 'allow'), bridge.decide(approval.id, 'reject')])).toEqual([true, false])
    await waitStatus(bridge, sessionId, 'idle')
    expect(execute).toHaveBeenCalledTimes(1)
    const result = seen[1]!.find(m => m.role === 'tool')!
    expect(result).toMatchObject({ toolCallId: 'call-1', isError: false, content: 'note saved' })
    const detail = await bridge.detail(sessionId)
    expect(detail.messages.filter(m => m.role === 'tool')).toHaveLength(1)
    expect(new Set(detail.messages.map(m => m.id)).size).toBe(detail.messages.length)
    expect(detail.approvals).toEqual([])
    expect(await bridge.decide(approval.id, 'allow')).toBe(false)
    expect(listener).toHaveBeenCalled()
    expect(backend.release).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('sends a denied tool result back to the provider and never executes the denied tool', async () => {
    const dataDir = await directory()
    const seen: ModelMessage[][] = []
    const execute = vi.fn(async () => ({ text: 'unexpected' }))
    const bridge = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note', seen), [tool(execute)]),
        providerId: 'fixture',
      }),
    )
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'reject' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    await bridge.decide(bridge.approvals()[0]!.id, 'reject')
    await waitStatus(bridge, sessionId, 'idle')
    expect(execute).not.toHaveBeenCalled()
    expect(seen[1]!.at(-1)).toMatchObject({ role: 'tool', isError: true })
    expect((await bridge.detail(sessionId)).messages.at(-1)?.text).toBe('操作未完成')
  })

  it('cancels a waiting approval, rejects late decisions, and rejects new input while active', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'unexpected' }))
    const bridge = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note'), [tool(execute)]),
        providerId: 'fixture',
      }),
    )
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'cancel-approval' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    const approval = bridge.approvals()[0]!
    await expect(bridge.prompt(sessionId, 'another', 'new-input')).rejects.toMatchObject({ status: 409, code: 'task-running' })
    await bridge.cancel(sessionId)
    expect((await bridge.detail(sessionId)).summary.status).toBe('cancelled')
    expect(await bridge.decide(approval.id, 'allow')).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(bridge.approvals()).toEqual([])
  })

  it('propagates cancellation to a real tool and waits for its cleanup before acknowledging; no artifact is written', async () => {
    const dataDir = await directory()
    const started = deferred()
    const aborted = deferred()
    const cleanup = deferred()
    const artifact = join(dataDir, 'should-not-exist.txt')
    const execute = vi.fn(async (_args, { signal }: Parameters<ToolDefinition['execute']>[1]) => {
      started.resolve()
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
      })
      aborted.resolve()
      await cleanup.promise
      signal.throwIfAborted()
      await writeFile(artifact, 'unsafe late write')
      return { text: 'written' }
    })
    const backend = registry(toolProvider('write_note'), [tool(execute, false)])
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: 'fixture' }))
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'cancel-tool' })
    await started.promise
    let acknowledged = false
    const cancellation = bridge.cancel(sessionId).then(() => {
      acknowledged = true
    })
    await aborted.promise
    expect(acknowledged).toBe(false)
    expect((await bridge.detail(sessionId)).summary.status).toBe('running')
    expect(backend.release).not.toHaveBeenCalled()
    cleanup.resolve()
    await cancellation
    expect((await bridge.detail(sessionId)).summary.status).toBe('cancelled')
    await expect(access(artifact)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(backend.release).toHaveBeenCalledTimes(1)
  })

  it('propagates cancellation to the provider and preserves delivered partial text', async () => {
    const dataDir = await directory()
    const waiting = deferred()
    let observedSignal: AbortSignal | undefined
    const provider: ModelProvider = {
      ...textProvider(),
      async *stream({ signal }) {
        observedSignal = signal
        yield { type: 'text', text: 'partial response' }
        waiting.resolve()
        await new Promise<void>(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          ),
        )
        signal.throwIfAborted()
      },
    }
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: registry(provider), providerId: 'fixture' }))
    const { sessionId } = await bridge.createTask({ prompt: 'long response', requestId: 'cancel-provider' })
    await waiting.promise
    const live = await bridge.detail(sessionId)
    expect(live.liveText).toBe('partial response')
    expect(live.activity?.phase).toBe('model')
    expect(live.liveMessageId).toBeTruthy()
    await bridge.cancel(sessionId)
    expect(observedSignal?.aborted).toBe(true)
    const detail = await bridge.detail(sessionId)
    expect(detail.liveText).toBe('')
    expect(detail.messages.at(-1)).toMatchObject({
      id: live.liveMessageId,
      role: 'assistant',
      text: 'partial response',
      state: 'cancelled',
    })
  })

  it.each(['waiting-approval', 'running-tool'] as const)(
    'recovers a %s crash snapshot as interrupted without replay or stale approvals',
    async mode => {
      const dataDir = await directory()
      const entered = deferred()
      const execute = vi.fn(async (_args, { signal }: Parameters<ToolDefinition['execute']>[1]) => {
        entered.resolve()
        await new Promise<void>(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          ),
        )
        signal.throwIfAborted()
        return { text: 'unreachable' }
      })
      const original = own(
        createRuntime({
          dataDir,
          workspaceRoot: dataDir,
          registry: registry(toolProvider('write_note'), [tool(execute, mode === 'waiting-approval')]),
          providerId: 'fixture',
        }),
      )
      const created = await original.createTask({ prompt: 'crash test', requestId: 'durable-input' })
      if (mode === 'waiting-approval') await waitStatus(original, created.sessionId, 'waiting-approval')
      else await entered.promise
      // Capture bytes that were already durably committed at the simulated crash cut.
      const crashImage = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as RuntimeState
      const oldApproval = original.approvals()[0]?.id
      await original.close()
      const store = createSnapshotStore(dataDir)
      await store.load()
      await store.commit(crashImage)
      await store.close()
      const nextRegistry = registry(toolProvider('write_note'), [tool(execute)])
      const restarted = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: nextRegistry, providerId: 'fixture' }))
      await restarted.start()
      expect((await restarted.detail(created.sessionId)).summary.status).toBe('interrupted')
      expect(await restarted.createTask({ prompt: 'crash test', requestId: 'durable-input' })).toEqual(created)
      expect(nextRegistry.acquire).not.toHaveBeenCalled()
      expect(restarted.approvals()).toEqual([])
      if (oldApproval) expect(await restarted.decide(oldApproval, 'allow')).toBe(false)
      const recovered = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as RuntimeState
      const outcomes = recovered.tasks[created.sessionId]!.history.filter(message => message.role === 'tool')
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.isError).toBe(true)
      expect(outcomes[0]!.content).toContain(mode === 'running-tool' ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED')
    },
  )

  it('holds one capability lease throughout a run and selects a changed provider only for the next input', async () => {
    const dataDir = await directory()
    const firstSeen: ModelMessage[][] = []
    const first = toolProvider('write_note', firstSeen)
    const second = textProvider('other')
    let selected = 'fixture'
    const acquire = vi.fn((id: string) => ({
      provider: id === 'fixture' ? first : second,
      tools: [tool(async () => ({ text: 'success' }))],
      release: vi.fn(),
    }))
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: { acquire }, providerId: () => selected }))
    const { sessionId } = await bridge.createTask({ prompt: 'first', requestId: 'first' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    selected = 'other'
    await bridge.decide(bridge.approvals()[0]!.id, 'allow')
    await waitStatus(bridge, sessionId, 'idle')
    expect(firstSeen).toHaveLength(2)
    expect(acquire).toHaveBeenCalledTimes(1)
    await bridge.prompt(sessionId, 'second', 'input-2')
    await bridge.prompt(sessionId, 'second', 'input-2')
    await expect(bridge.prompt(sessionId, 'changed', 'input-2')).rejects.toMatchObject({ code: 'request-conflict' })
    await waitStatus(bridge, sessionId, 'idle')
    expect(acquire.mock.calls.map(call => call[0])).toEqual(['fixture', 'other'])
    expect((await bridge.detail(sessionId)).summary.model).toBe('other-model')
    expect((await bridge.detail(sessionId)).messages.filter(message => message.role === 'user')).toHaveLength(2)
  })

  it('stops at the step limit and records unknown tools as errors instead of dispatching arbitrary code', async () => {
    const dataDir = await directory()
    let calls = 0
    const provider: ModelProvider = {
      ...textProvider(),
      async *stream() {
        yield { type: 'tool-call', call: { id: `missing-${++calls}`, name: 'unregistered_tool', arguments: {} } }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    }
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: registry(provider), providerId: 'fixture', maxSteps: 2 }))
    const { sessionId } = await bridge.createTask({ prompt: 'loop', requestId: 'loop' })
    await waitStatus(bridge, sessionId, 'failed')
    expect(calls).toBe(2)
    const detail = await bridge.detail(sessionId)
    expect(detail.messages.filter(message => message.role === 'tool')).toHaveLength(2)
    expect(detail.messages.at(-1)?.text).toContain('2 步')
  })

  it('does not execute tool calls from an incomplete model stream', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'unexpected' }))
    const provider: ModelProvider = {
      ...textProvider(),
      async *stream() {
        yield { type: 'tool-call', call: { id: 'partial', name: 'write_note', arguments: {} } }
      },
    }
    const bridge = own(
      createRuntime({ dataDir, workspaceRoot: dataDir, registry: registry(provider, [tool(execute, false)]), providerId: 'fixture' }),
    )
    const { sessionId } = await bridge.createTask({ prompt: 'partial', requestId: 'partial' })
    await waitStatus(bridge, sessionId, 'failed')
    expect(execute).not.toHaveBeenCalled()
    expect((await bridge.detail(sessionId)).messages.at(-1)?.text).toContain('未收到完成事件')
  })

  it('refuses a second writer and preserves corrupt snapshots instead of resetting history', async () => {
    const dataDir = await directory()
    const first = createSnapshotStore(dataDir)
    await first.load()
    cleanups.push(() => first.close())
    await expect(createSnapshotStore(dataDir).load()).rejects.toMatchObject({ code: 'store-in-use' })
    await first.close()
    await writeFile(join(dataDir, 'runtime.json'), '{broken')
    await expect(createSnapshotStore(dataDir).load()).rejects.toMatchObject({ code: 'store-corrupt' })
    expect(await readFile(join(dataDir, 'runtime.json'), 'utf8')).toBe('{broken')
  })

  it('does not execute an old task in a different workspace after restarting the same data directory', async () => {
    const dataDir = await directory()
    const originalWorkspace = await directory()
    const replacementWorkspace = await directory()
    const original = own(
      createRuntime({ dataDir, workspaceRoot: originalWorkspace, registry: registry(textProvider()), providerId: 'fixture' }),
    )
    const { sessionId } = await original.createTask({ prompt: 'original workspace', requestId: 'workspace-task' })
    await waitStatus(original, sessionId, 'idle')
    await original.close()
    const backend = registry(textProvider())
    const changed = own(createRuntime({ dataDir, workspaceRoot: replacementWorkspace, registry: backend, providerId: 'fixture' }))
    expect((await changed.detail(sessionId)).summary.cwd).toBe(originalWorkspace)
    await expect(changed.prompt(sessionId, 'continue working here', 'new-workspace-input')).rejects.toMatchObject({
      code: 'workspace-changed',
      status: 409,
    })
    expect(backend.acquire).not.toHaveBeenCalled()
    expect((await changed.detail(sessionId)).messages.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it.each(['same-step', 'later-step'] as const)(
    'rejects duplicate tool IDs in %s without dispatching a second ambiguous operation',
    async mode => {
      const dataDir = await directory()
      const execute = vi.fn(async () => ({ text: 'executed once' }))
      const provider: ModelProvider = {
        ...textProvider(),
        async *stream() {
          const call = { id: 'reused-id', name: 'write_note', arguments: {} }
          yield { type: 'tool-call', call }
          if (mode === 'same-step') yield { type: 'tool-call', call }
          yield { type: 'finish', reason: 'tool-calls' }
        },
      }
      const bridge = own(
        createRuntime({ dataDir, workspaceRoot: dataDir, registry: registry(provider, [tool(execute, false)]), providerId: 'fixture' }),
      )
      const { sessionId } = await bridge.createTask({ prompt: 'duplicate ids', requestId: 'duplicate-ids' })
      await waitStatus(bridge, sessionId, 'failed')
      expect(execute).toHaveBeenCalledTimes(mode === 'same-step' ? 0 : 1)
      expect((await bridge.detail(sessionId)).messages.at(-1)?.text).toContain('重复工具标识')
    },
  )

  it.each(['cancel-first', 'approve-first'] as const)(
    'settles an approval/cancellation race (%s) without dispatching an approved-but-cancelled tool',
    async order => {
      const dataDir = await directory()
      const execute = vi.fn(async () => ({ text: 'must not run' }))
      const bridge = own(
        createRuntime({
          dataDir,
          workspaceRoot: dataDir,
          registry: registry(toolProvider('write_note'), [tool(execute)]),
          providerId: 'fixture',
        }),
      )
      const { sessionId } = await bridge.createTask({ prompt: 'race', requestId: 'approval-cancel-race' })
      await waitStatus(bridge, sessionId, 'waiting-approval')
      const approval = bridge.approvals()[0]!
      const operations =
        order === 'cancel-first'
          ? [bridge.cancel(sessionId), bridge.decide(approval.id, 'allow')]
          : [bridge.decide(approval.id, 'allow'), bridge.cancel(sessionId)]
      await Promise.all(operations)
      expect((await bridge.detail(sessionId)).summary.status).toBe('cancelled')
      expect(execute).not.toHaveBeenCalled()
      expect(await bridge.decide(approval.id, 'allow')).toBe(false)
      expect((await bridge.detail(sessionId)).approvals).toEqual([])
    },
  )

  it('remembers a continuation request across restart and rejects a changed body without acquiring a provider', async () => {
    const dataDir = await directory()
    const original = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: registry(textProvider()), providerId: 'fixture' }))
    const { sessionId } = await original.createTask({ prompt: 'start', requestId: 'start' })
    await waitStatus(original, sessionId, 'idle')
    await original.prompt(sessionId, 'continue', 'continuation')
    await waitStatus(original, sessionId, 'idle')
    await original.close()
    const backend = registry(textProvider())
    const restarted = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: 'fixture' }))
    await restarted.prompt(sessionId, 'continue', 'continuation')
    await expect(restarted.prompt(sessionId, 'different continuation', 'continuation')).rejects.toMatchObject({
      code: 'request-conflict',
      status: 409,
    })
    expect(backend.acquire).not.toHaveBeenCalled()
    expect((await restarted.detail(sessionId)).messages.filter(message => message.role === 'user')).toHaveLength(2)
  })

  it('standard harness preserves chat mode across restart and never advertises tools on its continuations', async () => {
    const dataDir = await directory()
    const requestedTools: string[][] = []
    const provider: ModelProvider = {
      ...textProvider(),
      async *stream({ tools }) {
        requestedTools.push(tools.map(item => item.name))
        yield { type: 'text', text: 'ordinary conversation' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const execute = vi.fn(async () => ({ text: 'not allowed in chat' }))
    const first = own(
      standardHarnessDriver.create({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(provider, [tool(execute)]),
        providerId: 'fixture',
      }),
    )
    const created = await first.createTask({ prompt: 'chat with me', requestId: 'chat', mode: 'chat' })
    await waitStatus(first, created.sessionId, 'idle')
    expect((await first.detail(created.sessionId)).summary.mode).toBe('chat')
    await expect(first.createTask({ prompt: 'chat with me', requestId: 'chat', mode: 'agent' })).rejects.toMatchObject({
      code: 'request-conflict',
    })
    await first.close()
    const restarted = own(
      standardHarnessDriver.create({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(provider, [tool(execute)]),
        providerId: 'fixture',
      }),
    )
    expect(await restarted.createTask({ prompt: 'chat with me', requestId: 'chat', mode: 'chat' })).toEqual(created)
    await restarted.prompt(created.sessionId, 'continue the conversation', 'chat-next')
    await waitStatus(restarted, created.sessionId, 'idle')
    expect(requestedTools).toEqual([[], []])
    expect(execute).not.toHaveBeenCalled()
    expect(restarted.approvals()).toEqual([])
    expect((await restarted.detail(created.sessionId)).summary.mode).toBe('chat')
  })

  it('fails closed if a provider sends a tool call in chat mode, including tools that normally need no approval', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'must not execute' }))
    const bridge = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note'), [tool(execute, false)]),
        providerId: 'fixture',
      }),
    )
    const { sessionId } = await bridge.createTask({ prompt: 'ordinary chat', requestId: 'unexpected-tool', mode: 'chat' })
    await waitStatus(bridge, sessionId, 'failed')
    expect(execute).not.toHaveBeenCalled()
    expect(bridge.approvals()).toEqual([])
    const detail = await bridge.detail(sessionId)
    expect(detail.messages.filter(message => message.role === 'tool')).toEqual([])
    expect(detail.messages.at(-1)?.text).toContain('普通对话模式不允许调用工具')
  })

  it('keeps historical mode-less tasks as agent and migrates legacy creation receipts without rerunning them', async () => {
    const dataDir = await directory()
    const original = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: registry(textProvider()), providerId: 'fixture' }))
    const created = await original.createTask({ prompt: 'old agent task', requestId: 'legacy' })
    await waitStatus(original, created.sessionId, 'idle')
    await original.close()
    const store = createSnapshotStore(dataDir)
    const state = await store.load()
    delete state.tasks[created.sessionId]!.summary.mode
    const receipt = Object.values(state.receipts)[0]!
    receipt.payloadHash = createHash('sha256').update(JSON.stringify('old agent task')).digest('hex')
    await store.commit(state)
    await store.close()
    const backend = registry(textProvider())
    const restarted = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: 'fixture' }))
    expect(await restarted.createTask({ prompt: 'old agent task', requestId: 'legacy' })).toEqual(created)
    expect((await restarted.detail(created.sessionId)).summary.mode).toBe('agent')
    await expect(restarted.createTask({ prompt: 'old agent task', requestId: 'legacy', mode: 'chat' })).rejects.toMatchObject({
      code: 'request-conflict',
    })
    expect(backend.acquire).not.toHaveBeenCalled()
  })
})

function modelsProvider(id: string, models: string[], seen: Array<string | undefined> = []): ModelProvider {
  return {
    id,
    name: `${id} provider`,
    model: models[0]!,
    models,
    async *stream({ model, signal }) {
      signal.throwIfAborted()
      seen.push(model)
      yield { type: 'text', text: `reply from ${model}` }
      yield { type: 'usage', inputTokens: 3, outputTokens: 5 }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

function providers(list: ModelProvider[], tools: ToolDefinition[] = []) {
  const release = vi.fn()
  const acquire = vi.fn((id: string, _options?: { tools?: boolean }) => {
    const provider = list.find(item => item.id === id)
    if (!provider) throw new AppError(409, 'provider-unavailable', 'missing provider')
    return { provider, tools: [...tools], release }
  })
  return { acquire, release }
}

describe('sessions with chosen models, workspaces, and structured output', () => {
  it('runs the chosen model, pins it on the session, and switches only when a prompt asks', async () => {
    const dataDir = await directory()
    const alphaSeen: Array<string | undefined> = []
    const betaSeen: Array<string | undefined> = []
    const backend = providers([modelsProvider('alpha', ['a-1', 'a-2'], alphaSeen), modelsProvider('beta', ['b-1'], betaSeen)])
    let fallback: ModelRef | undefined = { providerId: 'alpha', model: 'a-2' }
    const bridge = own(
      createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: 'alpha', defaultModel: () => fallback }),
    )
    const beta = { providerId: 'beta', model: 'b-1' }
    const chosen = await bridge.createTask({ prompt: 'one', requestId: 'chosen', model: beta })
    await waitStatus(bridge, chosen.sessionId, 'idle')
    const defaulted = await bridge.createTask({ prompt: 'two', requestId: 'defaulted' })
    await waitStatus(bridge, defaulted.sessionId, 'idle')
    expect((await bridge.detail(chosen.sessionId)).summary).toMatchObject({ providerId: 'beta', model: 'b-1' })
    expect((await bridge.detail(defaulted.sessionId)).summary).toMatchObject({ providerId: 'alpha', model: 'a-2' })
    expect(await bridge.createTask({ prompt: 'one', requestId: 'chosen', model: { ...beta } })).toEqual(chosen)
    await expect(bridge.createTask({ prompt: 'one', requestId: 'chosen' })).rejects.toMatchObject({ code: 'request-conflict' })

    fallback = beta
    await bridge.prompt(defaulted.sessionId, 'three', 'keep')
    await waitStatus(bridge, defaulted.sessionId, 'idle')
    expect((await bridge.detail(defaulted.sessionId)).summary).toMatchObject({ providerId: 'alpha', model: 'a-2' })
    const switchTo = { providerId: 'alpha', model: 'a-1' }
    await bridge.prompt(defaulted.sessionId, 'four', 'switch', { model: switchTo })
    await bridge.prompt(defaulted.sessionId, 'four', 'switch', { model: { ...switchTo } })
    await expect(bridge.prompt(defaulted.sessionId, 'four', 'switch')).rejects.toMatchObject({ code: 'request-conflict' })
    await waitStatus(bridge, defaulted.sessionId, 'idle')
    const detail = await bridge.detail(defaulted.sessionId)
    expect(detail.summary).toMatchObject({ providerId: 'alpha', model: 'a-1' })
    expect(detail.messages.filter(message => message.role === 'user')).toHaveLength(3)
    expect(detail.messages.at(-1)).toMatchObject({ text: 'reply from a-1', usage: { inputTokens: 3, outputTokens: 5 } })
    expect(detail.summary.usage).toEqual({ inputTokens: 9, outputTokens: 15 })
    expect(alphaSeen).toEqual(['a-2', 'a-2', 'a-1'])
    expect(betaSeen).toEqual(['b-1'])
  })

  it('rejects a model the provider does not offer without creating a task or keeping a lease', async () => {
    const dataDir = await directory()
    const alpha = modelsProvider('alpha', ['a-1', 'a-2'])
    const backend = providers([alpha])
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: 'alpha' }))
    await expect(
      bridge.createTask({ prompt: 'x', requestId: 'unknown', model: { providerId: 'alpha', model: 'nope' } }),
    ).rejects.toMatchObject({ status: 400, code: 'model-unavailable' })
    expect(backend.release).toHaveBeenCalledTimes(1)
    await expect(bridge.createTask({ prompt: 'x', requestId: 'blank', model: { providerId: 'alpha', model: ' ' } })).rejects.toMatchObject({
      status: 400,
      code: 'invalid-model',
    })
    expect(await bridge.listTasks()).toEqual([])

    const { sessionId } = await bridge.createTask({ prompt: 'x', requestId: 'pinned', model: { providerId: 'alpha', model: 'a-2' } })
    await waitStatus(bridge, sessionId, 'idle')
    alpha.models = ['a-1']
    await expect(bridge.prompt(sessionId, 'y', 'stale')).rejects.toMatchObject({ status: 409, code: 'model-unavailable' })
    await bridge.prompt(sessionId, 'y', 'stale-switch', { model: { providerId: 'alpha', model: 'a-1' } })
    await waitStatus(bridge, sessionId, 'idle')
    const detail = await bridge.detail(sessionId)
    expect(detail.summary.model).toBe('a-1')
    expect(detail.messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(backend.release).toHaveBeenCalledTimes(4)
  })

  it('runs tools in the session workspace and refuses unknown or removed workspaces', async () => {
    const dataDir = await directory()
    const home = await directory()
    const project = await directory()
    let allowed = [home, project]
    const roots: string[] = []
    const execute = vi.fn(async (_args: Record<string, unknown>, context: Parameters<ToolDefinition['execute']>[1]) => {
      roots.push(context.workspaceRoot)
      return { text: 'ok' }
    })
    const backend = registry(toolProvider('write_note'), [tool(execute, false)])
    const bridge = own(createRuntime({ dataDir, workspaceRoot: home, workspaces: () => allowed, registry: backend, providerId: 'fixture' }))
    // The real path is another spelling of the same directory where the temp dir is behind a symlink.
    const spelled = await realpath(project)
    const { sessionId } = await bridge.createTask({ prompt: 'work here', requestId: 'project', cwd: spelled })
    await waitStatus(bridge, sessionId, 'idle')
    expect(roots).toEqual([project])
    const summary = (await bridge.detail(sessionId)).summary
    expect(summary.cwd).toBe(project)
    expect(summary).not.toHaveProperty('providerId')
    await expect(bridge.createTask({ prompt: 'work here', requestId: 'project' })).rejects.toMatchObject({ code: 'request-conflict' })
    await expect(bridge.createTask({ prompt: 'elsewhere', requestId: 'outside', cwd: await directory() })).rejects.toMatchObject({
      status: 400,
      code: 'workspace-unavailable',
    })
    await expect(bridge.createTask({ prompt: 'relative', requestId: 'relative', cwd: 'project' })).rejects.toMatchObject({
      status: 400,
      code: 'workspace-unavailable',
    })
    allowed = [home]
    await expect(bridge.prompt(sessionId, 'continue', 'removed')).rejects.toMatchObject({ status: 409, code: 'workspace-changed' })
    expect(await bridge.createTask({ prompt: 'work here', requestId: 'project', cwd: spelled })).toEqual({ sessionId })
    expect(backend.acquire).toHaveBeenCalledTimes(1)
  })

  it('leases tool plugins only for agent runs', async () => {
    const dataDir = await directory()
    const backend = registry(textProvider())
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: 'fixture' }))
    const chat = await bridge.createTask({ prompt: 'chat', requestId: 'chat', mode: 'chat' })
    await waitStatus(bridge, chat.sessionId, 'idle')
    const agent = await bridge.createTask({ prompt: 'agent', requestId: 'agent' })
    await waitStatus(bridge, agent.sessionId, 'idle')
    expect(backend.acquire.mock.calls).toEqual([
      ['fixture', { tools: false }],
      ['fixture', { tools: true }],
    ])
  })

  it('streams reasoning separately, settles it on the same message, and never replays it to the model', async () => {
    const dataDir = await directory()
    const seen: ModelMessage[][] = []
    const reasoned = deferred()
    const gate = deferred()
    const provider: ModelProvider = {
      ...textProvider(),
      async *stream({ messages }) {
        seen.push(structuredClone(messages))
        if (messages.at(-1)?.role === 'tool') {
          yield { type: 'reasoning', text: '检查结果' }
          reasoned.resolve()
          await gate.promise
          yield { type: 'text', text: '完成' }
          yield { type: 'usage', inputTokens: 20, outputTokens: 4 }
          yield { type: 'finish', reason: 'stop' }
        } else {
          yield { type: 'reasoning', text: '需要写入' }
          yield { type: 'tool-call', call: { id: 'call-1', name: 'write_note', arguments: { text: 'example' } } }
          yield { type: 'usage', inputTokens: 10, outputTokens: 2 }
          yield { type: 'finish', reason: 'tool-calls' }
        }
      },
    }
    const bridge = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(provider, [tool(async () => ({ text: 'saved' }), false)]),
        providerId: 'fixture',
      }),
    )
    const { sessionId } = await bridge.createTask({ prompt: 'think', requestId: 'reasoning' })
    await reasoned.promise
    const live = await bridge.detail(sessionId)
    expect(live).toMatchObject({ liveText: '', liveReasoning: '检查结果' })
    gate.resolve()
    await waitStatus(bridge, sessionId, 'idle')
    const detail = await bridge.detail(sessionId)
    expect(detail.liveReasoning).toBeUndefined()
    expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(detail.messages[1]).toMatchObject({ text: '', reasoning: '需要写入', usage: { inputTokens: 10, outputTokens: 2 } })
    expect(detail.messages[3]).toMatchObject({
      id: live.liveMessageId,
      text: '完成',
      reasoning: '检查结果',
      usage: { inputTokens: 20, outputTokens: 4 },
    })
    expect(detail.summary.usage).toEqual({ inputTokens: 30, outputTokens: 6 })
    expect(JSON.stringify(seen)).not.toContain('需要写入')
  })

  it('keeps partial reasoning and usage of a cancelled step', async () => {
    const dataDir = await directory()
    const waiting = deferred()
    const provider: ModelProvider = {
      ...textProvider(),
      async *stream({ signal }) {
        yield { type: 'reasoning', text: '先想一想' }
        yield { type: 'usage', inputTokens: 7, outputTokens: 1 }
        yield { type: 'text', text: '部分' }
        waiting.resolve()
        await new Promise<void>(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          ),
        )
        signal.throwIfAborted()
      },
    }
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: registry(provider), providerId: 'fixture' }))
    const { sessionId } = await bridge.createTask({ prompt: 'cancel me', requestId: 'cancel-usage' })
    await waiting.promise
    await bridge.cancel(sessionId)
    const detail = await bridge.detail(sessionId)
    expect(detail.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: '部分',
      reasoning: '先想一想',
      state: 'cancelled',
      usage: { inputTokens: 7, outputTokens: 1 },
    })
    expect(detail.summary.usage).toEqual({ inputTokens: 7, outputTokens: 1 })
  })

  it('describes tool calls with structured details and previews what an approval would change', async () => {
    const dataDir = await directory()
    const preview = vi.fn(async (args: Record<string, unknown>) => ({
      title: `写入 ${String(args.text)}`,
      diffs: [
        { path: 'note.txt', oldText: 'old', newText: 'new', previous: 'text' as const },
        { path: 'fresh.txt', newText: 'x', previous: 'none' as const },
      ],
    }))
    const definition: ToolDefinition = { ...tool(async () => ({ text: 'note saved' })), kind: 'edit', preview }
    const bridge = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note'), [definition]),
        providerId: 'fixture',
      }),
    )
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'preview' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    const input = JSON.stringify({ text: 'example' }, null, 2)
    const diffs = [
      { path: 'note.txt', oldText: 'old', newText: 'new', previous: 'text' },
      { path: 'fresh.txt', newText: 'x', previous: 'none' },
    ]
    const approval = bridge.approvals()[0]!
    expect(approval.options).toEqual(APPROVAL_OPTIONS)
    expect(approval.tool).toEqual({ kind: 'edit', title: '写入 example', diffs })
    expect(preview).toHaveBeenCalledWith({ text: 'example' }, { workspaceRoot: dataDir, signal: expect.any(AbortSignal) })
    const waiting = await bridge.detail(sessionId)
    expect(waiting.approvals[0]).toEqual(approval)
    expect(waiting.messages.find(message => message.role === 'tool')).toMatchObject({
      state: 'awaiting-approval',
      text: input,
      tool: { kind: 'edit', title: '写入 example', input, diffs },
    })
    expect(await bridge.decide(approval.id, 'allow', { optionId: 'allow_once' })).toBe(true)
    await waitStatus(bridge, sessionId, 'idle')
    expect((await bridge.detail(sessionId)).messages.find(message => message.role === 'tool')).toEqual({
      id: 'tool:call-1',
      role: 'tool',
      toolName: 'write_note',
      text: 'note saved',
      state: 'completed',
      tool: { kind: 'edit', title: '写入 example', input, diffs, output: 'note saved' },
    })
  })

  it('remembers allow_always for the rest of the session, across restart, and validates the option', async () => {
    const dataDir = await directory()
    const seen: ModelMessage[][] = []
    const execute = vi.fn(async () => ({ text: 'saved' }))
    const definition: ToolDefinition = {
      ...tool(execute),
      preview: async () => {
        throw new Error('preview unavailable')
      },
    }
    const bridge = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note', seen), [definition]),
        providerId: 'fixture',
      }),
    )
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'always' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    const approval = bridge.approvals()[0]!
    expect(approval.tool).toEqual({ title: 'write_note' })
    await expect(bridge.decide(approval.id, 'reject', { optionId: 'allow_always' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid-decision',
    })
    await expect(bridge.decide(approval.id, 'allow', { optionId: 'reject_once' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid-decision',
    })
    await expect(bridge.decide(approval.id, 'allow', { optionId: 'missing' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid-option',
    })
    expect(bridge.approvals()).toHaveLength(1)
    expect(await bridge.decide(approval.id, 'allow', { optionId: 'allow_always' })).toBe(true)
    await waitStatus(bridge, sessionId, 'idle')
    await bridge.prompt(sessionId, 'again', 'again')
    await waitStatus(bridge, sessionId, 'idle')
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await bridge.detail(sessionId)).messages.filter(message => message.role === 'tool').map(message => message.state)).toEqual([
      'completed',
      'completed',
    ])
    await bridge.close()

    const restarted = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note', seen), [definition]),
        providerId: 'fixture',
      }),
    )
    await restarted.prompt(sessionId, 'after restart', 'after-restart')
    await waitStatus(restarted, sessionId, 'idle')
    expect(execute).toHaveBeenCalledTimes(3)
    const other = await restarted.createTask({ prompt: 'other session', requestId: 'other' })
    await waitStatus(restarted, other.sessionId, 'waiting-approval')
    await restarted.decide(restarted.approvals()[0]!.id, 'reject', { optionId: 'reject_once' })
    await waitStatus(restarted, other.sessionId, 'idle')
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('deletes settled sessions and keeps tombstoned receipts so a retry cannot recreate them', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'unexpected' }))
    const seen: ModelMessage[][] = []
    const backend = registry(toolProvider('write_note', seen), [tool(execute)])
    const bridge = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: backend, providerId: 'fixture' }))
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'remove' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    await expect(bridge.remove!(sessionId)).rejects.toMatchObject({ status: 409, code: 'task-running' })
    await bridge.decide(bridge.approvals()[0]!.id, 'reject')
    await waitStatus(bridge, sessionId, 'idle')
    await bridge.prompt(sessionId, 'more', 'more')
    await waitStatus(bridge, sessionId, 'waiting-approval')
    await bridge.cancel(sessionId)
    const listener = vi.fn()
    bridge.subscribe(listener)
    await bridge.remove!(sessionId)
    expect(listener).toHaveBeenCalledWith(undefined)
    expect(await bridge.listTasks()).toEqual([])
    await expect(bridge.detail(sessionId)).rejects.toMatchObject({ status: 404, code: 'task-not-found' })
    await expect(bridge.prompt(sessionId, 'more', 'more')).rejects.toMatchObject({ status: 404 })
    await expect(bridge.remove!(sessionId)).rejects.toMatchObject({ status: 404 })
    await expect(bridge.createTask({ prompt: 'write', requestId: 'remove' })).rejects.toMatchObject({ status: 410, code: 'task-deleted' })
    await bridge.close()

    const restartedBackend = registry(toolProvider('write_note'))
    const restarted = own(createRuntime({ dataDir, workspaceRoot: dataDir, registry: restartedBackend, providerId: 'fixture' }))
    await expect(restarted.createTask({ prompt: 'write', requestId: 'remove' })).rejects.toMatchObject({
      status: 410,
      code: 'task-deleted',
    })
    expect(restartedBackend.acquire).not.toHaveBeenCalled()
    const stored = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as RuntimeState
    expect(Object.keys(stored.tombstones ?? {})).toEqual([sessionId])
    expect(Object.values(stored.receipts).map(receipt => receipt.taskId)).toEqual([sessionId, sessionId])
    expect(execute).not.toHaveBeenCalled()
  })

  it('round-trips every persisted field and still rejects receipts without a task or tombstone', async () => {
    const dataDir = await directory()
    const requestedAt = new Date(0).toISOString()
    const diffs = [
      { path: 'a.txt', oldText: 'x', newText: 'y' },
      { path: 'b.txt', newText: 'z' },
    ]
    const call = { id: 'c', name: 'write_file', arguments: { path: 'a.txt', content: 'y' } }
    const state: RuntimeState = {
      version: 1,
      tasks: {
        'task-1': {
          summary: {
            id: 'task-1',
            title: 'title',
            status: 'waiting-approval',
            updatedAt: requestedAt,
            cwd: '/workspace',
            model: 'm',
            mode: 'agent',
            harnessId: 'standard',
            providerId: 'p',
            pinned: true,
            archived: false,
            usage: { inputTokens: 1, outputTokens: 2 },
          },
          messages: [
            { id: 'a', role: 'assistant', text: '', state: 'completed', reasoning: 'why', usage: { inputTokens: 1, outputTokens: 2 } },
            {
              id: 'tool:c',
              role: 'tool',
              toolName: 'write_file',
              text: '{}',
              state: 'awaiting-approval',
              tool: { kind: 'edit', title: '写入 a.txt', input: '{}', output: 'done', locations: ['a.txt'], diffs },
            },
          ],
          history: [{ role: 'assistant', content: '', toolCalls: [call] }],
          revision: 3,
          approval: {
            id: 'approval',
            sessionId: 'task-1',
            toolName: 'write_file',
            toolCallId: 'c',
            reason: 'r',
            arguments: '{}',
            requestedAt,
            options: [...APPROVAL_OPTIONS],
            tool: { kind: 'edit', title: '写入 a.txt', diffs },
          },
          batch: { calls: [call], started: [], completed: [] },
          allowedTools: ['write_file'],
        },
      },
      receipts: { live: { taskId: 'task-1', payloadHash: 'h1' }, deleted: { taskId: 'task-0', payloadHash: 'h0' } },
      tombstones: { 'task-0': { deletedAt: requestedAt } },
    }
    const writer = createSnapshotStore(dataDir)
    await writer.load()
    await writer.commit(state)
    await writer.close()
    const reader = createSnapshotStore(dataDir)
    expect(await reader.load()).toEqual(state)
    await reader.close()

    for (const broken of [
      { ...state, tombstones: {} },
      { ...state, tombstones: { ...state.tombstones, 'task-1': { deletedAt: requestedAt } } },
    ]) {
      await writeFile(join(dataDir, 'runtime.json'), JSON.stringify(broken))
      await expect(createSnapshotStore(dataDir).load()).rejects.toMatchObject({ code: 'store-corrupt' })
    }
  })
})

describe('Host risk classification', () => {
  function classifiedRuntime(
    dataDir: string,
    classifyToolCall: (input: unknown) => Promise<RiskLevel>,
    execute: ToolDefinition['execute'],
    requiresApproval: boolean,
    seen: ModelMessage[][] = [],
  ) {
    return own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note', seen), [tool(execute, requiresApproval)]),
        providerId: 'fixture',
        classifyToolCall,
      }),
    )
  }

  it('runs R0 calls without approval even when the tool asks for it, and classifies the exact call', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'saved' }))
    const classify = vi.fn(async () => 'R0' as const)
    const bridge = classifiedRuntime(dataDir, classify, execute, true)
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'r0' })
    await waitStatus(bridge, sessionId, 'idle')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(classify).toHaveBeenCalledWith({ toolName: 'write_note', arguments: { text: 'example' }, cwd: dataDir, sessionId })
    expect((await bridge.detail(sessionId)).messages.find(message => message.role === 'tool')?.state).toBe('completed')
  })

  it('asks for R1 calls with the always option and remembers it for the session', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'saved' }))
    const bridge = classifiedRuntime(dataDir, async () => 'R1', execute, false)
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'r1' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    const approval = bridge.approvals()[0]!
    expect(approval).toMatchObject({ risk: 'R1', options: APPROVAL_OPTIONS })
    expect(await bridge.decide(approval.id, 'allow', { optionId: 'allow_always' })).toBe(true)
    await waitStatus(bridge, sessionId, 'idle')
    await bridge.prompt(sessionId, 'again', 'again')
    await waitStatus(bridge, sessionId, 'idle')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(bridge.approvals()).toEqual([])
  })

  it('asks for R2 calls every time without the always option, even after an R1 allowance for the same tool', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'saved' }))
    let level: RiskLevel = 'R1'
    const bridge = classifiedRuntime(dataDir, async () => level, execute, true)
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'allowed' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    await bridge.decide(bridge.approvals()[0]!.id, 'allow', { optionId: 'allow_always' })
    await waitStatus(bridge, sessionId, 'idle')

    level = 'R2'
    for (const requestId of ['high-1', 'high-2']) {
      await bridge.prompt(sessionId, 'write somewhere sensitive', requestId)
      await waitStatus(bridge, sessionId, 'waiting-approval')
      const approval = bridge.approvals()[0]!
      expect(approval).toMatchObject({ risk: 'R2', options: HIGH_RISK_APPROVAL_OPTIONS })
      expect(approval.options?.map(option => option.kind)).toEqual(['allow_once', 'reject_once'])
      await expect(bridge.decide(approval.id, 'allow', { optionId: 'allow_always' })).rejects.toMatchObject({
        status: 400,
        code: 'invalid-option',
      })
      expect(await bridge.decide(approval.id, 'allow', requestId === 'high-1' ? { optionId: 'allow_once' } : {})).toBe(true)
      await waitStatus(bridge, sessionId, 'idle')
    }
    expect(execute).toHaveBeenCalledTimes(3)
    const stored = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as RuntimeState
    expect(stored.tasks[sessionId]!.allowedTools).toEqual(['write_note'])
  })

  it.each([
    [
      'throws',
      async () => {
        throw new Error('classifier unavailable')
      },
    ],
    ['returns an unknown level', async () => 'R9' as RiskLevel],
  ])('treats a classifier that %s as R2', async (_label, classify) => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'must not run' }))
    const bridge = classifiedRuntime(dataDir, classify, execute, false)
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'fail-closed' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    const approval = bridge.approvals()[0]!
    expect(approval).toMatchObject({ risk: 'R2', options: HIGH_RISK_APPROVAL_OPTIONS })
    await bridge.decide(approval.id, 'reject')
    await waitStatus(bridge, sessionId, 'idle')
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps the legacy rule without a classifier: requiresApproval asks as R1, anything else runs', async () => {
    const dataDir = await directory()
    const quiet = vi.fn(async () => ({ text: 'quiet' }))
    const silent = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note'), [tool(quiet, false)]),
        providerId: 'fixture',
      }),
    )
    const first = await silent.createTask({ prompt: 'write', requestId: 'legacy-r0' })
    await waitStatus(silent, first.sessionId, 'idle')
    expect(quiet).toHaveBeenCalledTimes(1)
    await silent.close()

    const asking = own(
      createRuntime({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note'), [tool(quiet, true)]),
        providerId: 'fixture',
      }),
    )
    const second = await asking.createTask({ prompt: 'write', requestId: 'legacy-r1' })
    await waitStatus(asking, second.sessionId, 'waiting-approval')
    expect(asking.approvals()[0]).toMatchObject({ risk: 'R1', options: APPROVAL_OPTIONS })
  })

  it('persists the risk with a pending approval, and a restart neither revives it nor lets an allowance cover R2', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'saved' }))
    let level: RiskLevel = 'R1'
    const seen: ModelMessage[][] = [] // Shared, so call IDs stay unique across the restart.
    const original = classifiedRuntime(dataDir, async () => level, execute, true, seen)
    const { sessionId } = await original.createTask({ prompt: 'write', requestId: 'persisted' })
    await waitStatus(original, sessionId, 'waiting-approval')
    await original.decide(original.approvals()[0]!.id, 'allow', { optionId: 'allow_always' })
    await waitStatus(original, sessionId, 'idle')
    level = 'R2'
    await original.prompt(sessionId, 'write again', 'pending-r2')
    await waitStatus(original, sessionId, 'waiting-approval')
    const pending = original.approvals()[0]!
    const stored = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as RuntimeState
    expect(stored.tasks[sessionId]!.approval).toMatchObject({ id: pending.id, risk: 'R2', options: HIGH_RISK_APPROVAL_OPTIONS })
    await original.close()
    // Restore the bytes committed at the crash cut, as a crash would leave them.
    const store = createSnapshotStore(dataDir)
    await store.load()
    await store.commit(stored)
    await store.close()

    const restarted = classifiedRuntime(dataDir, async () => 'R2', execute, true, seen)
    expect((await restarted.detail(sessionId)).summary.status).toBe('interrupted')
    expect(restarted.approvals()).toEqual([])
    expect(await restarted.decide(pending.id, 'allow')).toBe(false)
    await restarted.prompt(sessionId, 'after restart', 'after-restart')
    await waitStatus(restarted, sessionId, 'waiting-approval')
    expect(restarted.approvals()[0]).toMatchObject({ risk: 'R2', options: HIGH_RISK_APPROVAL_OPTIONS })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('reaches the runtime through the Standard harness driver', async () => {
    const dataDir = await directory()
    const execute = vi.fn(async () => ({ text: 'saved' }))
    const bridge = own(
      standardHarnessDriver.create({
        dataDir,
        workspaceRoot: dataDir,
        registry: registry(toolProvider('write_note'), [tool(execute, false)]),
        providerId: 'fixture',
        classifyToolCall: async () => 'R2',
        tmpRoot: dataDir,
      }),
    )
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'driver' })
    await waitStatus(bridge, sessionId, 'waiting-approval')
    expect(bridge.approvals()[0]).toMatchObject({ risk: 'R2', options: HIGH_RISK_APPROVAL_OPTIONS })
  })
})
