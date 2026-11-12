import { useRef, useState } from 'react'

import type { Handoff, HandoffReturn } from '@latch/protocol'
import { Button, Checkbox, ICON_STROKE, IconButton, InlineNotice, StatusWord, TextAreaField, EnterGlyph, CloseGlyph } from '@latch/ui'
import { api, newRequestId } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import {
  awaitsReturn,
  defaultSummary,
  evidenceChoices,
  returnBody,
  scopeWords,
  sha256Hex,
  writeFailure,
  type EvidenceChoice,
  type WriteFailure,
} from './model.ts'
import { fileHash, type SessionHandoffs } from './useHandoffs.ts'

/**
 * The target side, above the composer: once a handoff that expects a result has started here and the turn has ended,
 * 交回结果 opens a small card. The summary starts as the last reply; evidence is ticked from this session's files and
 * messages where the agreed scope keeps it. A return without an answer keeps its request for 重试同一请求.
 */
export function TargetHandoffDock({ shell, handoffs }: { shell: ShellState; handoffs: SessionHandoffs }) {
  const { current, snapshot, access, connection, catalog } = shell
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<(WriteFailure & { named?: string[] }) | null>(null)
  const pending = useRef<{ id: string; body: HandoffReturn } | undefined>(undefined)
  const busy = useRef(false)
  if (!current || !catalog?.features?.handoffs) return null
  const here = current.summary.id
  const incoming = handoffs.handoffs
    .filter(item => item.targetSessionId === here)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (!incoming) return null
  const offline = connection === 'offline' || connection === 'reconnecting'
  const source = snapshot.tasks.find(task => task.id === incoming.sourceSessionId)
  const ready = awaitsReturn(incoming, current.summary)
  const choices = evidenceChoices(current.messages, snapshot.device.dataScope)
  const withEvidence = incoming.returnScope === 'summary-and-evidence'
  const canRun = access.scopes.has('run')

  if (incoming.status === 'returned')
    return (
      <p className="handoff-status-line handoff-quiet">
        <EnterGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <StatusWord tone="done">已交回</StatusWord>
        {source && (
          <Button size="xs" variant="ghost" onClick={() => shell.choose(source.id)}>
            打开「
            <VisibleText text={source.title || '未命名会话'} />」
          </Button>
        )}
      </p>
    )
  if (incoming.status !== 'started' || incoming.returnScope === 'none' || incoming.contentRemoved) return null

  const begin = () => {
    setSummary(defaultSummary(current.messages))
    setTicked(new Set())
    setFailure(null)
    setOpen(true)
  }
  const send = async (id: string, body: HandoffReturn) => {
    if (busy.current) return
    busy.current = true
    setSending(true)
    setFailure(null)
    pending.current = { id, body }
    try {
      const handoff = await api<Handoff>(`handoffs/${encodeURIComponent(id)}/return`, { method: 'POST', body, timeoutMs: 60_000 })
      pending.current = undefined
      handoffs.merge(handoff)
      setOpen(false)
    } catch (error) {
      const outcome = writeFailure(error)
      if (outcome.kind !== 'unknown') pending.current = undefined
      const chosen = choices.filter(choice => ticked.has(choice.key))
      setFailure({
        ...outcome,
        ...(outcome.kind === 'refused' && outcome.code === 'handoff-evidence-changed' && outcome.items
          ? { named: outcome.items.flatMap(index => (chosen[index] ? [chosen[index]!.label] : [])) }
          : {}),
      })
    } finally {
      busy.current = false
      setSending(false)
    }
  }
  const submit = async () => {
    if (!summary.trim() || sending) return
    const chosen = withEvidence ? choices.filter(choice => ticked.has(choice.key)) : []
    let hashed: Array<{ choice: EvidenceChoice; hash: string }>
    try {
      hashed = await Promise.all(
        chosen.map(async choice => ({
          choice,
          hash:
            choice.kind === 'file'
              ? await fileHash(here, choice.file)
              : await sha256Hex(current.messages.find(message => message.id === choice.messageId)?.text ?? ''),
        })),
      )
    } catch (cause) {
      setFailure({ kind: 'refused', message: cause instanceof Error ? cause.message : '读不到选中的证据' })
      return
    }
    await send(incoming.id, returnBody(newRequestId(), summary, incoming.returnScope, hashed))
  }
  const unknown = failure?.kind === 'unknown' && pending.current !== undefined

  return (
    <>
      {!open && (
        <div className="handoff-status" role="group" aria-label="交接">
          <div className="handoff-status-line">
            <EnterGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            <span className="handoff-status-title">交接 · 回传{scopeWords(incoming.returnScope)}</span>
            {ready ? <StatusWord tone="waiting">等你交回</StatusWord> : <StatusWord tone="running">这一轮结束后可交回</StatusWord>}
            <span className="handoff-spacer" />
            <Button size="xs" variant="primary" icon={EnterGlyph} disabled={!ready || !canRun || offline} onClick={begin}>
              交回结果
            </Button>
          </div>
        </div>
      )}
      {open && (
        <section className="handoff-card" role="group" aria-label="交回结果">
          <header className="handoff-card-head">
            <EnterGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <h3>交回结果</h3>
            <span className="handoff-muted">回传{scopeWords(incoming.returnScope)}</span>
            <span className="handoff-spacer" />
            <IconButton label="关闭" icon={CloseGlyph} size="xs" disabled={sending} onClick={() => setOpen(false)} />
          </header>
          <TextAreaField
            className="handoff-requirements"
            label="结论"
            rows={4}
            value={summary}
            maxLength={16_000}
            disabled={sending || unknown}
            onChange={event => {
              setSummary(event.target.value)
            }}
          />
          {withEvidence && (
            <fieldset className="handoff-evidence" disabled={sending || unknown}>
              <legend className="handoff-label">证据</legend>
              {choices.length === 0 && <span className="handoff-muted">这个会话里没有可选的文件或消息</span>}
              {choices.map(choice => (
                <Checkbox
                  key={choice.key}
                  label={<VisibleText text={choice.label} />}
                  checked={ticked.has(choice.key)}
                  onChange={event => {
                    const next = new Set(ticked)
                    if (event.target.checked) next.add(choice.key)
                    else next.delete(choice.key)
                    setTicked(next)
                  }}
                />
              ))}
            </fieldset>
          )}
          {failure?.kind === 'refused' && (
            <InlineNotice tone="error" title="没有交回">
              {failure.named?.length ? `${failure.named.map(name => `「${name}」`).join('')}已经变化了，请重新勾选` : failure.message}
            </InlineNotice>
          )}
          {failure?.kind === 'denied' && (
            <InlineNotice tone="error" title="没有交回">
              {failure.message}
            </InlineNotice>
          )}
          {unknown && (
            <InlineNotice tone="warn" title="交回结果未知">
              {failure.message}
            </InlineNotice>
          )}
          {offline && <p className="handoff-offline">Mac 不在线 · 恢复后再交回</p>}
          <footer className="handoff-card-foot">
            <span className="handoff-spacer" />
            {unknown ? (
              <Button
                variant="primary"
                disabled={sending || offline}
                pending={sending}
                onClick={() => {
                  const held = pending.current
                  if (held) void send(held.id, held.body)
                }}>
                重试同一请求
              </Button>
            ) : (
              <>
                <Button variant="ghost" disabled={sending} onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  disabled={!summary.trim() || offline || !canRun || sending}
                  pending={sending}
                  onClick={() => void submit()}>
                  {sending ? '正在交回…' : '交回'}
                </Button>
              </>
            )}
          </footer>
        </section>
      )}
    </>
  )
}
