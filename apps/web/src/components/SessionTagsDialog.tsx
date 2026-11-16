import { useMemo, useRef, useState } from 'react'
import { BOARD_TAG_CHARS, BOARD_TAG_LIMIT, normalizeBoardTags, type BoardTagProblem, type TaskSummary } from '@latch/protocol'
import { Button, CloseGlyph, IconButton, InlineNotice, Modal, ModalHeader, PlusGlyph, TextField } from '@latch/ui'
import { VisibleText } from './VisibleText.tsx'

const PROBLEM_TEXT: Record<BoardTagProblem, string> = {
  'tag-invalid': `1–${BOARD_TAG_CHARS} 个字，不含换行`,
  'tag-secret': '像密钥',
  'tag-limit': `最多 ${BOARD_TAG_LIMIT} 个`,
}

/** Every tag the device's sessions carry, most used first: what the dialog offers to pick. */
export function knownTags(tasks: readonly Pick<TaskSummary, 'tags'>[]): string[] {
  const counts = new Map<string, number>()
  for (const task of tasks) for (const tag of task.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([tag]) => tag)
}

/**
 * 标签: the session's free tags as chips, a field that adds one on Enter, and the tags other sessions carry to pick.
 * The Host normalises again; this only refuses early what it would refuse. Tags are text and never trigger anything.
 * Shared by the session menu and the board's card menu.
 */
export function SessionTagsDialog({
  task,
  known,
  phone,
  onSave,
  onClose,
}: {
  task: Pick<TaskSummary, 'tags' | 'title'>
  /** `knownTags` of the sessions this device lists. */
  known: readonly string[]
  phone: boolean
  /** `null` removes them all. Rejects with the Host's words, which the dialog shows. */
  onSave: (tags: string[] | null) => Promise<void>
  onClose: () => void
}) {
  const [tags, setTags] = useState<string[]>(() => [...(task.tags ?? [])])
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<BoardTagProblem | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const full = tags.length >= BOARD_TAG_LIMIT
  const long = Array.from(draft.trim()).length > BOARD_TAG_CHARS
  const offered = useMemo(() => known.filter(tag => !tags.includes(tag)).slice(0, 12), [known, tags])
  const add = (text: string) => {
    if (!text.trim()) return
    const next = normalizeBoardTags([...tags, text])
    if ('problem' in next) {
      setProblem(next.problem)
      return
    }
    setTags(next.tags)
    setDraft('')
    setProblem(undefined)
    input.current?.focus()
  }
  const changed = draft.trim() !== '' || tags.length !== (task.tags?.length ?? 0) || tags.some((tag, index) => task.tags?.[index] !== tag)
  const save = async () => {
    if (busy) return
    // What is still in the field is saved with the rest.
    const next = draft.trim() ? normalizeBoardTags([...tags, draft]) : { tags }
    if ('problem' in next) {
      setProblem(next.problem)
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSave(next.tags.length ? next.tags : null)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。')
      setBusy(false)
    }
  }
  const close = () => {
    if (!busy) onClose()
  }
  return (
    <Modal label="标签" variant={phone ? 'sheet' : 'dialog'} dismissible={!busy} onClose={close} className="session-tags-dialog">
      <form
        onSubmit={event => {
          event.preventDefault()
          if (draft.trim()) add(draft)
          else if (changed) void save()
        }}>
        <ModalHeader title="标签" onClose={close} />
        <div className="ui-modal-body">
          {tags.length > 0 && (
            <ul className="session-tags" aria-label="已有标签">
              {tags.map(tag => (
                <li key={tag} className="session-tag">
                  <VisibleText text={tag} />
                  <IconButton
                    size="xs"
                    label={`移除 ${tag}`}
                    icon={CloseGlyph}
                    disabled={busy}
                    onClick={() => {
                      setTags(previous => previous.filter(item => item !== tag))
                      setProblem(undefined)
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          <TextField
            ref={input}
            label="新标签"
            value={draft}
            disabled={busy || full}
            autoComplete="off"
            enterKeyHint="done"
            placeholder={full ? `最多 ${BOARD_TAG_LIMIT} 个` : '例如：发布前'}
            error={long ? `${Array.from(draft.trim()).length} / ${BOARD_TAG_CHARS}` : problem ? PROBLEM_TEXT[problem] : undefined}
            onChange={event => {
              setDraft(event.target.value)
              setProblem(undefined)
            }}
          />
          {offered.length > 0 && !full && (
            <ul className="session-tags session-tags-known" aria-label="其他会话的标签">
              {offered.map(tag => (
                <li key={tag}>
                  <button
                    type="button"
                    className="session-tag session-tag-pick"
                    disabled={busy}
                    onClick={() => {
                      add(tag)
                    }}>
                    <PlusGlyph size={12} aria-hidden="true" />
                    <VisibleText text={tag} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
        </div>
        <footer className="ui-modal-footer">
          <Button size="md" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button
            size="md"
            variant="primary"
            disabled={busy || !changed}
            loading={busy}
            onClick={() => {
              void save()
            }}>
            保存
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
