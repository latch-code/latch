import { useRef } from 'react'
import type { ResolvedMedia } from '../preview/fileImages.ts'
import { defineCopy } from '../core/i18n.ts'
import { usePictureViewer } from './PictureViewer.tsx'

const COPY = defineCopy(
  { open: (name: string) => `预览图片：${name}`, image: '图片', video: '视频', audio: '音频' },
  { open: (name: string) => `Preview image: ${name}`, image: 'Image', video: 'Video', audio: 'Audio' },
)

/** The tallest an inline picture is drawn; a portrait one is narrowed to keep its shape, never cropped. */
const IMAGE_MAX_HEIGHT = 320

/** Width cap that keeps a picture of this shape within the height cap, never wider than the reply column. */
export function inlineImageWidth(width: number, height: number): string {
  return `min(100%, ${Math.max(1, Math.min(width, Math.round((IMAGE_MAX_HEIGHT * width) / height)))}px)`
}

/**
 * A picture, video or sound in a reply, drawn from a handle the Host authorized. Its size is reserved from the Host's
 * metadata before the bytes arrive. A picture is looked at large over the page when pressed (with its turn's other pictures
 * a step away), and in the file pane only from there; its context gesture offers 复制图片 and 保存图片. Video and sound
 * keep the browser's own controls. `onFail`
 * lets the caller fall back to its chip when the bytes cannot be drawn.
 */
export function InlineMedia({
  media,
  label,
  openInFiles,
  onFail,
  startAt,
}: {
  media: ResolvedMedia
  label: string
  /** The viewer's 在文件中打开, where the file pane can open this picture. */
  openInFiles?: () => void
  /** The bytes could not be read; for video and sound, where playback stood. */
  onFail?: (position?: number) => void
  /** Where a video or sound resumes after its handle was renewed. */
  startAt?: number
}) {
  const name = label || COPY[media.kind]
  const button = useRef<HTMLButtonElement>(null)
  const { open, viewer, menu } = usePictureViewer(
    media.kind === 'image'
      ? {
          url: media.url,
          name,
          ...(media.name ? { fileName: media.name } : {}),
          ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
          download: media.download === true,
          ...(openInFiles ? { openInFiles } : {}),
          ...(onFail ? { renew: () => onFail() } : {}),
          element: () => button.current,
        }
      : undefined,
  )
  if (media.kind === 'video' || media.kind === 'audio') {
    const events = {
      onError: (event: { currentTarget: HTMLMediaElement }) => onFail?.(event.currentTarget.currentTime),
      onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) => {
        const node = event.currentTarget
        if (startAt && Number.isFinite(node.duration)) node.currentTime = Math.min(startAt, node.duration)
      },
    }
    return media.kind === 'video' ? (
      <video
        className="inline-media inline-media-video"
        src={media.url}
        controls
        preload="metadata"
        playsInline
        aria-label={name}
        {...events}
      />
    ) : (
      <audio className="inline-media inline-media-audio" src={media.url} controls preload="metadata" aria-label={name} {...events} />
    )
  }
  const picture = (
    <img
      className="inline-media-image"
      src={media.url}
      alt={name}
      width={media.width}
      height={media.height}
      loading="lazy"
      decoding="async"
      onError={() => onFail?.()}
    />
  )
  const style = media.width && media.height ? { maxWidth: inlineImageWidth(media.width, media.height) } : undefined
  return (
    <>
      <button
        ref={button}
        type="button"
        className="inline-media inline-media-open"
        style={style}
        aria-label={COPY.open(name)}
        aria-haspopup="dialog"
        onClick={open}>
        {picture}
      </button>
      {viewer}
      {menu}
    </>
  )
}
