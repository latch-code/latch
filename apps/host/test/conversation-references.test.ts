import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Message, TaskDetail } from '@latch/protocol'
import type { ModelProvider } from '@latch/sdk'
import { ConversationReferences, privateReferenceSource, REFERENCE_TOOL, referenceMarker } from '../src/conversation-references.ts'
import { startTestHost } from './helpers/host.ts'

describe('explicit on-demand conversation references', () => {
  it('keeps source privacy from the personal or agent identity, even without a separate private flag', () => {
    const ordinary = { id: 'source' }
    const publicAtHost = () => false
    expect(privateReferenceSource(ordinary, publicAtHost)).toBe(false)
    expect(privateReferenceSource(ordinary, () => true)).toBe(true)
    expect(privateReferenceSource({ ...ordinary, agent: { customAgentId: 'helper' } }, publicAtHost)).toBe(true)
    expect(privateReferenceSource({ ...ordinary, personal: { assistantId: 'assistant', groupId: 'group' } }, publicAtHost)).toBe(true)
  })
  it('retains message identities across restart, excludes new and changed text and restricts the caller to its named reference', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-session-ref-'))
    const actor = { deviceId: 'reader', dataScope: 'all', listener: 'unix' } as const
    const messages: Message[] = [
      { role: 'assistant', id: 'answer', text: 'Initial answer' },
      { role: 'tool', id: 'tool', text: 'Tool payload' },
      { role: 'user', id: 'question', text: 'a'.repeat(8100) },
    ]
    try {
      const first = await ConversationReferences.open(dir)
      const request = randomUUID()
      const reference = await first.add(actor, 'dest', 'source', request, messages, () => {})
      expect(await first.add(actor, 'dest', 'source', request, messages, () => {})).toBe(reference)
      await expect(first.add(actor, 'dest', 'another', request, messages, () => {})).rejects.toMatchObject({ code: 'request-conflict' })
      await first.close()
      expect(await readFile(join(dir, 'handoffs', 'conversation-references.json'), 'utf8')).not.toContain('Initial answer')
      const restored = await ConversationReferences.open(dir)
      const marker = referenceMarker(reference)
      expect(() => restored.forRead('other', { reference }, marker)).toThrow()
      expect(() => restored.forRead('dest', { reference }, 'only a draft')).toThrow()
      const { ref } = restored.forRead('dest', { reference }, marker)
      messages[0]!.text = 'Changed answer'
      messages.push({ role: 'user', id: 'later', text: 'After the grant' })
      const page = JSON.parse(restored.page(ref, messages, 0))
      expect(page.text).not.toMatch(/Changed answer|Tool payload|After the grant/u)
      expect(page.nextOffset).toBe(8000)
      expect(JSON.parse(restored.page(ref, messages, page.nextOffset)).text.length).toBeLessThan(200)
      expect(restored.owned('dest', 'other')).toEqual([])
      await restored.revoke('dest', 'other', reference, () => {})
      expect(restored.owned('dest', actor.deviceId)).toEqual([{ reference, source: 'source' }])
      await restored.revoke('dest', actor.deviceId, reference, () => {})
      expect(restored.owned('dest', actor.deviceId)).toEqual([])
      await expect(restored.add(actor, 'dest', 'source', request, messages, () => {})).rejects.toMatchObject({ code: 'reference-revoked' })
      await restored.add(actor, 'dest', 'source', randomUUID(), messages, () => {})
      await restored.forget('source')
      expect(() => restored.forRead('dest', { reference }, marker)).toThrow()
      await restored.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('delivers referenced messages only through the tool and refuses the next read after the granting device loses run', async () => {
    const outputs: string[] = []
    const inputs: string[] = []
    const provider: ModelProvider = {
      id: 'reference-model',
      name: 'References',
      model: 'fake',
      async *stream({ messages, tools }) {
        const last = messages.at(-1)
        const body = last?.content ?? ''
        if (last?.role === 'tool') {
          outputs.push(body)
          yield { type: 'text', text: 'Processed reference' }
        } else {
          inputs.push(body)
          const reference = /\[conversation-ref:([0-9a-f-]{36})\]/u.exec(body)?.[1]
          if (reference) {
            expect(tools?.some(tool => tool.name === REFERENCE_TOOL.name)).toBe(true)
            yield { type: 'tool-call', call: { id: randomUUID(), name: REFERENCE_TOOL.name, arguments: { reference } } }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: 'Answer to ' + body }
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const host = await startTestHost({
      providerId: provider.id,
      plugins: [
        {
          id: 'ref-fixture',
          name: 'References',
          version: '1',
          description: '',
          activate(ctx) {
            ctx.registerProvider(provider)
          },
        },
      ],
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const reader = await host.enroll({ scopes: ['view', 'run'] })
      const sourceText = 'From yesterday’s review: keep the original revision.'
      const start = async (prompt: string) => {
        const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { requestId: randomUUID(), prompt, mode: 'agent', workspaceId: 'default' },
        })
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
        return sessionId
      }
      const source = await start(sourceText)
      const target = await start('New task')
      const add = { requestId: randomUUID(), source }
      const result = await reader.json<{ reference: string }>(`tasks/${target}/conversation-references`, { method: 'POST', body: add })
      const noRun = await host.enroll({ scopes: ['view'] })
      expect(
        (await noRun.request(`tasks/${target}/conversation-references`, { method: 'POST', body: { ...add, requestId: randomUUID() } }))
          .status,
      ).toBe(403)
      const ask = async () => {
        await owner.json(`tasks/${target}/prompt`, {
          method: 'POST',
          body: { requestId: randomUUID(), prompt: referenceMarker(result.reference) },
        })
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${target}`)).approvals.length).toBe(1)
        const detail = await owner.json<TaskDetail>(`tasks/${target}`)
        await owner.json(`approvals/${detail.approvals[0]!.id}`, { method: 'POST', body: { decision: 'allow' } })
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${target}`)).summary.status).toBe('idle')
      }
      await ask()
      expect(inputs.at(-1)).toBe(referenceMarker(result.reference))
      expect(outputs.at(-1)).toContain(sourceText)
      await owner.json(`devices/${reader.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
      await ask()
      expect(outputs.at(-1)).not.toContain(sourceText)
    } finally {
      await host.close()
    }
  })
})
