import { useState } from 'react'
import {
  readsProjectFiles,
  splitChangeNote,
  type AttachmentRef,
  type FileMention,
  type Message,
  type RewindBlock,
  type RewindPreview,
  type RewindReceipt,
} from '@latch/protocol'
import { Button, Checkbox, InlineNotice, Modal, ModalHeader } from '@latch/ui'
import { api, errorMessage, newRequestId } from '../core/api.ts'
import { ownTextStart } from '../conversation.ts'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { MissedList } from '../panel/changes/ChangesPanel.tsx'
import { missedFiles, writtenWords } from '../panel/changes/model.ts'

/** What 从这里编辑 puts back in the composer: the person's own words, without a note Latch added, and what went with them. */
export interface EditDraft {
  text: string
  refs: FileMention[]
  attachments: AttachmentRef[]
}

export function editDraft(message: Message): EditDraft {
  const text = splitChangeNote(message.text.slice(ownTextStart(message))).text
  return {
    // A reference at the very end would read as one being typed and open the file search; the Host trimmed its space.
    text: message.fileRefs?.length && /@\S+$/u.test(text) ? `${text} ` : text,
    refs: [...(message.fileRefs ?? [])],
    attachments: [...(message.attachments ?? [])],
  }
}

/** Why the files cannot go back with the edit, said where the choice would be. */
const BLOCKED: Partial<Record<RewindBlock, string>> = {
  'changed-since': '之后又改过这些文件',
  'not-retained': '这些文件的内容没有留存或可能含密钥',
  partial: '有的轮次记录不完整',
  'not-settled': '有的轮次还没有记录完',
}

interface Asked {
  message: Message
  before: string | undefined
  preview: RewindPreview
}

/**
 * 从这里编辑: the person's message back in the composer, in a new session that goes on from before it (the source stays as
 * it is). Where that message's turns changed files, a dialog first offers to put the files back to before it, by the
 * changes record's own rules; with nothing to choose, it goes straight to the composer.
 */
export function useEditFrom({
  sessionId,
  agentMode,
  changes,
  dataScope,
  phone,
  held,
  onEdit,
  onToast,
}: {
  phone: boolean
  /** Why no edit may start now (this device's unconfirmed message holds the composer); asked before anything is written. */
  held?: () => string | undefined
  sessionId: string | undefined
  agentMode: boolean
  /** The Host keeps change records (`catalog.features.changes`). */
  changes: boolean
  dataScope: Parameters<typeof readsProjectFiles>[0]
  onEdit: (message: Message, before: string | undefined, draft: EditDraft) => void
  onToast: (text: string, tone?: 'ok' | 'error') => void
}) {
  const [asked, setAsked] = useState<Asked | null>(null)
  const go = (message: Message, before: string | undefined) => {
    const draft = editDraft(message)
    // A device that may not read project files cannot send references to them: they stay out, and it says so.
    if (draft.refs.length && !readsProjectFiles(dataScope)) {
      draft.refs = []
      onToast('文件引用没有带上：这台设备的数据范围不包括会话文件夹')
    }
    onEdit(message, before, draft)
  }
  const start = async (message: Message, before: string | undefined) => {
    const reason = held?.()
    if (reason) {
      onToast(reason, 'error')
      return
    }
    if (!sessionId || !changes || !agentMode || !message.turnId || !readsProjectFiles(dataScope)) {
      go(message, before)
      return
    }
    let preview: RewindPreview | undefined
    try {
      preview = await api<RewindPreview>(`tasks/${encodeURIComponent(sessionId)}/changes/rewind/preview`, {
        method: 'POST',
        body: { messageId: message.id },
      })
    } catch {
      preview = undefined
    }
    if (preview && (preview.available || BLOCKED[preview.reason])) setAsked({ message, before, preview })
    else go(message, before)
  }
  const dialog = asked && sessionId && (
    <EditFromDialog
      sessionId={sessionId}
      asked={asked}
      phone={phone}
      onClose={() => setAsked(null)}
      onEdit={receipt => {
        setAsked(null)
        if (receipt) {
          const done = writtenWords(receipt.restored, receipt.removed).replace(/。$/u, '')
          onToast(`已退回文件：${done}`, 'ok')
        }
        go(asked.message, asked.before)
      }}
    />
  )
  return { start, dialog }
}

function EditFromDialog({
  sessionId,
  asked,
  phone,
  onClose,
  onEdit,
}: {
  sessionId: string
  asked: Asked
  phone: boolean
  onClose: () => void
  onEdit: (receipt?: RewindReceipt) => void
}) {
  const { preview } = asked
  const [rewind, setRewind] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // One request per confirmation: a retry after a lost answer gets the Host's first receipt.
  const [requestId] = useState(newRequestId)
  const missed = preview.available ? missedFiles(preview.notRestored, preview.notCovered, preview.skipped) : undefined
  const confirm = async () => {
    if (!rewind || !preview.available) {
      onEdit()
      return
    }
    setBusy(true)
    setError('')
    try {
      const receipt = await api<RewindReceipt>(`tasks/${encodeURIComponent(sessionId)}/changes/rewind`, {
        method: 'POST',
        body: { messageId: asked.message.id, requestId, confirm: preview.planHash },
      })
      onEdit(receipt)
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }
  const close = () => {
    if (!busy) onClose()
  }
  return (
    <Modal label="从这里编辑" variant={phone ? 'sheet' : 'dialog'} dismissible={!busy} onClose={close} className="confirm-dialog edit-from">
      <ModalHeader title="从这里编辑" onClose={close} />
      <div className="ui-modal-body edit-from-body">
        {preview.available ? (
          <Checkbox
            checked={rewind}
            disabled={busy}
            onChange={event => setRewind(event.target.checked)}
            label="同时把文件退回到这一条之前"
            description={writtenWords(preview.restore, preview.remove)}
          />
        ) : (
          <Checkbox checked={false} disabled label="同时把文件退回到这一条之前" description={BLOCKED[preview.reason]} />
        )}
        {preview.available && rewind && (
          <div className="changes-discard">
            <p>这些文件里之后的改动会被覆盖，未提交的内容找不回来。</p>
            {preview.files.length > 0 && (
              <div className="changes-missed">
                {preview.files.map(file => (
                  <div className="changes-missed-row" key={`${file.root}\n${file.path}`}>
                    <code title={escapeHiddenCharacters(file.path)}>
                      <VisibleText text={file.path} />
                    </code>
                    <span>{file.remove ? '删除' : '写回'}</span>
                  </div>
                ))}
              </div>
            )}
            {missed && (missed.files.length > 0 || missed.more > 0) && (
              <>
                <p className="changes-receipt-key">不会改动</p>
                <MissedList files={missed.files} />
                {missed.more > 0 && <p className="changes-receipt-key">另有 {missed.more} 个</p>}
              </>
            )}
          </div>
        )}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </div>
      <footer className="ui-modal-footer">
        <Button size="md" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          size="md"
          variant={rewind ? 'destroy' : 'primary'}
          disabled={busy}
          loading={busy}
          onClick={() => {
            void confirm()
          }}>
          {rewind ? '退回文件并编辑' : '编辑'}
        </Button>
      </footer>
    </Modal>
  )
}
