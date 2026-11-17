import { describe, expect, it } from 'vitest'
import type { HarnessInfo } from '@latch/protocol'
import { agentDeletionMessage, sessionDeletionMessage } from '../src/deletionCopy.ts'

const harnesses = [
  { id: 'standard', capabilities: { display: { label: '内置' } } },
  { id: 'acp:codex', capabilities: { display: { label: 'Codex' } } },
  { id: 'acp:pi', capabilities: { display: { label: 'pi' } } },
] as unknown as HarnessInfo[]

describe('deletion wording', () => {
  it('says the built-in harness keeps nothing elsewhere, and never promises a recall from the model service', () => {
    const text = sessionDeletionMessage([{ harnessId: 'standard' }], harnesses, '计划')
    expect(text).toContain('删除「计划」在 Latch 里的对话、附件与改动快照。')
    expect(text).not.toMatch(/副本|原会话/u)
    expect(text).toContain('已发给模型服务的内容无法撤回。')
    expect(text).toContain('审计与用量记录保留。')
  })

  it('asks an ACP Harness to delete only where it can, and never deletes an imported original', () => {
    const started = sessionDeletionMessage([{ harnessId: 'acp:codex' }], harnesses, 'a')
    expect(started).toContain('Codex 支持删除会话时，Latch 也请它删除自己保存的副本；不支持时副本留在 Codex 里。')
    expect(started).not.toContain('接入的原会话')
    const imported = sessionDeletionMessage([{ harnessId: 'acp:codex', imported: { agentSessionId: 'x' } as never }], harnesses, 'b')
    expect(imported).toContain('从 Codex 接入的原会话不会删除。')
    expect(imported).not.toContain('副本')
  })

  it('names Harness in general when a batch spans several, with both facts', () => {
    const text = sessionDeletionMessage(
      [{ harnessId: 'acp:codex' }, { harnessId: 'acp:pi', imported: { agentSessionId: 'y' } as never }, { harnessId: 'standard' }],
      harnesses,
    )
    expect(text).toContain('删除这些会话')
    expect(text).toContain('Harness 支持删除会话时')
    expect(text).toContain('从 Harness 接入的原会话不会删除。')
  })

  it('keeps an Agent’s conversations and folder', () => {
    expect(agentDeletionMessage('/x/home')).toContain('文件夹：/x/home')
    expect(agentDeletionMessage()).toContain('它的记忆会删除，聊天记录和文件夹会保留。')
  })
})
