import { useState } from 'react'

import { outsideMemory, type AgentMemory, type AgentMemoryChange, type CustomAgentSummary, type MemoryProposal } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Hint,
  IconButton,
  StatusWord,
  SwitchRow,
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
import { MessageError } from '../core/api.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    external: '来自外部内容',
    untitled: '未命名会话',
    modified: '已修改',
    generalFacts: '通用里你确认过的事',
    generalEmpty: '通用里还没有',
    facts: (total: number, sent?: number) => `${sent === undefined ? '' : `${formatNumber(sent)} / `}${formatNumber(total)} 条`,
    shareGeneral: '带上「通用」里关于你的事',
    shareDetail:
      '你在「通用」里写下或保存的记忆，只读地带给这个 Agent，标明是你告诉 Latch 的。导入的和来自外部内容的不带。最多带最近的 24 条、6 KB。只有能查看全部内容的设备发出的对话才会带入。只在首轮收到上下文的 Harness 上，打开或关掉都在清空上下文后才生效。',
    thisAgent: '只给这个 Agent',
    memoryDetail:
      '只有你能写，只有这个 Agent 会用，工具不会改写它。在这里删除只删 Latch 保存的这一条，不会抹掉上游服务里已有的记录。导入的和来自外部内容的记忆只作为资料带给 Agent，点「设为我说的」后才算你的话。',
    add: '添加',
    proposals: '提议',
    newMemory: '新记忆',
    cancel: '取消',
    save: '保存',
    empty: '还没有记忆',
    memory: '记忆',
    editMemory: '修改记忆',
    saved: '已保存',
    undone: '已撤销',
    imported: '导入',
    markedMine: '已设为你说的',
    asReference: '作为资料',
    markMine: '设为我说的',
    undoEdit: '撤销修改',
    edit: '修改',
    delete: '删除',
    deleted: '已删除',
    deletedAt: '已删除 ·',
    sevenDays: '7 天',
    undoWindow: '7 天后或按「清除」后不能再撤销，记忆与它的提议里不再留这段文字；话题里的对话记录不变。',
    undo: '撤销',
    clear: '清除',
    confirmClear: '清除这条记忆？',
    permanent: '清除后不能再撤销。',
    clearFailed: '没有清除，原因见页面上的说明。',
    confirmDelete: '删除这条记忆？',
    deleteDetail: '后续上下文不会收到这条记忆。外部 Harness 已收到的内容会保留在原上下文，直到清空上下文。',
    deleteFailed: '没有删除，原因见页面上的说明。',
  },
  {
    external: 'From external content',
    untitled: 'Untitled session',
    modified: 'Edited',
    generalFacts: 'Facts you confirmed in General',
    generalEmpty: 'No facts in General yet',
    facts: (total: number, sent?: number) =>
      sent === undefined
        ? plural(total, { one: '{n} entry', other: '{n} entries' })
        : `${formatNumber(sent)} of ${formatNumber(total)} entries`,
    shareGeneral: 'Share your General memories',
    shareDetail:
      'Memories you wrote or saved in General are shared with this Agent as read-only facts you told Latch. Shared memories exclude imports and external content. Latch shares up to the latest 24 entries and 6 KB, only in conversations started by devices with full data access. For Harnesses that receive context only on the first turn, changes take effect after clearing the context.',
    thisAgent: 'Used only by this Agent',
    memoryDetail:
      'Only you can write these memories, and this Agent is the only one that uses them. Tools cannot overwrite them. Deletion here removes Latch’s copy while upstream records are retained. Imported memories and external content are reference material until you choose Mark as my words.',
    add: 'Add',
    proposals: 'Proposals',
    newMemory: 'New memory',
    cancel: 'Cancel',
    save: 'Save',
    empty: 'No memories yet',
    memory: 'Memory',
    editMemory: 'Edit memory',
    saved: 'Saved',
    undone: 'Undone',
    imported: 'Imported',
    markedMine: 'Marked as your words',
    asReference: 'Reference material',
    markMine: 'Mark as my words',
    undoEdit: 'Undo edit',
    edit: 'Edit',
    delete: 'Delete',
    deleted: 'Deleted',
    deletedAt: 'Deleted ·',
    sevenDays: '7 days',
    undoWindow:
      'You can undo deletion within 7 days, until you choose Clear. After that, the memory and its proposal no longer contain the text. The conversation history is retained.',
    undo: 'Undo',
    clear: 'Clear',
    confirmClear: 'Clear this memory?',
    permanent: 'Clearing is permanent.',
    clearFailed: 'Couldn’t clear the memory. See the explanation on this page.',
    confirmDelete: 'Delete this memory?',
    deleteDetail:
      'Deletion removes this memory from future context. An external Harness keeps the copy it already received until you clear its context.',
    deleteFailed: 'Couldn’t delete the memory. See the explanation on this page.',
  },
)

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
      {source.external && <StatusWord tone="warn">{COPY.external}</StatusWord>}
      {title !== undefined
        && (onOpenTopic ? (
          <button
            type="button"
            className="agent-memory-topic"
            onClick={() => {
              onOpenTopic(source.sessionId)
            }}>
            <VisibleText text={title || COPY.untitled} />
          </button>
        ) : (
          <span className="agent-memory-topic">
            <VisibleText text={title || COPY.untitled} />
          </span>
        ))}
      <time dateTime={source.proposedAt}>{relativeTime(source.proposedAt)}</time>
      {memory.edited && <span>{COPY.modified}</span>}
    </span>
  )
}

/**
 * 「认识你」: whether this Agent's turns carry what the person confirmed in 通用, and how many of those go now. Off is
 * stored on the Agent; the facts themselves stay 通用's and are edited there.
 */
function KnowsYou({
  agent,
  canRun,
  disabled,
  writes,
}: {
  agent: CustomAgentSummary
  canRun: boolean
  disabled: boolean
  writes: AgentWrites
}) {
  const on = agent.generalFactsOff !== true
  const facts = agent.generalFacts
  const state = writeFor(writes.state, `knows-you:${agent.id}`)
  const words = !facts
    ? COPY.generalFacts
    : facts.total === 0
      ? COPY.generalEmpty
      : on && facts.sent < facts.total
        ? COPY.facts(facts.total, facts.sent)
        : COPY.facts(facts.total)
  return (
    <div className="agent-knows-you">
      <SwitchRow
        title={COPY.shareGeneral}
        description={<Hint label={words}>{COPY.shareDetail}</Hint>}
        checked={on}
        disabled={!canRun || disabled || writes.saving || writes.held}
        onCheckedChange={next => {
          void writes.run(`knows-you:${agent.id}`, `custom-agents/${encodeURIComponent(agent.id)}`, 'PATCH', {
            generalFacts: next,
            baseRevision: agent.revision,
          })
        }}
      />
      <WriteNotice state={state} onRetry={() => void writes.retry()} />
    </div>
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
  knowsYou,
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
  /** One of 我的 Agent (not 通用): its 「认识你」 switch. */
  knowsYou?: { agent: CustomAgentSummary; canRun: boolean } | undefined
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [deleting, setDeleting] = useState<AgentMemory | null>(null)
  const [clearing, setClearing] = useState<{ memoryId: string; baseRevision: number } | null>(null)
  const base = `custom-agents/${encodeURIComponent(owner)}/memories`
  const locked = disabled || writes.saving || writes.held
  const added = writeFor(writes.state, 'memory:new')
  // A proposal this device is deciding stays here until the Host answers, so its result is never out of sight.
  const waiting = proposals.filter(
    proposal => proposal.state === 'pending' || writes.state?.write.key.startsWith(`proposal:${proposal.id}:`) === true,
  )
  const deleted = changes.filter(change => change.operation === 'delete' && !memories.some(memory => memory.id === change.memoryId))
  // 撤销 and 清除 carry the revision shown, so a change made elsewhere since is not undone or cleared unseen.
  const undo = (memoryId: string, baseRevision: number) => {
    void writes.run(`memory:${memoryId}:undo`, `${base}/${memoryId}/undo`, 'POST', { baseRevision })
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
      {knowsYou && <KnowsYou agent={knowsYou.agent} canRun={knowsYou.canRun} disabled={disabled} writes={writes} />}
      <div className="agent-memory-bar">
        <Hint label={COPY.thisAgent}>{COPY.memoryDetail}</Hint>
        <TakesEffect />
        <span className="agent-form-spacer" />
        {!adding && (
          <Button
            icon={PlusGlyph}
            disabled={locked}
            onClick={() => {
              setAdding(true)
            }}>
            {COPY.add}
          </Button>
        )}
      </div>
      {waiting.length > 0 && (
        <section className="agent-memory-proposals" aria-label={COPY.proposals}>
          <h4>
            {COPY.proposals} <span className="agent-memory-count">{formatNumber(waiting.length)}</span>
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
            label={COPY.newMemory}
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
              {COPY.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={locked || !text.trim()}
              loading={added !== null && 'phase' in added && added.phase === 'saving'}>
              {COPY.save}
            </Button>
          </div>
        </form>
      )}
      {memories.length === 0 && !adding ? (
        <EmptyState title={COPY.empty} />
      ) : (
        <ul className="agent-memory-list" aria-label={COPY.memory}>
          {memories.map(memory => {
            const state =
              writeFor(writes.state, `memory:${memory.id}`)
              ?? writeFor(writes.state, `memory:${memory.id}:undo`)
              ?? writeFor(writes.state, `memory:${memory.id}:own`)
            const material = outsideMemory(memory)
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
                      label={COPY.editMemory}
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
                        {COPY.cancel}
                      </Button>
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={locked || !editing.text.trim() || editing.text.trim() === memory.content}>
                        {COPY.save}
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
                      <StatusWord tone="done">{COPY.saved}</StatusWord>
                    ) : undone ? (
                      <StatusWord tone="done">{COPY.undone}</StatusWord>
                    ) : memory.source ? (
                      <MemorySource memory={memory} topicTitle={topicTitle} onOpenTopic={onOpenTopic} />
                    ) : memory.imported ? (
                      <span className="agent-memory-source">
                        <span>{COPY.imported}</span>
                        {memory.imported.external && <StatusWord tone="warn">{COPY.external}</StatusWord>}
                        <time dateTime={memory.createdAt}>{relativeTime(memory.createdAt)}</time>
                      </span>
                    ) : (
                      <time dateTime={memory.updatedAt}>{relativeTime(memory.updatedAt)}</time>
                    )}
                    {memory.owned && <span>{COPY.markedMine}</span>}
                    {material && <span>{COPY.asReference}</span>}
                  </span>
                  {material && (
                    <div>
                      <Button
                        variant="ghost"
                        disabled={locked}
                        onClick={() => {
                          void writes.run(`memory:${memory.id}:own`, `${base}/${memory.id}/own`, 'POST', { baseRevision: memory.revision })
                        }}>
                        {COPY.markMine}
                      </Button>
                    </div>
                  )}
                  {state && 'kind' in state && <WriteNotice state={state} onRetry={() => void writes.retry()} onReload={onReload} />}
                </div>
                {edited && (
                  <IconButton
                    size="sm"
                    label={COPY.undoEdit}
                    icon={UndoGlyph}
                    disabled={locked}
                    onClick={() => {
                      undo(memory.id, memory.revision)
                    }}
                  />
                )}
                <IconButton
                  size="sm"
                  label={COPY.edit}
                  icon={EditGlyph}
                  disabled={locked}
                  onClick={() => {
                    writes.clear()
                    setEditing({ id: memory.id, text: memory.content })
                  }}
                />
                <IconButton
                  size="sm"
                  label={COPY.delete}
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
        <ul className="agent-memory-list agent-memory-deleted" aria-label={COPY.deleted}>
          {deleted.map(change => {
            const state = writeFor(writes.state, `memory:${change.memoryId}:undo`)
            return (
              <li key={change.memoryId} className="agent-memory-row">
                <div className="agent-memory-text">
                  <p>
                    <VisibleText text={change.previous.content} />
                  </p>
                  <span className="agent-memory-meta">
                    {COPY.deletedAt} <time dateTime={change.at}>{relativeTime(change.at)}</time>
                    <Hint label={COPY.sevenDays}>{COPY.undoWindow}</Hint>
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
                  {COPY.undo}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={locked}
                  loading={state !== null && 'phase' in state && state.phase === 'saving' && state.write.method === 'DELETE'}
                  onClick={() => {
                    setClearing({ memoryId: change.memoryId, baseRevision: change.previous.revision })
                  }}>
                  {COPY.clear}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {clearing && (
        <ConfirmDialog
          title={COPY.confirmClear}
          danger
          confirmLabel={COPY.clear}
          message={COPY.permanent}
          onClose={() => {
            setClearing(null)
          }}
          onConfirm={async () => {
            const { memoryId, baseRevision } = clearing
            const done = await writes.run(`memory:${memoryId}:undo`, `${base}/${memoryId}/undo`, 'DELETE', { baseRevision })
            if (done === undefined) throw new MessageError(COPY.clearFailed)
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={COPY.confirmDelete}
          danger
          confirmLabel={COPY.delete}
          message={COPY.deleteDetail}
          onClose={() => {
            setDeleting(null)
          }}
          onConfirm={async () => {
            const done = await writes.run(`memory:${deleting.id}`, `${base}/${deleting.id}`, 'DELETE', {})
            if (done === undefined) throw new MessageError(COPY.deleteFailed)
          }}
        />
      )}
    </div>
  )
}
