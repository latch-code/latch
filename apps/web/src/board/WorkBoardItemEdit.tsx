import { useEffect, useState } from 'react'
import { WORK_ITEM_LIMITS, type WorkItem, type WorkItemSummary } from '@latch/protocol'
import { Button, InlineNotice, Loading, Modal, ModalHeader, TextAreaField, TextField } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import type { ItemWrites } from './itemWrites.ts'

const chars = (text: string) => Array.from(text).length
const COPY = defineCopy(
  { notSaved: '没有保存', edit: '编辑待办', loading: '读取中', title: '标题', prompt: '要求', cancel: '取消', save: '保存' },
  {
    notSaved: 'Changes weren’t saved',
    edit: 'Edit task',
    loading: 'Loading',
    title: 'Title',
    prompt: 'Instructions',
    cancel: 'Cancel',
    save: 'Save',
  },
)

/**
 * 编辑 a 待办 that has not started: its title and prompt, read from the Host (the snapshot has no prompts). Saved with
 * the revision it was read at; a 待办 changed meanwhile is refused and shown as it now is.
 */
export function WorkBoardItemEdit({
  item,
  writes,
  phone,
  onClose,
}: {
  item: WorkItemSummary
  writes: ItemWrites
  phone: boolean
  onClose: () => void
}) {
  const [read, setRead] = useState<WorkItem | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api<{ item: WorkItem }>(`work/items/${encodeURIComponent(item.id)}`)
      .then(({ item: full }) => {
        if (!live) return
        setRead(full)
        setTitle(full.title)
        setPrompt(full.prompt)
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause))
      })
    return () => {
      live = false
    }
  }, [item.id])
  const titleLong = chars(title.trim()) > WORK_ITEM_LIMITS.titleChars
  const promptLong = prompt.length > WORK_ITEM_LIMITS.promptChars
  const changed = read !== null && (title.trim() !== read.title || prompt.trim() !== read.prompt)
  const save = async () => {
    if (!read || busy || !changed || !title.trim() || titleLong || promptLong) return
    setBusy(true)
    setError('')
    const result = await writes.patch(read, {
      ...(title.trim() !== read.title ? { title: title.trim() } : {}),
      ...(prompt.trim() !== read.prompt ? { prompt: prompt.trim() } : {}),
    })
    // An unknown result stays on the card with its 重试 and 放弃.
    if (result.ok || (!result.ok && result.unknown)) onClose()
    else {
      // A refusal is said here, not on the card.
      if (!result.blocked) writes.dismiss(read.id)
      setError(result.reason ?? COPY.notSaved)
      setBusy(false)
    }
  }
  const close = () => {
    if (!busy) onClose()
  }
  return (
    <Modal label={COPY.edit} variant={phone ? 'sheet' : 'dialog'} dismissible={!busy} onClose={close} className="work-board-item-edit">
      <form
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}>
        <ModalHeader title={COPY.edit} onClose={close} />
        <div className="ui-modal-body">
          {read === null && !error ? (
            <Loading label={COPY.loading} />
          ) : (
            <>
              <TextField
                label={COPY.title}
                value={title}
                disabled={busy || read === null}
                autoComplete="off"
                error={titleLong ? `${formatNumber(chars(title.trim()))} / ${formatNumber(WORK_ITEM_LIMITS.titleChars)}` : undefined}
                onChange={event => {
                  setTitle(event.target.value.replace(/\n/gu, ' '))
                }}
              />
              <TextAreaField
                label={COPY.prompt}
                value={prompt}
                rows={8}
                disabled={busy || read === null}
                error={promptLong ? `${formatNumber(prompt.length)} / ${formatNumber(WORK_ITEM_LIMITS.promptChars)}` : undefined}
                onChange={event => {
                  setPrompt(event.target.value)
                }}
              />
            </>
          )}
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
        </div>
        <footer className="ui-modal-footer">
          <Button size="md" disabled={busy} onClick={close}>
            {COPY.cancel}
          </Button>
          <Button
            size="md"
            variant="primary"
            type="submit"
            disabled={busy || !changed || !title.trim() || titleLong || promptLong}
            loading={busy}>
            {COPY.save}
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
