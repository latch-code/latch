import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { FileAudio, FileImage, FileVideo, Presentation, Sheet } from 'lucide-react'
import type { FileChange } from '@latch/protocol'
import { Button, Hint, ICON_STROKE, Icon, Tooltip, type IconComponent, PageGlyph, GlobeGlyph, WarningGlyph } from '@latch/ui'
import { FileOpenContext } from '../preview/fileContext.ts'
import { resolveFileImage } from '../preview/fileImages.ts'
import { FileSession } from './FileChip.tsx'
import { VisibleText } from './VisibleText.tsx'
const outputSize = (size: number) =>
  size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
const KIND_ICONS: Record<string, IconComponent> = {
  pptx: Presentation,
  xlsx: Sheet,
  csv: Sheet,
  html: GlobeGlyph,
  svg: FileImage,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
}
function OutputThumbnail({ file }: { file: FileChange }) {
  const session = useContext(FileSession),
    open = useContext(FileOpenContext)
  const anchor = useRef<HTMLSpanElement>(null)
  const key = `${session?.id ?? ''}\n${file.root}\n${file.path}`
  const [value, setValue] = useState<{ key: string; url: string; width: number; height: number }>(),
    [failureKey, setFailureKey] = useState('')
  useEffect(() => {
    if (!session || !open || !anchor.current) return
    const controller = new AbortController()
    let started = false
    const load = () => {
      if (started || controller.signal.aborted) return
      started = true
      observer?.disconnect()
      void resolveFileImage(session.id, file.path, file.root, controller.signal).then(
        image => {
          if (!controller.signal.aborted) setValue({ key, ...image })
        },
        () => {
          if (!controller.signal.aborted) setFailureKey(key)
        },
      )
    }
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) load()
          })
    if (observer) observer.observe(anchor.current)
    else load()
    return () => {
      controller.abort()
      observer?.disconnect()
    }
  }, [key, session?.id, open, file.path, file.root])
  if (failureKey === key || !session || !open) return null
  return (
    <span ref={anchor} className={value?.key === key ? 'file-output-picture' : 'file-output-picture-pending'}>
      {value?.key === key && (
        <Button
          size="xs"
          variant="ghost"
          className="file-output-thumbnail"
          aria-label={`预览产物图片：${file.path}`}
          onClick={() => open({ sessionId: session.id, reference: file.path, rootId: file.root })}>
          <img src={value.url} alt="" width={value.width} height={value.height} loading="lazy" onError={() => setFailureKey(key)} />
        </Button>
      )}
    </span>
  )
}
/** What the watch over the folders could not vouch for. */
export function OutputNotes({ truncated, unavailable }: { truncated?: boolean | undefined; unavailable?: boolean | undefined }) {
  if (!truncated && !unavailable) return null
  return (
    <div className="output-notes">
      <Hint lead={<WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />} label="记录不完整">
        {[
          truncated ? '只记录了部分变化；目录过大、观察中断或部分路径无法读取。' : '',
          unavailable ? '本轮未能完整观察文件变化，请在项目目录中核对结果。' : '',
        ].join('')}
      </Hint>
    </div>
  )
}

/**
 * 「生成了 2 个文件」: what the turn made for the person to open. These come from watching the folders, which sees other
 * writers too, so the card says what exists rather than who wrote it.
 */
export function ProducedFiles({ files, actions }: { files: FileChange[]; actions?: ReactNode }) {
  const session = useContext(FileSession)
  const open = useContext(FileOpenContext)
  if (!files.length) return null
  return (
    <section className="file-outputs" aria-label="这一轮生成的文件">
      <div className="file-outputs-heading">
        <span>生成了 {files.length} 个文件</span>
        {actions}
      </div>
      <ul>
        {files.map(file => {
          const Glyph = KIND_ICONS[file.kind ?? ''] ?? PageGlyph
          const name = file.path.slice(file.path.lastIndexOf('/') + 1)
          return (
            <li key={`${file.root}\n${file.path}`}>
              {file.kind === 'image' ? <OutputThumbnail file={file} /> : <Icon icon={Glyph} size={16} className="file-output-icon" />}
              <span className="file-output-name" title={file.path}>
                <VisibleText text={name} />
              </span>
              {file.size !== undefined && (
                <Tooltip content={`${file.size.toLocaleString()} 字节`}>
                  <span className="file-output-size" tabIndex={0}>
                    {outputSize(file.size)}
                  </span>
                </Tooltip>
              )}
              {session && open && (
                <Button
                  size="xs"
                  variant="secondary"
                  className="file-output-open"
                  aria-label={`打开 ${name}`}
                  onClick={() => {
                    open({ sessionId: session.id, reference: file.path, rootId: file.root })
                  }}>
                  打开
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
