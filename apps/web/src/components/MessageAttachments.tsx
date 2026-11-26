import { useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { isFileMetadata, type AttachmentRef } from '@latch/protocol'
import { FileSession } from './FileChip.tsx'
import { FileOpenContext } from '../preview/fileContext.ts'
import { AttachmentTile, tileType } from './AttachmentTile.tsx'
import { InlineMedia, inlineImageWidth } from './InlineMedia.tsx'
import { PictureGroup, useInPictureGroup, usePictureViewer } from './PictureViewer.tsx'
import { drawableMedia, type MediaKind, type ResolvedMedia } from '../preview/fileImages.ts'
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
 * A stored attachment as a tile of the file itself. A picture, video or sound asks for its preview handle once the tile
 * comes into view and draws from it; nothing that may hold a secret is drawn. Pressing a drawn picture shows it large
 * over the page, from where it can open in the file pane; anything else opens the file pane.
 */
export function MessageAttachment({
  attachment,
  inline = false,
  sessionId: sourceSessionId,
  corner,
}: {
  attachment: AttachmentRef
  inline?: boolean
  sessionId?: string
  corner?: ReactNode
}) {
  const fileSession = useContext(FileSession),
    open = useContext(FileOpenContext)
  const sessionId = sourceSessionId ?? fileSession?.id
  const anchor = useRef<HTMLElement>(null)
  const type = tileType(attachment)
  const drawn = type === 'image' || type === 'video' || type === 'audio'
  const key = `${sessionId ?? ''}\n${attachment.id}\n${attachment.sha256}`
  const [media, setMedia] = useState<{ key: string; url: string; download: boolean }>()
  const [failed, setFailed] = useState<string>()
  // Its preview handle lapses (10 minutes): the first failure asks the Host once more and resumes where playback stood.
  const [retry, setRetry] = useState<{ key: string; at?: number }>()
  const picture = type === 'image' && media?.key === key ? media.url : undefined
  useEffect(() => {
    const again = retry?.key === key
    if (!drawn || !sessionId || !open || (!anchor.current && !again)) return
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
          ) {
            setFailed(key)
            return
          }
          setMedia({ key, url: `/link/api/attachments/${encodeURIComponent(file.handle)}/content`, download: file.actions.download })
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(key)
        })
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load()
    })
    // Asked again after the drawn media failed: it is already in view.
    if (again || !anchor.current) load()
    else observer.observe(anchor.current)
    return () => {
      controller.abort()
      observer.disconnect()
    }
  }, [key, attachment.id, type, drawn, sessionId, open, retry])
  const openPane = () => {
    if (sessionId) open?.({ sessionId, reference: attachment.name, attachmentId: attachment.id })
  }
  // An agent's picture, video or sound is drawn in its reply at its own size, as media a reply links to is; until the
  // Host answers, a picture or video holds its place, and what cannot be drawn is the tile.
  const drawnInline = inline && drawn && failed !== key && !!sessionId && !!open
  const shown: ResolvedMedia | undefined =
    drawnInline && media?.key === key
      ? {
          kind: type as MediaKind,
          url: media.url,
          name: attachment.name,
          download: media.download,
          ...(type === 'image' && attachment.width && attachment.height ? { width: attachment.width, height: attachment.height } : {}),
        }
      : undefined
  const asMedia = !!shown && drawableMedia(shown, location.href)
  const holding = drawnInline && !shown && type !== 'audio' && (type === 'video' || !!(attachment.width && attachment.height))
  // A sent picture drawn on its tile is shown large over the page the same way.
  const large = usePictureViewer(
    picture && !asMedia && !holding
      ? {
          url: picture,
          name: attachment.name,
          fileName: attachment.name,
          ...(attachment.width && attachment.height ? { width: attachment.width, height: attachment.height } : {}),
          download: media?.download === true,
          ...(sessionId && open ? { openInFiles: openPane } : {}),
          renew: () => setRetry({ key }),
          element: () => anchor.current,
        }
      : undefined,
  )
  if (drawnInline) {
    if (shown && asMedia)
      return (
        <div className="message-attachment-media" data-type={type}>
          <InlineMedia
            media={shown}
            label={attachment.name}
            onFail={at => (retry?.key === key ? setFailed(key) : setRetry({ key, ...(at ? { at } : {}) }))}
            {...(retry?.key === key && retry.at ? { startAt: retry.at } : {})}
            {...(type === 'image' ? { openInFiles: openPane } : {})}
          />
        </div>
      )
    if (holding)
      return (
        <div className="message-attachment-media" data-type={type}>
          <span
            ref={anchor as RefObject<HTMLSpanElement>}
            className="inline-media inline-media-frame"
            data-type={type}
            {...(type === 'image' && attachment.width && attachment.height
              ? {
                  style: {
                    maxWidth: inlineImageWidth(attachment.width, attachment.height),
                    aspectRatio: `${attachment.width} / ${attachment.height}`,
                  },
                }
              : {})}
          />
        </div>
      )
  }
  return (
    <div className={corner ? 'attachment-draft' : 'message-attachment'} data-state={corner ? 'ready' : undefined} data-type={type}>
      <AttachmentTile
        ref={anchor as RefObject<HTMLButtonElement>}
        name={attachment.name}
        type={type}
        {...(media?.key === key ? { src: media.url } : {})}
        label={`${attachment.name} ${sizeText(attachment.size)}`}
        title={`${attachment.name} · ${sizeText(attachment.size)}`}
        disabled={!sessionId || !open}
        corner={corner}
        onOpen={() => {
          // A picture is looked at where it is, large; any other file opens in the file pane.
          if (picture) large.open()
          else openPane()
        }}
      />
      {large.viewer}
      {large.menu}
    </div>
  )
}

/**
 * A message's attachments. What a person sent is a row of tiles; what an agent or a tool made (`output`) is mostly
 * pictures to look at, drawn larger and without their generated names.
 */
export function MessageAttachments({
  attachments,
  output = false,
  inline = false,
}: {
  attachments?: AttachmentRef[]
  output?: boolean
  /** An agent's reply: its pictures, videos and sounds drawn at their own size rather than as tiles. */
  inline?: boolean
}) {
  const grouped = useInPictureGroup()
  if (!attachments?.length) return null
  const list = (
    <div
      className="message-attachments"
      data-output={output ? '' : undefined}
      data-inline={inline ? '' : undefined}
      aria-label={COPY.attachments}>
      {attachments.map(ref => (
        <MessageAttachment key={ref.id} attachment={ref} inline={inline} />
      ))}
    </div>
  )
  // An agent's pictures step with the rest of its turn's; what a person sent is looked through on its own.
  return inline && grouped ? list : <PictureGroup>{list}</PictureGroup>
}
