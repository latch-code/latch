import { useState } from 'react'

import type { AgentMemory } from '@latch/protocol'
import { Button, ConfirmDialog, EmptyState, Hint, IconButton, StatusWord, TextAreaField, EditGlyph, PlusGlyph, TrashGlyph } from '@latch/ui'
import { relativeTime } from '../format.ts'
import { TakesEffect, WriteNotice } from './AgentForm.tsx'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'

/** 记忆: what the person wrote for this Agent, to add, change and delete. */
export function MemoryTab({
  owner,
  memories,
  writes,
  disabled,
  onReload,
}: {
  owner: string
  memories: AgentMemory[]
  writes: AgentWrites
  disabled: boolean
  onReload: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [deleting, setDeleting] = useState<AgentMemory | null>(null)
  const base = `custom-agents/${encodeURIComponent(owner)}/memories`
  const locked = disabled || writes.saving || writes.held
  const added = writeFor(writes.state, 'memory:new')
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
            const state = writeFor(writes.state, `memory:${memory.id}`)
            const saved = state !== null && 'phase' in state && state.phase === 'done' && state.write.method === 'PATCH'
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
                    ) : (
                      <time dateTime={memory.updatedAt}>{relativeTime(memory.updatedAt)}</time>
                    )}
                  </span>
                  {state && 'kind' in state && <WriteNotice state={state} onRetry={() => void writes.retry()} onReload={onReload} />}
                </div>
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
