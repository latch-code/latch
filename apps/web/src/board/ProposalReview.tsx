import { useEffect, useRef, useState } from 'react'
import {
  escapeSecurityText,
  WORK_ITEM_LIMITS,
  type WorkProposal,
  type WorkProposalAnswer,
  type WorkProposalEntryEdit,
} from '@latch/protocol'
import { Button, Checkbox, InlineNotice, Loading, Modal, ModalHeader, TextAreaField, TextField } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import type { TodoProposal, ProposalWrites } from './proposals.ts'
import { ExternalMark, ProposedBy } from './WorkBoardProposalCard.tsx'
import { TagChips } from './WorkBoardCard.tsx'
import { ItemWriteLine } from './WriteLine.tsx'

const chars = (text: string) => Array.from(text).length

export function AcceptedItems({ ids, shell, onClose }: { ids: readonly string[]; shell: ShellState; onClose: () => void }) {
  const visible = ids.flatMap(id => {
    const item = shell.snapshot.items?.find(row => row.id === id)
    return item ? [item] : []
  })
  return (
    <Modal label="已收下的待办" variant={shell.phone ? 'sheet' : 'dialog'} onClose={onClose} className="work-board-proposal-review">
      <ModalHeader title="已收下的待办" onClose={onClose} />
      <div className="ui-modal-body item-accepted-links">
        {visible.map(item => (
          <Button
            key={item.id}
            variant="outline"
            onClick={() => {
              shell.openWorkItem(item.id)
              onClose()
            }}>
            {escapeSecurityText(item.title)}
          </Button>
        ))}
      </div>
    </Modal>
  )
}

interface Draft {
  index: number
  chosen: boolean
  title: string
  prompt: string
  read: { title: string; prompt: string }
}

/**
 * 审阅 an agent's proposal of 待办: each pending one with its full 要求, read from the Host at the revision the card
 * showed, to edit, pick and accept (they become unstarted 待办; nothing starts), or to dismiss. Accepting names that
 * revision, so what the person read is what is kept.
 */
export function ProposalReview({
  proposal,
  writes,
  shell,
  onClose,
}: {
  proposal: TodoProposal
  writes: ProposalWrites
  shell: ShellState
  onClose: () => void
}) {
  const [read, setRead] = useState<WorkProposal | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState<string[]>([])
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const write = writes.states.get(proposal.id)
  const unknown = write?.state === 'unknown'
  useEffect(() => {
    let live = true
    api<WorkProposalAnswer>(`work/proposals/${encodeURIComponent(proposal.id)}`)
      .then(({ proposal: full }) => {
        if (!live) return
        setRead(full)
        setDrafts(
          (full.entries ?? [])
            .filter(entry => entry.state === 'pending')
            .map(entry => ({
              index: entry.index,
              chosen: true,
              title: entry.title,
              prompt: entry.prompt,
              read: { title: entry.title, prompt: entry.prompt },
            })),
        )
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause))
      })
    return () => {
      live = false
    }
  }, [proposal.id, proposal.revision])
  const chosen = drafts.filter(draft => draft.chosen)
  const invalid = chosen.some(
    draft =>
      !draft.title.trim() || chars(draft.title.trim()) > WORK_ITEM_LIMITS.titleChars || draft.prompt.length > WORK_ITEM_LIMITS.promptChars,
  )
  const edit = (index: number, change: Partial<Draft>) => {
    setDrafts(previous => previous.map(draft => (draft.index === index ? { ...draft, ...change } : draft)))
  }
  const finish = async (action: 'accept' | 'dismiss') => {
    if (!read || busy || unknown) return
    setBusy(true)
    setError('')
    const result =
      action === 'accept'
        ? await writes.accept(
            read,
            chosen.map(draft => {
              const entry: WorkProposalEntryEdit = { index: draft.index }
              if (draft.title.trim() !== draft.read.title) entry.title = draft.title.trim()
              if (draft.prompt.trim() !== draft.read.prompt) entry.prompt = draft.prompt.trim()
              return entry
            }),
          )
        : await writes.dismiss(read)
    if (!mounted.current) return
    if (result.ok) {
      showAccepted(result.itemIds)
    } else if (!result.unknown) {
      writes.forget(read.id)
      setError(result.reason ?? '没有保存')
    }
    setBusy(false)
  }
  const showAccepted = (ids: string[] | undefined) => {
    if (ids && ids.length > 1) {
      setAccepted(ids)
      return
    }
    if (ids?.[0]) shell.openWorkItem(ids[0])
    onClose()
  }
  const retry = async () => {
    setBusy(true)
    const result = await writes.retry(proposal.id)
    if (!mounted.current) return
    setBusy(false)
    if (result.ok) showAccepted(result.itemIds)
  }
  const close = () => {
    if (!busy) onClose()
  }
  const group = read?.goal !== undefined
  const heading = group ? escapeSecurityText(read.goal!) : '提议的待办'
  if (accepted.length) return <AcceptedItems ids={accepted} shell={shell} onClose={close} />
  return (
    <Modal
      label="审阅提议"
      variant={shell.phone ? 'sheet' : 'dialog'}
      dismissible={!busy}
      onClose={close}
      className="work-board-proposal-review">
      <form
        onSubmit={event => {
          event.preventDefault()
          void finish('accept')
        }}>
        <ModalHeader title={heading} onClose={close} />
        <div className="ui-modal-body">
          <div className="work-board-proposal-line">
            <span className="work-board-proposal-word">提议自</span>
            <ProposedBy proposal={proposal} shell={shell} />
            {proposal.external && <ExternalMark />}
          </div>
          {read === null && !error ? (
            <Loading label="读取中" />
          ) : (
            drafts.map(draft => {
              const entry = read?.entries?.find(item => item.index === draft.index)
              const titleLong = chars(draft.title.trim()) > WORK_ITEM_LIMITS.titleChars
              const promptLong = draft.prompt.length > WORK_ITEM_LIMITS.promptChars
              const project = entry?.projectId
                ? (shell.catalog?.workspaces.find(item => item.id === entry.projectId)?.name
                  ?? (entry.projectId === 'default' ? '无项目' : entry.projectId))
                : undefined
              const harness = entry?.harnessId
                ? (shell.catalog?.harnesses.find(item => item.id === entry.harnessId)?.capabilities.display.label ?? entry.harnessId)
                : undefined
              return (
                <section key={draft.index} className="work-board-proposal-entry" data-off={draft.chosen ? undefined : ''}>
                  {drafts.length > 1 && (
                    <Checkbox
                      label={`收下第 ${draft.index + 1} 条`}
                      checked={draft.chosen}
                      disabled={busy || unknown}
                      onChange={() => {
                        edit(draft.index, { chosen: !draft.chosen })
                      }}
                    />
                  )}
                  <TextField
                    label="标题"
                    value={draft.title}
                    disabled={busy || unknown || !draft.chosen}
                    autoComplete="off"
                    error={titleLong ? `${chars(draft.title.trim())} / ${WORK_ITEM_LIMITS.titleChars}` : undefined}
                    onChange={event => {
                      edit(draft.index, { title: event.target.value.replace(/\n/gu, ' ') })
                    }}
                  />
                  <TextAreaField
                    label="要求"
                    value={draft.prompt}
                    rows={drafts.length > 1 ? 5 : 8}
                    disabled={busy || unknown || !draft.chosen}
                    error={promptLong ? `${draft.prompt.length} / ${WORK_ITEM_LIMITS.promptChars}` : undefined}
                    onChange={event => {
                      edit(draft.index, { prompt: event.target.value })
                    }}
                  />
                  {(project || harness || entry?.tags?.length) && (
                    <span className="work-board-proposal-facts">
                      {project && <span>{escapeSecurityText(project)}</span>}
                      {harness && <span>{escapeSecurityText(harness)}</span>}
                      <TagChips tags={entry?.tags} />
                    </span>
                  )}
                </section>
              )
            })
          )}
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          {unknown && <ItemWriteLine state={write} onRetry={() => void retry()} onDismiss={() => writes.forget(proposal.id)} />}
        </div>
        <footer className="ui-modal-footer">
          <Button
            size="md"
            variant="ghost"
            disabled={busy || unknown || read === null}
            onClick={() => {
              void finish('dismiss')
            }}>
            {drafts.length > 1 ? '全部不要' : '不要'}
          </Button>
          <Button
            size="md"
            variant="primary"
            type="submit"
            disabled={busy || unknown || read === null || !chosen.length || invalid}
            loading={busy}>
            {drafts.length > 1 ? `接受 ${chosen.length} 条` : '接受'}
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
