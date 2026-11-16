import { useEffect, useRef, useState } from 'react'
import {
  BOARD_TAG_LIMIT,
  normalizeBoardTags,
  promptTitle,
  WORK_ITEM_LIMITS,
  type BoardPriority,
  type WorkItem,
  type WorkItemAnswer,
  type WorkItemCreateInput,
  type WorkItemSummary,
} from '@latch/protocol'
import { CloseGlyph, Dialog, Icon, SegmentedControl, Switch } from '@latch/ui'
import { api, newRequestId, type PendingSubmission } from '../core/api.ts'
import type { SendingMessage } from '../core/sendingMessage.ts'
import { unconfirmedReason } from '../core/sendingMessage.ts'
import { errorMessage } from '../core/api.ts'
import { servicePick, findHarness } from '../composerChoice.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { SessionComposer } from '../shell/SessionComposers.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { PRIORITY_LABELS } from './model.ts'

/** What 新建 does: start a session (or, 先不开始, keep a 待办), or start one from a 待办 that has none yet (开始). */
export type NewMode = { kind: 'new' } | { kind: 'start'; item: WorkItemSummary }

/** A 待办's title: the session-title rule on its prompt, cut to the Host's length. */
export const itemTitle = (prompt: string): string => Array.from(promptTitle(prompt)).slice(0, WORK_ITEM_LIMITS.titleChars).join('')

/** The request a 先不开始 sent, kept until the Host answers it for certain: a retry sends it as it was. */
interface HeldCreate {
  body: WorkItemCreateInput
  state: 'sending' | 'unknown'
  reason: string
}

function TagInput({ tags, onTags, disabled }: { tags: string[]; onTags: (tags: string[]) => void; disabled: boolean }) {
  const [draft, setDraft] = useState('')
  const [bad, setBad] = useState(false)
  const add = () => {
    const parts = draft.split(/[,，]/u).filter(part => part.trim())
    if (!parts.length) return
    const next = normalizeBoardTags([...tags, ...parts])
    if ('problem' in next) {
      setBad(true)
      return
    }
    onTags(next.tags)
    setDraft('')
    setBad(false)
  }
  return (
    <div className="work-board-new-tags" data-invalid={bad ? '' : undefined}>
      {tags.map(tag => (
        <span key={tag} className="work-board-tag" data-editable="">
          <VisibleText text={tag} />
          <button
            type="button"
            className="work-board-tag-remove"
            aria-label={`移除 ${tag}`}
            disabled={disabled}
            onClick={() => {
              onTags(tags.filter(item => item !== tag))
            }}>
            <Icon icon={CloseGlyph} size={12} />
          </button>
        </span>
      ))}
      {tags.length < BOARD_TAG_LIMIT && (
        <input
          className="work-board-new-tag-field"
          aria-label="标签"
          aria-invalid={bad || undefined}
          placeholder="标签"
          value={draft}
          disabled={disabled}
          autoComplete="off"
          enterKeyHint="done"
          onChange={event => {
            setDraft(event.target.value)
            setBad(false)
          }}
          onBlur={add}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.stopPropagation()
              add()
            }
          }}
        />
      )}
    </div>
  )
}

/**
 * 新建: the home's own input (text, project, folder or worktree, Harness, model, thinking, permission) in a dialog, a
 * bottom sheet on phones, with the same new-session draft as the 对话 start screen. Once the Host takes the start the
 * dialog closes and the board stays; the new card is marked. A start whose result is unknown keeps the dialog open
 * with the input's own retry and abandon.
 *
 * 先不开始 keeps it as a 待办 instead (`POST /work/items`): the text is its prompt, its first line its title, the project,
 * Harness, model and a new worktree its suggestions, with a priority and tags. 开始 on a 待办 opens the same input with
 * its prompt and suggestions, and sends through `POST /work/items/:id/start`.
 */
export function WorkBoardNew({
  shell,
  open,
  mode,
  since,
  onClose,
  onStarted,
  onKept,
}: {
  shell: ShellState
  open: boolean
  mode: NewMode
  /** What was being sent when the dialog opened: only a start sent after it closes the dialog. */
  since: SendingMessage | null
  onClose: () => void
  onStarted: (sessionId: string) => void
  /** A 待办 kept for later: its card is marked. */
  onKept: (itemId: string) => void
}) {
  const { submission } = shell
  const { setStay, sendingMessage } = submission
  // The input sends a new session only while 对话 stands on its start screen; anything that moves it away closes this.
  const ready = shell.inputTarget === 'new'
  const starting = mode.kind === 'start' ? mode.item : undefined
  const [later, setLater] = useState(false)
  const [priority, setPriority] = useState<BoardPriority | 'mid'>('mid')
  const [tags, setTags] = useState<string[]>([])
  const [held, setHeld] = useState<HeldCreate | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || ready) return undefined
    const frame = requestAnimationFrame(() => {
      onClose()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [open, ready, onClose])
  useEffect(() => {
    if (!open) return undefined
    setStay(true)
    return () => {
      setStay(false)
    }
  }, [open, setStay])
  // Each time the dialog opens it starts plain: a session, 中, no tags.
  useEffect(() => {
    if (!open) return
    setLater(false)
    setPriority('mid')
    setTags([])
    setError('')
  }, [open])
  const prefilled = usePrefill(shell, open && ready ? starting : undefined)
  useEffect(() => {
    if (!open || !sendingMessage || sendingMessage === since) return
    if (sendingMessage.state !== 'accepted' || sendingMessage.submission.sessionId !== undefined || !sendingMessage.sessionId) return
    onStarted(sendingMessage.sessionId)
    onClose()
  }, [open, since, sendingMessage, onStarted, onClose])

  const sendCreate = async (body: WorkItemCreateInput) => {
    setHeld({ body, state: 'sending', reason: '' })
    setError('')
    try {
      const answer = await api<WorkItemAnswer>('work/items', { method: 'POST', body })
      setHeld(null)
      shell.setSubmissionDraft('')
      submission.setWorktree(undefined)
      await shell.refresh()
      onKept(answer.item.id)
      onClose()
    } catch (cause) {
      const reason = unconfirmedReason(cause)
      if (reason !== null) setHeld({ body, state: 'unknown', reason })
      else {
        setHeld(null)
        setError(errorMessage(cause))
      }
    }
  }
  const keep = async () => {
    if (held) return
    const prompt = submission.draft.trim()
    if (!prompt) return
    if (shell.attachmentDraft.items.length > 0 || shell.mentionChoice.refs.length > 0) {
      setError('待办不带附件和文件引用')
      return
    }
    const { choice } = submission
    const harness = findHarness(shell.catalog, choice.harnessId)
    const model = servicePick(shell.catalog, harness, choice.config) ?? choice.model
    await sendCreate({
      requestId: newRequestId(),
      title: itemTitle(prompt),
      prompt,
      ...(choice.workspaceId ? { projectId: choice.workspaceId } : {}),
      ...(choice.harnessId ? { harnessId: choice.harnessId } : {}),
      ...(model ? { model } : {}),
      ...(submission.worktree ? { worktree: 'new' as const } : {}),
      ...(tags.length ? { tags } : {}),
      ...(priority !== 'mid' ? { priority } : {}),
    })
  }
  // Under 先不开始 the input's send keeps a 待办; its pending row and its retry are this request's.
  const keeping = later && !starting
  const pending: PendingSubmission | null = held ? { requestId: held.body.requestId, prompt: held.body.prompt ?? '' } : null
  const composerShell: ShellState =
    starting && !prefilled
      ? // 开始 sends only once the input holds the 待办's 要求 as the Host has it now.
        { ...shell, sendDraft: async () => {} }
      : keeping
        ? {
            ...shell,
            submission: {
              ...submission,
              pending: held?.state === 'unknown' ? pending : submission.pending,
              pendingReason: held?.state === 'unknown' ? held.reason : submission.pendingReason,
              sending: held?.state === 'sending' || submission.sending,
              error: error || submission.error,
            },
            sendDraft: keep,
            retryDraft: async () => {
              if (held?.state === 'unknown') await sendCreate(held.body)
            },
            abandonPending: async () => {
              if (held?.state !== 'unknown') return
              setHeld(null)
            },
          }
        : shell
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={starting ? '开始' : '新建'} className="work-board-new">
      {open && ready && (
        // The start screen's own wrapper: the composer lays its row out by this width, as it does there.
        <div className="workbench-home-composer">
          <SessionComposer shell={composerShell} home />
        </div>
      )}
      {open && ready && !starting && (
        <div className="work-board-new-item" data-later={later ? '' : undefined}>
          <label className="work-board-new-later">
            <Switch checked={later} onCheckedChange={setLater} label="先不开始" disabled={held !== null} />
            <span aria-hidden="true">先不开始</span>
          </label>
          <div className="work-board-new-marks" inert={!later || undefined}>
            <SegmentedControl
              label="优先级"
              value={priority}
              size="sm"
              disabled={!later || held !== null}
              options={(['high', 'mid', 'low'] as const).map(value => ({ value, label: PRIORITY_LABELS[value] }))}
              onValueChange={setPriority}
            />
            <TagInput tags={tags} onTags={setTags} disabled={!later || held !== null} />
          </div>
        </div>
      )}
    </Dialog>
  )
}

/**
 * 开始: the input takes the 待办's prompt and suggested project, Harness, model and worktree, read from the Host (the
 * snapshot does not carry prompts), and the start is bound to that revision. When the Host says the 待办 changed since
 * (409 `item-changed`), it is read again and the input shows the 要求 as it now is; the person sends again. What the
 * input held before, text and choices, comes back when the dialog closes. True once the input holds the 待办.
 */
function usePrefill(shell: ShellState, item: WorkItemSummary | undefined): boolean {
  const latest = useRef(shell)
  latest.current = shell
  const id = item?.id
  const [read, setRead] = useState<{ id: string; revision: number } | null>(null)
  const changed = shell.submission.errorCode === 'item-changed'
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (changed) setRound(value => value + 1)
  }, [changed])
  // What the input held before: put back once the dialog closes.
  useEffect(() => {
    if (!id) return undefined
    const { submission } = latest.current
    const before = {
      draft: submission.draft,
      worktree: submission.worktree,
      choice: {
        workspaceId: submission.choice.workspaceId,
        harnessId: submission.choice.harnessId,
        model: submission.choice.model,
        config: submission.choice.config,
      },
    }
    return () => {
      setRead(null)
      const now = latest.current
      now.submission.setItem(null)
      // A start that is still unconfirmed keeps its text: the input's pending row owns it.
      if (now.submission.pending?.itemId === id) return
      now.setSubmissionDraft(before.draft)
      now.submission.updateChoice(before.choice)
      now.submission.setWorktree(before.worktree)
    }
  }, [id])
  useEffect(() => {
    if (!id) return undefined
    let live = true
    setRead(null)
    latest.current.submission.setItem(null)
    void api<{ item: WorkItem }>(`work/items/${encodeURIComponent(id)}`)
      .then(({ item: full }) => {
        if (!live) return
        const now = latest.current
        now.submission.updateChoice({
          ...(full.projectId ? { workspaceId: full.projectId } : {}),
          ...(full.harnessId ? { harnessId: full.harnessId } : {}),
          ...(full.model ? { model: full.model } : {}),
        })
        now.setSubmissionDraft(full.prompt)
        now.submission.setItem({ id: full.id, revision: full.revision })
        setRead({ id: full.id, revision: full.revision })
        requestAnimationFrame(() => {
          if (live) latest.current.submission.setWorktree(full.worktree === 'new' ? { from: 'head' } : undefined)
        })
      })
      .catch((cause: unknown) => {
        if (live) latest.current.submission.setError(errorMessage(cause))
      })
    return () => {
      live = false
    }
  }, [id, round])
  return read !== null && read.id === id
}
