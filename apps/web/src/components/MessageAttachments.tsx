import { useContext } from 'react'
import { Image } from 'lucide-react'
import { Button, Icon, FileGlyph } from '@latch/ui'
import type { AttachmentRef } from '@latch/protocol'
import { FileSession } from './FileChip.tsx'
import { FileOpenContext } from '../preview/fileContext.ts'
import { VisibleText } from './VisibleText.tsx'
export function MessageAttachments({ attachments }: { attachments?: AttachmentRef[] }) {
  const session = useContext(FileSession),
    open = useContext(FileOpenContext)
  if (!attachments?.length) return null
  return (
    <div className="message-attachments" aria-label="消息附件">
      {attachments.map(ref => (
        <Button
          key={ref.id}
          size="sm"
          variant="secondary"
          disabled={!session || !open}
          onClick={() => {
            if (session) open?.({ sessionId: session.id, reference: ref.name, attachmentId: ref.id })
          }}>
          <Icon icon={ref.kind === 'image' ? Image : FileGlyph} size={14} />
          <span className="attachment-name">
            <VisibleText text={ref.name} />
          </span>
          <span className="attachment-state">{Math.ceil(ref.size / 1024)} KB</span>
        </Button>
      ))}
    </div>
  )
}
