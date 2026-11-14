import { useContext, useEffect, useRef, useState } from 'react'
import { Image } from 'lucide-react'
import { Button, Icon, FileGlyph } from '@latch/ui'
import { isFileMetadata, type AttachmentRef } from '@latch/protocol'
import { FileSession } from './FileChip.tsx'
import { FileOpenContext } from '../preview/fileContext.ts'
import { VisibleText } from './VisibleText.tsx'
import { api } from '../core/api.ts'

function MessageAttachment({ attachment }: { attachment: AttachmentRef }) {
  const session = useContext(FileSession),
    open = useContext(FileOpenContext)
  const anchor = useRef<HTMLButtonElement>(null)
  const key = `${session?.id ?? ''}\n${attachment.id}\n${attachment.sha256}`
  const [image, setImage] = useState<{ key: string; url: string }>(),
    [failed, setFailed] = useState('')
  useEffect(() => {
    if (attachment.kind !== 'image' || !session || !open || !anchor.current) return
    const controller = new AbortController()
    let started = false
    const load = () => {
      if (started || controller.signal.aborted) return
      started = true
      observer.disconnect()
      void api<{ file: unknown }>(`attachments/${encodeURIComponent(attachment.id)}/resolve`, {
        method: 'POST',
        signal: controller.signal,
      })
        .then(({ file }) => {
          if (controller.signal.aborted) return
          if (
            !isFileMetadata(file)
            || file.source !== 'attachment'
            || file.attachmentId !== attachment.id
            || file.kind !== 'image'
            || file.secret
            || !file.actions.preview
            || !file.width
            || !file.height
          )
            return
          setImage({ key, url: `/link/api/attachments/${encodeURIComponent(file.handle)}/content` })
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(key)
        })
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load()
    })
    observer.observe(anchor.current)
    return () => {
      controller.abort()
      observer.disconnect()
    }
  }, [key, attachment.id, attachment.kind, session?.id, open])
  const picture = image?.key === key && failed !== key ? image.url : undefined
  return (
    <Button
      ref={anchor}
      size="sm"
      variant="secondary"
      className={attachment.kind === 'image' ? 'message-attachment-picture' : 'message-attachment-file'}
      aria-label={`${attachment.name} ${Math.ceil(attachment.size / 1024)} KB`}
      disabled={!session || !open}
      onClick={() => {
        if (session) open?.({ sessionId: session.id, reference: attachment.name, attachmentId: attachment.id })
      }}>
      {picture ? (
        <img src={picture} alt="" loading="lazy" decoding="async" onError={() => setFailed(key)} />
      ) : (
        <>
          <Icon icon={attachment.kind === 'image' ? Image : FileGlyph} size={20} />
          <span className="attachment-file-copy">
            <span className="attachment-name">
              <VisibleText text={attachment.name} />
            </span>
            <span className="attachment-state">{Math.ceil(attachment.size / 1024)} KB</span>
          </span>
        </>
      )}
    </Button>
  )
}

export function MessageAttachments({ attachments }: { attachments?: AttachmentRef[] }) {
  if (!attachments?.length) return null
  return (
    <div className="message-attachments" aria-label="消息附件">
      {attachments.map(ref => (
        <MessageAttachment key={ref.id} attachment={ref} />
      ))}
    </div>
  )
}
