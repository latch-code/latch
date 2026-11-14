import { describe, expect, it } from 'vitest'
import type { Message, TaskDetail } from '@latch/protocol'
import { allApproval, allTaskContent, workApproval, workTaskContent } from '../src/task-content.ts'
import { NativeReplay } from '../src/native-replay.ts'

const secret = 'FILE_BODY_SENTINEL_4896'
const note = 'TOOL_OUTCOME_UNKNOWN: 结果未知，请先核对它做了什么。Latch 不会自动重做。'
const source = (messages: Message[]): TaskDetail => ({
  summary: { harnessId: 'fixture', id: 'task', title: 'Task', status: 'interrupted', updatedAt: '2026-11-14T00:00:00.000Z' },
  messages,
  approvals: [],
  liveText: '',
  cursor: 9,
})
const edit = (changes: Partial<Message> = {}): Message => ({
  id: 'edit-1',
  role: 'tool',
  toolName: 'edit',
  state: 'failed',
  text: `${secret}\n\n${note}`,
  tool: {
    kind: 'edit',
    title: 'Edit notes.txt',
    locations: ['notes.txt'],
    input: JSON.stringify({ path: 'notes.txt', oldText: secret, newText: secret }),
    output: `${secret}\n\n${note}`,
    diffs: [{ path: 'notes.txt', oldText: secret, newText: secret }],
    decision: { outcome: 'allowed', at: '2026-11-14T00:00:00.000Z', via: 'other-device' },
  },
  ...changes,
})

describe('restricted tool presentation', () => {
  it('keeps projection provenance off every all-data message, child step and approval without changing original content', () => {
    const original = edit()
    original.tool!.outputWithoutFiles = 'PRIVATE_PROJECTION_HINT'
    const parent: Message = { id: 'parent', role: 'tool', text: 'Parent', subagent: { title: 'Child', status: 'done', steps: [original] } }
    const approval = { id: 'ask', sessionId: 'task', toolName: 'edit', reason: 'Write', requestedAt: 'now', tool: original.tool }
    const detail = { ...source([original, parent]), approvals: [approval] }
    const saved = structuredClone(detail),
      shown = allTaskContent(detail)
    expect(JSON.stringify(shown)).not.toContain('PRIVATE_PROJECTION_HINT')
    expect(JSON.stringify(shown)).not.toContain('outputWithoutFiles')
    expect(shown.messages[0]!.text).toBe(original.text)
    expect(shown.messages[0]!.tool!.diffs).toEqual(original.tool!.diffs)
    expect(allApproval(approval).tool).not.toHaveProperty('outputWithoutFiles')
    expect(detail).toEqual(saved)
  })

  it('does not expand small withheld results beyond the existing native event limit', () => {
    const detail = source(
      Array.from({ length: 9000 }, (_, index) => ({
        id: `tiny-${index}`,
        role: 'tool' as const,
        state: 'completed' as const,
        text: 'x',
        tool: { kind: 'edit' as const, output: 'x' },
      })),
    )
    const event = new NativeReplay('instance').publish({
      type: 'task-state',
      instanceId: 'instance',
      revision: 1,
      sessionId: 'task',
      detail,
    })
    expect(event.type).toBe('task-state')
    if (event.type !== 'task-state') throw new Error('The fixture itself exceeded the native limit')
    expect(Buffer.byteLength(JSON.stringify({ ...event, detail: workTaskContent(event.detail) }))).toBeLessThanOrEqual(1_048_000)
  })

  it('withholds legacy edit bodies and copies while preserving paths, identity and unknown outcome', () => {
    const detail = source([edit()]),
      saved = structuredClone(detail)
    const shown = workTaskContent(detail)
    expect(JSON.stringify(shown)).not.toContain(secret)
    expect(shown.messages[0]).toMatchObject({
      id: 'edit-1',
      state: 'failed',
      tool: { locations: ['notes.txt'], decision: saved.messages[0]!.tool!.decision },
    })
    expect(shown.messages[0]!.tool!.output).toContain(note)
    expect(shown.messages[0]!.text).toContain(note)
    expect(shown.messages[0]!.tool!.diffs).toBeUndefined()
    expect(detail).toEqual(saved)
  })

  it('keeps exact safe numeric lexemes and escaped paths, but never numeric file content or opaque keys', () => {
    const input =
      '{ "file\\u0050ath": "notes.txt", "content": [70,73,76,69], "bytes":9007199254740993,"offset":-0,"length":0.10000000000000001,"'
      + secret
      + '":"opaque" }'
    const approval = workApproval({
      id: 'ask',
      sessionId: 'task',
      toolName: 'edit',
      reason: 'Review the write',
      requestedAt: 'now',
      arguments: input,
      tool: { kind: 'edit', input },
    })
    expect(approval.arguments).toContain('"file\\u0050ath":"notes.txt"')
    expect(approval.arguments).toContain('"bytes":9007199254740993')
    expect(approval.arguments).toContain('"offset":-0')
    expect(approval.arguments).toContain('"length":0.10000000000000001')
    expect(approval.arguments).not.toContain('[70,73,76,69]')
    expect(JSON.stringify(approval)).not.toContain(secret)
    expect(JSON.parse(approval.arguments!)).toHaveProperty('filePath', 'notes.txt')
  })

  it('uses the producer safe result without losing its ordinary output or unknown note', () => {
    const message = edit()
    message.text = message.tool!.output = `The write result is not confirmed.\n${secret}\n\n${note}`
    message.tool!.outputWithoutFiles = `The write result is not confirmed.\n\n${note}`
    const shown = workTaskContent(source([message])).messages[0]!
    expect(shown.tool!.output).toBe(message.tool!.outputWithoutFiles)
    expect(shown.text).toBe(message.tool!.outputWithoutFiles)
    expect(shown.tool).not.toHaveProperty('outputWithoutFiles')
    expect(JSON.stringify(shown)).not.toContain(secret)
  })

  it('refuses a producer summary that would expand the encoded edit result', () => {
    const message = edit({ text: 'x', tool: { kind: 'edit', output: 'x', outputWithoutFiles: 'longer invented summary' } })
    const shown = workTaskContent(source([message])).messages[0]!
    expect(shown.text).toBe('')
    expect(shown.tool!.output).toBe('')
    expect(JSON.stringify(shown)).not.toContain('longer invented summary')
  })

  it('projects nested subagent edits but leaves ordinary commands, MCP results and chat text intact', () => {
    const ordinary: Message = {
      id: 'command',
      role: 'tool',
      state: 'completed',
      text: secret,
      toolName: 'mcp.read',
      tool: { kind: 'execute', input: `echo '${secret}'`, output: secret },
    }
    const parent: Message = {
      id: 'child',
      role: 'tool',
      text: 'Subagent',
      subagent: {
        title: 'Helper',
        status: 'failed',
        steps: [edit()],
      },
    }
    const result = workTaskContent(source([ordinary, { id: 'chat', role: 'assistant', text: secret }, parent]))
    expect(result.messages[0]).toEqual(ordinary)
    expect(result.messages[1]!.text).toBe(secret)
    expect(JSON.stringify(result.messages[2])).not.toContain(secret)
    expect(result.messages[2]!.subagent!.steps[0]!.id).toBe('edit-1')
  })

  it('preserves historical rejection and error evidence without interpreting code as a final result', () => {
    const messages = ['APPROVAL_REJECTED: no', `TOOL_ERROR: ${secret}`, `${secret}\n+const note = 'TOOL_OUTCOME_UNKNOWN:'`].map((text, i) =>
      edit({ id: `old-${i}`, text, tool: { kind: 'edit', output: text } }),
    )
    const shown = workTaskContent(source(messages)).messages
    expect(shown[0]!.tool!.output).toMatch(/^APPROVAL_REJECTED:/u)
    expect(shown[1]!.tool!.output).toContain('TOOL_ERROR:')
    expect(shown[2]!.tool!.output).not.toContain('TOOL_OUTCOME_UNKNOWN')
    expect(JSON.stringify(shown)).not.toContain(secret)
  })
})
