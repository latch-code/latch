import { useState } from 'react'

import type { AgentMemory, AgentMemoryChange, MemoryProposal } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Hint,
  IconButton,
  StatusWord,
  TextAreaField,
  EditGlyph,
  PlusGlyph,
  TrashGlyph,
  UndoGlyph,
} from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { relativeTime } from '../format.ts'
import { TakesEffect, WriteNotice } from './AgentForm.tsx'
import { ProposalRow } from './ProposalRow.tsx'
import { originWords } from './proposals.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'

/** A memory saved from a proposal: who it came from, its topic (a link while the topic is listed) and when. */
function MemorySource({
  memory,
  topicTitle,
  onOpenTopic,
}: {
  memory: AgentMemory
  topicTitle: (sessionId: string) => string | undefined
  onOpenTopic?: ((sessionId: string) => void) | undefined
}) {
  const source = memory.source
  if (!source) return null
  const title = topicTitle(source.sessionId)
  return (
    <span className="agent-memory-source">
      <span>{originWords(source.origin)}</span>
      {source.external && <StatusWord tone="warn">来自外部内容</StatusWord>}
      {title !== undefined
        && (onOpenTopic ? (
          <button
            type="button"
            className="agent-memory-topic"
            onClick={() => {
              onOpenTopic(source.sessionId)
            }}>
            <VisibleText text={title || '未命名会话'} />
          </button>
        ) : (
          <span className="agent-memory-topic">
            <VisibleText text={title || '未命名会话'} />
          </span>
        ))}
      <time dateTime={source.proposedAt}>{relativeTime(source.proposedAt)}</time>
    </span>
  )
}

/**
 * 记忆: proposals waiting for the person first, with 保存 and 不要; then what is kept, each with where it came from when
 * it was a proposal, to add, change and delete; the last edit or delete of each can be undone once.
 */
export function MemoryTab({
  owner,
  memories,
  changes = [],
  proposals = [],
  effect,
  writes,
  disabled,
  onReload,
  topicTitle = () => undefined,
  onOpenTopic,
}: {
  owner: string
  memories: AgentMemory[]
  /** Each memory's last edit or delete that can still be undone. */
  changes?: AgentMemoryChange[]
  proposals?: MemoryProposal[]
  /** When a saved proposal takes effect, where every topic of this Agent runs on one kind of Harness. */
  effect?: string | undefined
  writes: AgentWrites
  disabled: boolean
  onReload: () => void
  /** A topic's title while it is listed on this device; undefined otherwise. */
  topicTitle?: (sessionId: string) => string | undefined
  onOpenTopic?: ((sessionId: string) => void) | undefined
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [deleting, setDeleting] = useState<AgentMemory | null>(null)
  const base = `custom-agents/${encodeURIComponent(owner)}/memories`
  const locked = disabled || writes.saving || writes.held
  const added = writeFor(writes.state, 'memory:new')
  // A proposal this device is deciding stays here until the Host answers, so its result is never out of sight.
  const waiting = proposals.filter(
    proposal => proposal.state === 'pending' || writes.state?.write.key.startsWith(`proposal:${proposal.id}:`) === true,
  )
  const deleted = changes.filter(change => change.operation === 'delete' && !memories.some(memory => memory.id === change.memoryId))
  // Both carry the revision shown, so a change made elsewhere since is not undone or cleared unseen.
  const undo = (memoryId: string, baseRevision: number) => {
    void writes.run(`memory:${memoryId}:undo`, `${base}/${memoryId}/undo`, 'POST', { baseRevision })
  }
  const forget = (memoryId: string, baseRevision: number) => {
    void writes.run(`memory:${memoryId}:undo`, `${base}/${memoryId}/undo`, 'DELETE', { baseRevision })
  }
  const add = async () => {
    if (!text.trim() || locked) return
    if (await writes.run(`memory:new`, base, 'POST', { content: text.trim() })) {
      setText('')
      setAdding(false)
    }
  }
  return (
    <div className="agent-memory">
      <div className="agent-memory-bar">
        <Hint label="只给这个 Agent">
          只有你能写，只有这个 Agent 会用，工具不会改写它。在这里删除只删 Latch 保存的这一条，不会抹掉上游服务里已有的记录。
        </Hint>
        <TakesEffect />
        <span className="agent-form-spacer" />
        {!adding && (
          <Button
            icon={PlusGlyph}
            disabled={locked}
            onClick={() => {
              setAdding(true)
            }}>
            添加
          </Button>
        )}
      </div>
      {waiting.length > 0 && (
        <section className="agent-memory-proposals" aria-label="提议">
          <h4>
            提议 <span className="agent-memory-count">{waiting.length}</span>
          </h4>
          {waiting.map(proposal => (
            <ProposalRow key={proposal.id} owner={owner} proposal={proposal} writes={writes} effect={effect} disabled={disabled} compact />
          ))}
        </section>
      )}
      {adding && (
        <form
          className="agent-memory-edit"
          onSubmit={event => {
            event.preventDefault()
            void add()
          }}>
          <TextAreaField
            label="新记忆"
            value={text}
            rows={3}
            maxLength={4000}
            autoFocus
            disabled={locked}
            onChange={event => {
              setText(event.target.value)
            }}
          />
          <WriteNotice state={added} onRetry={() => void writes.retry().then(done => done && (setText(''), setAdding(false)))} />
          <div className="agent-form-actions">
            <span className="agent-form-spacer" />
            <Button
              disabled={writes.saving}
              onClick={() => {
                setAdding(false)
                setText('')
              }}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={locked || !text.trim()}
              loading={added !== null && 'phase' in added && added.phase === 'saving'}>
              保存
            </Button>
          </div>
        </form>
      )}
      {memories.length === 0 && !adding ? (
        <EmptyState title="还没有记忆" />
      ) : (
        <ul className="agent-memory-list" aria-label="记忆">
          {memories.map(memory => {
            const state = writeFor(writes.state, `memory:${memory.id}`) ?? writeFor(writes.state, `memory:${memory.id}:undo`)
            const saved = state !== null && 'phase' in state && state.phase === 'done' && state.write.method === 'PATCH'
            const undone = state !== null && 'phase' in state && state.phase === 'done' && state.write.key.endsWith(':undo')
            const edited = changes.some(change => change.memoryId === memory.id && change.operation === 'update')
            if (editing?.id === memory.id)
              return (
                <li key={memory.id}>
                  <form
                    className="agent-memory-edit"
                    onSubmit={event => {
                      event.preventDefault()
                      if (locked || !editing.text.trim()) return
                      void writes
                        .run(`memory:${memory.id}`, `${base}/${memory.id}`, 'PATCH', {
                          content: editing.text.trim(),
                          baseRevision: memory.revision,
                        })
                        .then(done => {
                          if (done) setEditing(null)
                        })
                    }}>
                    <TextAreaField
                      label="修改记忆"
                      value={editing.text}
                      rows={3}
                      maxLength={4000}
                      autoFocus
                      disabled={locked}
                      onChange={event => {
                        setEditing({ id: memory.id, text: event.target.value })
                      }}
                    />
                    <WriteNotice
                      state={state}
                      onRetry={() => void writes.retry().then(done => done && setEditing(null))}
                      onReload={() => {
                        setEditing(null)
                        writes.clear()
                        onReload()
                      }}
                    />
                    <div className="agent-form-actions">
                      <span className="agent-form-spacer" />
                      <Button
                        disabled={writes.saving}
                        onClick={() => {
                          setEditing(null)
                        }}>
                        取消
                      </Button>
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={locked || !editing.text.trim() || editing.text.trim() === memory.content}>
                        保存
                      </Button>
                    </div>
                  </form>
                </li>
              )
            return (
              <li key={memory.id} className="agent-memory-row">
                <div className="agent-memory-text">
                  <p>{memory.content}</p>
                  <span className="agent-memory-meta">
                    {saved ? (
                      <StatusWord tone="done">已保存</StatusWord>
                    ) : undone ? (
                      <StatusWord tone="done">已撤销</StatusWord>
                    ) : memory.source ? (
                      <MemorySource memory={memory} topicTitle={topicTitle} onOpenTopic={onOpenTopic} />
                    ) : (
                      <time dateTime={memory.updatedAt}>{relativeTime(memory.updatedAt)}</time>
                    )}
                  </span>
                  {state && 'kind' in state && <WriteNotice state={state} onRetry={() => void writes.retry()} onReload={onReload} />}
                </div>
                {edited && (
                  <IconButton
                    size="sm"
                    label="撤销修改"
                    icon={UndoGlyph}
                    disabled={locked}
                    onClick={() => {
                      undo(memory.id, memory.revision)
                    }}
                  />
                )}
                <IconButton
                  size="sm"
                  label="修改"
                  icon={EditGlyph}
                  disabled={locked}
                  onClick={() => {
                    writes.clear()
                    setEditing({ id: memory.id, text: memory.content })
                  }}
                />
                <IconButton
                  size="sm"
                  label="删除"
                  icon={TrashGlyph}
                  disabled={locked}
                  onClick={() => {
                    setDeleting(memory)
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}
      {deleted.length > 0 && (
        <ul className="agent-memory-list agent-memory-deleted" aria-label="已删除">
          {deleted.map(change => {
            const state = writeFor(writes.state, `memory:${change.memoryId}:undo`)
            return (
              <li key={change.memoryId} className="agent-memory-row">
                <div className="agent-memory-text">
                  <p>
                    <VisibleText text={change.previous.content} />
                  </p>
                  <span className="agent-memory-meta">
                    已删除 · <time dateTime={change.at}>{relativeTime(change.at)}</time>
                    <Hint label="7 天">7 天后或按「清除」后不能再撤销，记忆与它的提议里不再留这段文字；话题里的对话记录不变。</Hint>
                  </span>
                  <WriteNotice state={state} onRetry={() => void writes.retry()} onReload={onReload} />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={UndoGlyph}
                  disabled={locked}
                  loading={state !== null && 'phase' in state && state.phase === 'saving' && state.write.method === 'POST'}
                  onClick={() => {
                    undo(change.memoryId, change.previous.revision)
                  }}>
                  撤销
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={locked}
                  loading={state !== null && 'phase' in state && state.phase === 'saving' && state.write.method === 'DELETE'}
                  onClick={() => {
                    forget(change.memoryId, change.previous.revision)
                  }}>
                  清除
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title="删除这条记忆？"
          danger
          confirmLabel="删除"
          message="这个 Agent 之后不再收到它。已经开始的外部 Harness 会话里已发出的内容不会撤回。"
          onClose={() => {
            setDeleting(null)
          }}
          onConfirm={async () => {
            const done = await writes.run(`memory:${deleting.id}`, `${base}/${deleting.id}`, 'DELETE', {})
            if (done === undefined) throw new Error('没有删除，原因见页面上的说明。')
          }}
        />
      )}
    </div>
  )
}
