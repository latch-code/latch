import { describe, expect, it } from 'vitest'
import type { HarnessInfo } from '@latch/protocol'
import { agentDeletionMessage, originalDeletion, sessionDeletionMessage } from '../src/deletionCopy.ts'

const harnesses = [
  { id: 'standard', capabilities: { display: { label: '内置' }, models: { owner: 'latch' } } },
  { id: 'acp:codex', capabilities: { display: { label: 'Codex' }, models: { owner: 'harness' } } },
  { id: 'acp:pi', capabilities: { display: { label: 'pi' }, models: { owner: 'harness' } } },
] as unknown as HarnessInfo[]

describe('deletion wording', () => {
  it('offers to delete an imported original only where its Harness can, and then says so with the choice alone', () => {
    const withDelete = [
      ...harnesses,
      {
        id: 'acp:claude',
        capabilities: { display: { label: 'Claude Agent' }, models: { owner: 'harness' } },
        history: { list: true, deleteOriginal: true },
      },
    ] as unknown as HarnessInfo[]
    const imported = { harnessId: 'acp:claude', imported: { from: 'acp:claude', mode: 'native' } as never }
    expect(originalDeletion(imported, withDelete)).toBe('同时删除 Claude Agent 里的原会话')
    expect(sessionDeletionMessage([imported], withDelete, 'c')).not.toContain('原会话不会删除')
    // Started in Latch, rebuilt as text, or on a Harness that cannot: no choice.
    expect(originalDeletion({ harnessId: 'acp:claude' }, withDelete)).toBeUndefined()
    expect(originalDeletion({ ...imported, imported: { from: 'acp:codex', mode: 'text' } as never }, withDelete)).toBeUndefined()
    expect(
      originalDeletion({ harnessId: 'acp:codex', imported: { from: 'acp:codex', mode: 'native' } as never }, withDelete),
    ).toBeUndefined()
  })

  it('says the built-in harness keeps nothing elsewhere, and never promises a recall from the model service', () => {
    const text = sessionDeletionMessage([{ harnessId: 'standard' }], harnesses, '计划')
    expect(text).toContain('删除「计划」在 Latch 里的对话、附件与改动快照。')
    expect(text).not.toMatch(/副本|原会话/u)
    expect(text).toContain('已发给模型服务的内容无法撤回。')
    expect(text).toContain('审计与用量记录保留。')
  })

  it('asks an ACP Harness to delete only where it can, and never deletes an imported original', () => {
    const started = sessionDeletionMessage([{ harnessId: 'acp:codex' }], harnesses, 'a')
    expect(started).toContain('Latch 能启动 Codex 且它支持删除会话时，也请它删除自己保存的副本；否则它自己的副本可能留下。')
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
    expect(text).toContain('Latch 能启动 Harness 且它支持删除会话时')
    expect(text).toContain('从 Harness 接入的原会话不会删除。')
  })

  it('keeps an Agent’s conversations and says what happens to its folder', () => {
    expect(agentDeletionMessage('/x/home')).toContain('文件夹：/x/home')
    expect(agentDeletionMessage()).toContain('它的记忆会删除，聊天记录保留。')
    expect(agentDeletionMessage(undefined, 'files')).toContain('文件夹无法恢复')
    expect(agentDeletionMessage(undefined, 'empty')).toContain('空文件夹会删除')
  })
})
