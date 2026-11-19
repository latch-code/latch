import { useContext, useEffect, useRef, useState } from 'react'
import { isFileMetadata, type AttachmentRef } from '@latch/protocol'
import { Modal, ModalHeader } from '@latch/ui'
import { FileSession } from './FileChip.tsx'
import { FileOpenContext } from '../preview/fileContext.ts'
import { AttachmentTile, tileType } from './AttachmentTile.tsx'
import { api } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    attachments: '消息附件',
  },
  {
    attachments: 'Message attachments',
  },
)

const sizeText = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * A sent attachment as a tile of the file itself. A picture, video or sound asks for its preview handle once the tile
 * comes into view and draws from it; nothing that may hold a secret is drawn. Pressing a drawn picture shows it large
 * over the page; anything else opens the file pane.
 */
function MessageAttachment({ attachment }: { attachment: AttachmentRef }) {
  const session = useContext(FileSession),
    open = useContext(FileOpenContext)
  const anchor = useRef<HTMLButtonElement>(null)
  const type = tileType(attachment)
  const drawn = type === 'image' || type === 'video' || type === 'audio'
  const key = `${session?.id ?? ''}\n${attachment.id}\n${attachment.sha256}`
  const [media, setMedia] = useState<{ key: string; url: string }>()
  const [large, setLarge] = useState(false)
  const picture = type === 'image' && media?.key === key ? media.url : undefined
  useEffect(() => {
    if (!drawn || !session || !open || !anchor.current) return
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
            || file.kind !== type
            || file.secret
            || !file.actions.preview
            || (type === 'image' && (!file.width || !file.height))
          )
            return
          setMedia({ key, url: `/link/api/attachments/${encodeURIComponent(file.handle)}/content` })
        })
        .catch(() => {})
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load()
    })
    observer.observe(anchor.current)
    return () => {
      controller.abort()
      observer.disconnect()
    }
  }, [key, attachment.id, type, drawn, session?.id, open])
  return (
    <div className="message-attachment" data-type={type}>
      <AttachmentTile
        ref={anchor}
        name={attachment.name}
        type={type}
        {...(media?.key === key ? { src: media.url } : {})}
        label={`${attachment.name} ${sizeText(attachment.size)}`}
        title={`${attachment.name} · ${sizeText(attachment.size)}`}
        disabled={!session || !open}
        onOpen={() => {
          // A picture is looked at where it is, large; any other file opens in the file pane.
          if (picture) setLarge(true)
          else if (session) open?.({ sessionId: session.id, reference: attachment.name, attachmentId: attachment.id })
        }}
      />
      {large && picture && (
        <Modal label={attachment.name} variant="dialog" onClose={() => setLarge(false)} className="attachment-preview is-large">
          <ModalHeader title={attachment.name} onClose={() => setLarge(false)} />
          <div className="ui-modal-body">
            <img src={picture} alt={attachment.name} />
          </div>
        </Modal>
      )}
    </div>
  )
}

/**
 * A message's attachments. What a person sent is a row of tiles; what an agent or a tool made (`output`) is mostly
 * pictures to look at, drawn larger and without their generated names.
 */
export function MessageAttachments({ attachments, output = false }: { attachments?: AttachmentRef[]; output?: boolean }) {
  if (!attachments?.length) return null
  return (
    <div className="message-attachments" data-output={output ? '' : undefined} aria-label={COPY.attachments}>
      {attachments.map(ref => (
        <MessageAttachment key={ref.id} attachment={ref} />
      ))}
    </div>
  )
}
