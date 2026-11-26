import { useLayoutEffect, useRef, useState } from 'react'
import type { AttachmentSelection, QueuedPromptContent } from '@latch/protocol'
import { Button, InlineNotice } from '@latch/ui'
import { api, inlineError, isUncertain } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { useAttachments } from '../hooks/useAttachments.ts'
import type { SendKey } from '../preferences.ts'
import { escapeIsLeftover } from '../escapeGrace.ts'
import { AttachmentButton, AttachmentDrafts, dropAttachments, pasteAttachments } from './AttachmentDrafts.tsx'
import { PromptEditor, type PromptInput } from './PromptEditor.tsx'
import { promptLengthError } from './promptLength.ts'

const COPY = defineCopy(
  {
    title: '正在编辑排队消息',
    message: '排队消息',
    cancel: '取消',
    save: '保存',
    unknown: '保存结果未确认，可重试同一次保存。',
    retry: '重试保存',
    close: '关闭',
    unavailable: '这条消息已无法编辑。',
  },
  {
    title: 'Editing queued message',
    message: 'Queued message',
    cancel: 'Cancel',
    save: 'Save',
    unknown: 'Save unconfirmed. You can retry the same change.',
    retry: 'Retry save',
    close: 'Close',
    unavailable: 'This message can no longer be edited.',
  },
)

export function QueueEditForm({
  sessionId,
  itemId,
  original,
  selection,
  allowAttachments,
  writable,
  online,
  sendKey,
  coarse,
  onClose,
  onChanged,
}: {
  sessionId: string
  itemId: string
  original: QueuedPromptContent
  selection: AttachmentSelection
  allowAttachments: boolean
  writable: boolean
  online: boolean
  sendKey: SendKey
  coarse: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const input = useRef<PromptInput>(null)
  const [text, setText] = useState(original.text)
  const [retained, setRetained] = useState(original.attachments)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState<{ text: string; contentRevision: number; attachmentIds: string[] }>()
  const locked = saving || !!retry
  const live = useRef(false)
  const writing = useRef(false)
  const uploads = useAttachments({
    enabled: allowAttachments && writable,
    sessionId,
    selection,
    locked,
    connectionReported: !online,
    retainedCount: retained.length,
  })
  const initialUploads = useRef(uploads.discard)
  useLayoutEffect(() => {
    const discard = initialUploads.current
    live.current = true
    input.current?.focus({ preventScroll: true })
    return () => {
      live.current = false
      if (!writing.current) discard()
    }
  }, [])
  const lengthError = promptLengthError(text)
  const changed = text.trim() !== original.text || retained.length !== original.attachments.length || uploads.items.length > 0
  const canSave = online && writable && changed && !lengthError && (!!text.trim() || retained.length + uploads.items.length > 0)
  const save = async () => {
    if (!canSave || writing.current) return
    writing.current = true
    setSaving(true)
    setError('')
    let body = retry
    try {
      if (!body) {
        const added = await uploads.wait()
        if (!added || !live.current) return
        body = { text: text.trim(), attachmentIds: [...retained.map(ref => ref.id), ...added], contentRevision: original.contentRevision }
      }
      await api(`tasks/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`, {
        method: 'PATCH',
        body,
      })
      uploads.clear()
      if (live.current) onClose()
      await onChanged()
    } catch (cause) {
      if (live.current) {
        setRetry(isUncertain(cause) ? body : undefined)
        setError(inlineError(cause))
      }
    } finally {
      writing.current = false
      if (live.current) setSaving(false)
    }
  }
  return (
    <form
      className="composer"
      aria-label={COPY.title}
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
      onDragOver={event => {
        if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
      }}
      onDrop={event => dropAttachments(event, uploads)}>
      <div className="run-bar">{COPY.title}</div>
      {!writable && <InlineNotice>{COPY.unavailable}</InlineNotice>}
      {retry ? <InlineNotice tone="warn">{COPY.unknown}</InlineNotice> : error && <InlineNotice tone="error">{error}</InlineNotice>}
      {lengthError && <InlineNotice>{lengthError}</InlineNotice>}
      <AttachmentDrafts
        controller={uploads}
        locked={locked}
        queued={{ sessionId, refs: retained, remove: id => setRetained(previous => previous.filter(ref => ref.id !== id)) }}
        onRestore={value => {
          const restored = input.current?.insertText(value) ?? false
          if (restored) requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
          return restored
        }}
      />
      <div className="composer-input">
        <PromptEditor
          inputRef={input}
          value={text}
          onChange={value => setText(value)}
          catalogue={{}}
          attributes={{ label: COPY.message }}
          placeholder={COPY.message}
          disabled={locked}
          onKeyDown={event => {
            if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return false
            if (event.key === 'Escape' && !escapeIsLeftover(event)) {
              if (!writing.current) onClose()
              event.stopPropagation()
              return true
            }
            if (event.key !== 'Enter' || event.altKey || event.shiftKey || (event.ctrlKey && event.metaKey)) return false
            if (!(event.metaKey || event.ctrlKey) && (coarse || sendKey !== 'enter')) return false
            if (!event.repeat) void save()
            return true
          }}
          onPaste={event => {
            if (allowAttachments) pasteAttachments(event, uploads)
            return event.defaultPrevented
          }}
        />
      </div>
      <div className="composer-toolbar">
        <div className="composer-controls">
          {allowAttachments && <AttachmentButton controller={uploads} disabled={locked || !writable || !online} />}
        </div>
        <div className="composer-end">
          <Button size="sm" variant="ghost" disabled={saving} onClick={onClose}>
            {retry ? COPY.close : COPY.cancel}
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!canSave} loading={saving}>
            {retry ? COPY.retry : COPY.save}
          </Button>
        </div>
      </div>
    </form>
  )
}
