import { useEffect, useState } from 'react'
import { WORK_ITEM_LIMITS, type WorkItem, type WorkItemSummary } from '@latch/protocol'
import { Button, InlineNotice, Loading, Modal, ModalHeader, TextAreaField, TextField } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import type { ItemWrites } from './itemWrites.ts'

const chars = (text: string) => Array.from(text).length

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
      writes.dismiss(read.id)
      setError(result.reason ?? '没有保存')
      setBusy(false)
    }
  }
  const close = () => {
    if (!busy) onClose()
  }
  return (
    <Modal label="编辑待办" variant={phone ? 'sheet' : 'dialog'} dismissible={!busy} onClose={close} className="work-board-item-edit">
      <form
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}>
        <ModalHeader title="编辑待办" onClose={close} />
        <div className="ui-modal-body">
          {read === null && !error ? (
            <Loading label="读取中" />
          ) : (
            <>
              <TextField
                label="标题"
                value={title}
                disabled={busy || read === null}
                autoComplete="off"
                error={titleLong ? `${chars(title.trim())} / ${WORK_ITEM_LIMITS.titleChars}` : undefined}
                onChange={event => {
                  setTitle(event.target.value.replace(/\n/gu, ' '))
                }}
              />
              <TextAreaField
                label="要求"
                value={prompt}
                rows={8}
                disabled={busy || read === null}
                error={promptLong ? `${prompt.length} / ${WORK_ITEM_LIMITS.promptChars}` : undefined}
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
            取消
          </Button>
          <Button
            size="md"
            variant="primary"
            type="submit"
            disabled={busy || !changed || !title.trim() || titleLong || promptLong}
            loading={busy}>
            保存
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
