import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { z } from 'zod'
import type { AgentConsultationSettings, AgentMention, CustomAgent, TaskDetail } from '@latch/protocol'
import type { ModelProvider } from '@latch/sdk'
import { DSH_CONSULTATION_GUARD_VERSION } from '@latch/harness-acp'
import type { AuditRecord } from '../src/audit.ts'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { CONSULT_AGENT, LIST_AGENTS } from '../src/agent-consultations.ts'
import { startTestHost } from './helpers/host.ts'

test('only the source may grant DSH access; the reply returns to its human turn and the person can still mention the same chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'latch-consult-dsh-test-'))
  const program = join(dir, 'dsh')
  const queue = join(dir, 'replies.json')
  const log = join(dir, 'acp.ndjson')
  const caption = '水面展览 ' + randomUUID()
  const updatedCaption = '新版展签 ' + randomUUID()
  const question = '这一季展签的副标题是什么？'
  await writeFile(queue, JSON.stringify([caption, updatedCaption, '人工发送的回信']))
  await writeFile(
    program,
    [
      '#!/bin/sh',
      'if [ "$1" = --version ]; then echo 0.2.2-rc.5; exit 0; fi',
      'export FAKE_ACP_PROCESS_MODE=1 FAKE_ACP_CONFIG=options FAKE_ACP_MCP=dsh FAKE_ACP_CAPS=resume,close',
      'export FAKE_ACP_MODES=read-only,workspace-write,danger-full-access FAKE_ACP_INITIAL_MODE=read-only',
      `export FAKE_ACP_LOG='${log}' FAKE_ACP_REPLY_QUEUE='${queue}' FAKE_ACP_STATE='${join(dir, 'sessions.json')}'`,
      `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
  const lists: string[][] = []
  const pauseForRevocation = '核对下一批展签'
  let resumeFirst!: () => void
  let resumeRevoked!: () => void
  const pausedBeforeGrant = new Promise<void>(resolve => {
    resumeFirst = resolve
  })
  const pausedBeforeRevocation = new Promise<void>(resolve => {
    resumeRevoked = resolve
  })
  let peerId = ''
  const provider: ModelProvider = {
    id: 'exhibit-coordinator',
    model: 'fixture',
    name: 'Exhibit coordinator',
    async *stream({ messages }) {
      const last = messages.at(-1)!
      if (last.role === 'user') {
        yield { type: 'tool-call', call: { id: randomUUID(), name: LIST_AGENTS, arguments: {} } }
        yield { type: 'finish', reason: 'tool-calls' }
        return
      }
      const tool = messages.findLast(m => m.role === 'assistant' && m.toolCalls?.some(call => call.id === last.toolCallId))
      if (tool?.toolCalls?.some(call => call.name === LIST_AGENTS)) {
        const directory = z.array(z.object({ id: z.string(), description: z.string() })).parse(JSON.parse(last.content))
        lists.push(directory.map(agent => agent.id))
        if (lists.length === 1) await pausedBeforeGrant
        if (messages.findLast(message => message.role === 'user')?.content === pauseForRevocation) await pausedBeforeRevocation
        const editor = directory.find(agent => agent.description === '展签文案')
        // Exercise dispatch authorization even if a previous turn already learned the target's ID.
        yield { type: 'tool-call', call: { id: randomUUID(), name: CONSULT_AGENT, arguments: { agentId: editor?.id ?? peerId, question } } }
        yield { type: 'finish', reason: 'tool-calls' }
        return
      }
      const answer = last.content.startsWith('{')
        ? z.object({ reply: z.string().optional() }).parse(JSON.parse(last.content)).reply
        : undefined
      yield { type: 'text', text: answer ?? '尚未确认' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const host = await startTestHost({
    demo: false,
    providerId: provider.id,
    plugins: [
      {
        id: 'exhibit-fixture',
        name: 'Exhibit fixture',
        version: '1',
        description: '',
        activate(ctx) {
          ctx.registerProvider(provider)
        },
      },
    ],
    commandDirectories: () => [dir],
    loginPrograms: name => (name === 'dsh' ? program : undefined),
    detectPreset: preset => (preset.id === 'dsh' ? { found: true, path: program } : { found: false }),
  })
  try {
    const user = await host.enroll({ listener: 'unix' })
    await user.confirmedJson('agents', {
      body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
    })
    await user.confirmedJson('agents/dsh/probe', { body: { requestId: randomUUID() } })
    const create = (name: string, harnessId: string, options: object) =>
      user.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: { name, harnessId, mode: 'agent', skills: [], ...options, requestId: randomUUID() },
      })
    const peer = await create('编辑', 'dsh', {
      description: '展签文案',
      instructions: '本期副标题是' + caption,
      engineOptions: { '~mode': 'workspace-write' },
    })
    expect(peer.canConsultAgents).toBeUndefined()
    peerId = peer.id
    const coordinator = await create('接待', 'standard', { model: { providerId: provider.id, model: provider.model }, tools: [] })
    const change = (agent: CustomAgent, updates: AgentConsultationSettings) =>
      user.json<CustomAgent>('custom-agents/' + agent.id, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: agent.revision, ...updates },
      })
    const receipts = async () => (await user.json<{ mentions: AgentMention[] }>(`custom-agents/${coordinator.id}/mentions`)).mentions
    const settled = async (sid: string) => {
      const detail = () => user.json<TaskDetail>('tasks/' + sid)
      await expect.poll(async () => (await detail()).summary.status, { timeout: 15_000 }).toBe('idle')
      return detail()
    }
    const oldGrant = await change(coordinator, { canConsultAgents: true })
    const { sessionId } = await user.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), customAgentId: coordinator.id, prompt: question },
    })
    await expect.poll(() => lists.length, { timeout: 10_000 }).toBe(1)
    expect(lists[0]).not.toContain(peerId)
    const granted = await change(oldGrant, { canConsultAgents: true, canConsultDeepSeek: true })
    resumeFirst()
    await settled(sessionId)
    expect(await receipts()).toHaveLength(0)

    const ask = async (prompt = question) => {
      await user.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt } })
      return settled(sessionId)
    }
    // A legacy source cannot use the target's separate, wider grant.
    const peerWithTools = await change(peer, { useOwnPermissionsForConsultations: true })
    const source = await ask()
    expect(lists.at(-1)).toContain(peerId)
    const records = await receipts()
    const target = await user.json<TaskDetail>('tasks/' + records[0]?.targetSessionId)
    expect(
      target.summary.runOutcome,
      target.messages
        .filter(message => message.role === 'system')
        .map(message => message.text)
        .join('\n'),
    ).toBe('completed')
    expect(records).toMatchObject([
      {
        initiator: 'agent',
        sourceSessionId: sessionId,
        targetAgentId: peerId,
        status: 'completed',
        text: question,
        reply: { text: caption },
      },
    ])
    expect(source.messages.findLast(m => m.role === 'assistant')?.text).toBe(caption)
    expect(target.messages.find(m => m.role === 'user')?.agentBrief?.segments).toEqual(
      expect.arrayContaining([
        { source: 'latch', text: expect.stringContaining('该轮关闭所有工具') },
        { source: 'user', text: peer.instructions },
      ]),
    )
    expect(target.messages.find(m => m.id === records[0].reply?.messageId)).toMatchObject({ role: 'assistant', text: caption })
    expect(target.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual([`来自个人 Agent「接待」的委托\n\n${question}`])
    const pending = ask(pauseForRevocation)
    await expect.poll(() => lists.length).toBe(3)
    expect(lists.at(-1)).toContain(peerId)
    const revoked = await change(granted, { canConsultDeepSeek: false })
    const grantedAgain = await change(revoked, { canConsultAgents: true, canConsultDeepSeek: true })
    resumeRevoked()
    await pending
    expect(await receipts()).toHaveLength(1)

    await change(peerWithTools, { useOwnPermissionsForConsultations: false })
    const localGrant = await change(grantedAgain, { canConsultAgents: true, canConsultLocalAgents: true })
    const followUp = await ask()
    expect(followUp.messages.findLast(m => m.role === 'assistant')?.text).toBe(updatedCaption)
    const second = (await receipts())[1]
    expect(second).toMatchObject({
      initiator: 'agent',
      status: 'completed',
      targetSessionId: target.summary.id,
      reply: { text: updatedCaption },
    })
    expect(second.reply?.messageId).not.toBe(records[0].reply?.messageId)
    expect((await settled(target.summary.id)).messages.find(m => m.id === second.reply?.messageId)).toMatchObject({
      role: 'assistant',
      text: updatedCaption,
    })
    const events = async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map(row =>
          z
            .object({
              pid: z.number(),
              event: z.string(),
              mode: z.string().optional(),
              textOnly: z.boolean().optional(),
              method: z.string().nullish(),
              params: z
                .object({
                  mcpServers: z.array(z.unknown()).optional(),
                  prompt: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
                })
                .nullish(),
            })
            .parse(JSON.parse(row)),
        )
    const guarded = await events()
    const delegated = guarded.filter(row => row.event === 'prompt-mode')
    expect(delegated.map(row => [row.mode, row.textOnly])).toEqual([
      ['workspace-write', true],
      ['workspace-write', true],
    ])
    const firstPrompt = guarded.find(row => row.pid === delegated[0].pid && row.method === 'session/prompt')
    expect(firstPrompt?.params?.prompt?.[0]?.text).toContain(caption)
    expect(firstPrompt?.params?.prompt?.at(-1)?.text).toBe(`来自个人 Agent「接待」的委托\n\n${question}`)
    for (const turn of delegated) {
      const mount = guarded.find(
        row => row.pid === turn.pid && ['session/new', 'session/load', 'session/resume'].includes(row.method ?? ''),
      )
      expect(mount?.params?.mcpServers).toEqual([])
    }

    const disabled = await change(localGrant, { canConsultAgents: false })
    expect(disabled.canConsultDeepSeek).not.toBe(true)
    await change(disabled, { canConsultAgents: true })
    await ask()
    expect(lists.at(-1)).not.toContain(peerId)
    expect(await receipts()).toHaveLength(2)

    const body = { requestId: randomUUID(), target: { kind: 'agent', customAgentId: peer.id }, text: '请回复这条人工消息。' }
    const send = () => user.json<AgentMention>(`custom-agents/${coordinator.id}/mentions`, { method: 'POST', body })
    const manual = await send()
    expect(await send()).toMatchObject({ id: manual.id, targetSessionId: target.summary.id })
    const reused = await settled(target.summary.id)
    expect(reused.messages.filter(m => m.role === 'user' && m.text === body.text)).toHaveLength(1)
    const interactive = (await events()).filter(row => row.event === 'prompt-mode').at(-1)
    expect(interactive?.mode).toBe('workspace-write')
    expect(interactive?.textOnly).not.toBe(true)
    expect(delegated.some(turn => turn.pid === interactive?.pid)).toBe(false)
    expect((await receipts()).at(-1)).toMatchObject({ initiator: 'person', reply: { text: '人工发送的回信' } })
    const evidence = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as AuditRecord)
      .filter(row => row.action === 'agent.consultation.guard-verified')
    const targetRuns = reused.messages.filter(message => message.role === 'user').map(message => message.turnId)
    expect(evidence.map(row => [row.target, row.detail.sessionId, row.detail.runId, row.detail.version])).toEqual([
      [records[0].id, target.summary.id, targetRuns[0], DSH_CONSULTATION_GUARD_VERSION],
      [second.id, target.summary.id, targetRuns[1], DSH_CONSULTATION_GUARD_VERSION],
    ])
    const executions = evidence.map(row => row.detail.executionId)
    expect(executions).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/u), expect.stringMatching(/^[0-9a-f]{64}$/u)])
    expect(new Set(executions).size).toBe(2)
  } finally {
    resumeFirst()
    resumeRevoked()
    await host.close()
    await rm(dir, { recursive: true, force: true })
  }
})
