import { forwardRef, useEffect, useState, type ReactNode } from 'react'
import { AudioLines, FileArchive, FileCode, FileSpreadsheet, FileText, Film, Image as ImageGlyph, Play } from 'lucide-react'
import { Icon, FileGlyph, type IconComponent } from '@latch/ui'
import type { AttachmentRef } from '@latch/protocol'
import { VisibleText } from './VisibleText.tsx'

/** What a tile shows: the media itself where a browser can draw it, else a typed tile with the file's extension. */
export type TileType = 'image' | 'video' | 'audio' | 'pdf' | 'code' | 'text' | 'sheet' | 'doc' | 'archive' | 'file'
export type DraftDocumentKind = 'pdf' | 'csv' | 'docx' | 'xlsx' | 'pptx'

const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cpp',
  'h',
  'cs',
  'php',
  'sh',
  'css',
  'html',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'sql',
  'svg',
])
export const extOf = (name: string) => (name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '')
const baseMime = (mime?: string) => (mime ?? '').split(';')[0]!.trim().toLowerCase()
/** Pictures a browser decodes everywhere; HEIC and the like get a typed tile. */
const DRAWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'])

export function isMarkdownFile(input: { name: string; mime?: string }): boolean {
  const ext = extOf(input.name),
    mime = baseMime(input.mime)
  return mime === 'text/markdown' || ['md', 'markdown', 'mdx'].includes(ext)
}

export function draftDocumentKind(input: { name: string; mime?: string; size: number }): DraftDocumentKind | undefined {
  const ext = extOf(input.name),
    mime = baseMime(input.mime)
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime === 'text/csv' || mime === 'text/tab-separated-values' || ext === 'csv' || ext === 'tsv') return 'csv'
  if (input.size > 0 && input.size <= 50 * 1024 * 1024) {
    if (mime.endsWith('wordprocessingml.document') || ext === 'docx') return 'docx'
    if (mime.endsWith('spreadsheetml.sheet') || ext === 'xlsx') return 'xlsx'
    if (mime.endsWith('presentationml.presentation') || ext === 'pptx') return 'pptx'
  }
  return undefined
}

export function tileType(input: { name: string; mime?: string; kind?: AttachmentRef['kind'] }): TileType {
  const ext = extOf(input.name),
    mime = baseMime(input.mime)
  if (input.kind === 'image' || DRAWN.has(mime)) return 'image'
  // Browsers call a .ts file MPEG-TS video; it is far more often source.
  if (CODE.has(ext) && input.kind !== 'file') return 'code'
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video'
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(ext)) return 'audio'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime.includes('spreadsheet') || ['xlsx', 'xls', 'csv', 'tsv', 'numbers'].includes(ext)) return 'sheet'
  if (mime.includes('wordprocessing') || mime.includes('presentation') || ['docx', 'doc', 'pptx', 'ppt', 'pages', 'key'].includes(ext))
    return 'doc'
  if (mime === 'application/zip' || ['zip', 'gz', 'tgz', 'rar', '7z', 'tar'].includes(ext)) return 'archive'
  if (CODE.has(ext)) return 'code'
  if (input.kind === 'text' || ['txt', 'md', 'markdown', 'mdx', 'log', 'rtf'].includes(ext)) return 'text'
  return DRAWN.has(mime) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext) ? 'image' : 'file'
}
const GLYPH: Record<TileType, IconComponent> = {
  image: ImageGlyph,
  video: Film,
  audio: AudioLines,
  pdf: FileText,
  code: FileCode,
  text: FileText,
  sheet: FileSpreadsheet,
  doc: FileText,
  archive: FileArchive,
  file: FileGlyph,
}
/** 12:04, or 1:02:03. */
export const durationText = (seconds: number) => {
  const whole = Math.max(0, Math.round(seconds)),
    h = Math.floor(whole / 3600),
    m = Math.floor((whole % 3600) / 60),
    s = String(whole % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
/** A name cut in its middle, so the end that tells files apart (`报告…版）.pdf`) stays: its extension and two more. */
export function nameParts(name: string): { head: string; tail: string } {
  const chars = [...name],
    ext = name.includes('.') ? [...name.split('.').at(-1)!].length + 1 : 0,
    keep = Math.min(ext + 2, 10)
  if (chars.length <= keep + 1) return { head: name, tail: '' }
  return { head: chars.slice(0, -keep).join(''), tail: chars.slice(-keep).join('') }
}

function Media({
  type,
  src,
  name,
  caption,
  onDuration,
}: {
  type: TileType
  src?: string
  name: string
  /** Under the glyph instead of the extension: a sound's length. */
  caption?: string
  onDuration(value: number): void
}) {
  const [broken, setBroken] = useState<string>()
  useEffect(() => setBroken(undefined), [src])
  if (src && broken !== src && type === 'image')
    return <img src={src} alt="" decoding="async" loading="lazy" draggable={false} onError={() => setBroken(src)} />
  if (src && broken !== src && type === 'video')
    return (
      <video
        src={src}
        muted
        playsInline
        preload="metadata"
        tabIndex={-1}
        aria-hidden="true"
        onLoadedMetadata={event => {
          const video = event.currentTarget
          if (Number.isFinite(video.duration)) onDuration(video.duration)
          // The first frame, drawn once the browser has it.
          video.currentTime = Math.min(0.1, video.duration / 2 || 0)
        }}
        onError={() => setBroken(src)}
      />
    )
  const ext = extOf(name)
  return (
    <span className="attachment-tile-type">
      <Icon icon={GLYPH[type]} size={20} />
      {caption ? (
        <span className="attachment-tile-ext" data-caption="">
          {caption}
        </span>
      ) : (
        ext && ext.length <= 5 && <span className="attachment-tile-ext">{ext.toUpperCase()}</span>
      )}
    </span>
  )
}

/** The duration of a sound, read from its metadata only. */
function useAudioDuration(src: string | undefined, enabled: boolean, onDuration: (value: number) => void) {
  useEffect(() => {
    if (!src || !enabled) return
    const audio = new Audio()
    audio.preload = 'metadata'
    const done = () => Number.isFinite(audio.duration) && onDuration(audio.duration)
    audio.addEventListener('loadedmetadata', done)
    audio.src = src
    return () => {
      audio.removeEventListener('loadedmetadata', done)
      audio.removeAttribute('src')
      audio.load()
    }
  }, [src, enabled])
}

export interface AttachmentTileProps {
  name: string
  type: TileType
  /** The bytes as a URL the page may draw: an object URL of the draft, or the attachment's preview content. */
  src?: string
  /** Upload progress, 0–1, while it goes. */
  progress?: number
  /** Busy without a measurable progress (shrinking, retrieving). */
  busy?: boolean
  failed?: boolean
  /** On hover: size, and how it goes to the agent when that is not native. */
  title?: string
  /** The button that opens it; without it the tile only shows. */
  onOpen?(): void
  disabled?: boolean
  /** Its accessible name. */
  label: string
  /** The remove ×, on the tile's corner. */
  corner?: ReactNode
}

/** A compact square of the attachment itself (a picture, a video's first frame, a typed tile) with its name under it. */
export const AttachmentTile = forwardRef<HTMLButtonElement, AttachmentTileProps>(function AttachmentTile(
  { name, type, src, progress, busy, failed, title, onOpen, disabled, label, corner },
  ref,
) {
  const [duration, setDuration] = useState<number>()
  useAudioDuration(src, type === 'audio', setDuration)
  const { head, tail } = nameParts(name)
  const face = (
    <>
      <Media
        type={type}
        src={src}
        name={name}
        {...(type === 'audio' && duration !== undefined ? { caption: durationText(duration) } : {})}
        onDuration={setDuration}
      />
      {type === 'video' && src && duration !== undefined && (
        <span className="attachment-tile-play" aria-hidden="true">
          <Icon icon={Play} size={12} />
        </span>
      )}
      {duration !== undefined && type === 'video' && <span className="attachment-tile-duration">{durationText(duration)}</span>}
      {(progress !== undefined || busy) && (
        <span className="attachment-tile-progress" aria-hidden="true">
          <span style={progress !== undefined && !busy ? { inlineSize: `${Math.round(progress * 100)}%` } : undefined} />
        </span>
      )}
    </>
  )
  return (
    <span className="attachment-tile" data-type={type} data-failed={failed ? '' : undefined} title={title}>
      {onOpen ? (
        <button ref={ref} type="button" className="attachment-tile-face" aria-label={label} disabled={disabled} onClick={onOpen}>
          {face}
        </button>
      ) : (
        <span className="attachment-tile-face" role="img" aria-label={label}>
          {face}
        </span>
      )}
      {corner}
      <span className="attachment-tile-name" aria-hidden="true">
        <span className="attachment-tile-head">
          <VisibleText text={head} />
        </span>
        {tail && (
          <span className="attachment-tile-tail">
            <VisibleText text={tail} />
          </span>
        )}
      </span>
    </span>
  )
})
