import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { FileAudio, FileImage, FileVideo, Presentation, Sheet } from 'lucide-react'
import type { FileChange } from '@latch/protocol'
import {
  Button,
  ChevronDownGlyph,
  Collapse,
  Hint,
  ICON_STROKE,
  Icon,
  Tooltip,
  type IconComponent,
  PageGlyph,
  GlobeGlyph,
  WarningGlyph,
} from '@latch/ui'
import { FileOpenContext } from '../preview/fileContext.ts'
import { resolveFileImage } from '../preview/fileImages.ts'
import { OutputsOpenContext } from '../conversation/changesLink.ts'
import { FileSession } from './FileChip.tsx'
import { VisibleText } from './VisibleText.tsx'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const INLINE_LIMIT = 12

const COPY = defineCopy(
  {
    previewImage: (value1: string) => `预览产物图片：${value1}`,
    incomplete: '记录不完整',
    partial: '只记录了部分变化；目录过大、观察中断或部分路径无法读取。',
    unavailable: '本轮未能完整观察文件变化，请在项目目录中核对结果。',
    outputs: '这一轮生成的文件',
    generated: '生成了 ',
    files: ' 个文件',
    allIgnored: '临时产物',
    someIgnored: (count: number) => `含 ${formatNumber(count)} 个忽略文件`,
    manageFiles: '查看与清理',
    moreInPanel: (count: number) => `另有 ${formatNumber(count)} 个文件 · 在侧栏查看与清理`,
    showFiles: '显示文件',
    bytes: (value1: string) => `${value1} 字节`,
    openFile: (value1: string) => `打开 ${value1}`,
    open: '打开',
  },
  {
    previewImage: (value1: string) => `Preview output image ${value1}`,
    incomplete: 'Incomplete record',
    partial: 'Only some changes were recorded. The folder may be too large, watching may have stopped or some paths could not be read.',
    unavailable: 'File changes could not be fully tracked this turn. Check the project folder for results.',
    outputs: 'Files created this turn',
    generated: 'Created ',
    files: ' files',
    allIgnored: 'temporary outputs',
    someIgnored: (count: number) => plural(count, { one: '{n} ignored', other: '{n} ignored' }),
    manageFiles: 'View & clean up',
    moreInPanel: (count: number) =>
      plural(count, { one: '{n} more file · View & clean up in panel', other: '{n} more files · View & clean up in panel' }),
    showFiles: 'Show files',
    bytes: (value1: string) => `${value1} bytes`,
    openFile: (value1: string) => `Open ${value1}`,
    open: 'Open',
  },
)

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
function OutputThumbnail({ file, active }: { file: FileChange; active: boolean }) {
  const session = useContext(FileSession),
    open = useContext(FileOpenContext)
  const anchor = useRef<HTMLSpanElement>(null)
  const key = `${session?.id ?? ''}\n${file.root}\n${file.path}`
  const [value, setValue] = useState<{ key: string; url: string; width: number; height: number }>(),
    [failureKey, setFailureKey] = useState('')
  useEffect(() => {
    if (!active || !session || !open || !anchor.current) return
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
  }, [active, key, session?.id, open, file.path, file.root])
  if (failureKey === key || !session || !open) return null
  return (
    <span ref={anchor} className={value?.key === key ? 'file-output-picture' : 'file-output-picture-pending'}>
      {value?.key === key && (
        <Button
          size="xs"
          variant="ghost"
          className="file-output-thumbnail"
          aria-label={COPY.previewImage(file.path)}
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
      <Hint inline lead={<WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />} label={COPY.incomplete}>
        {[truncated ? COPY.partial : '', unavailable ? COPY.unavailable : ''].join('')}
      </Hint>
    </div>
  )
}

export function FileListToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="changed-files-toggle" aria-label={COPY.showFiles} aria-expanded={expanded} onClick={onToggle}>
      <span className="changed-files-toggle-word">{COPY.showFiles}</span>
      <ChevronDownGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
    </button>
  )
}

/**
 * 「生成了 2 个文件」: what the turn made for the person to open. These come from watching the folders, which sees other
 * writers too, so the card says what exists rather than who wrote it.
 */
export function ProducedFiles({
  files,
  actions,
  turnId,
  messageId,
}: {
  files: FileChange[]
  actions?: ReactNode
  turnId?: string | undefined
  messageId?: string | undefined
}) {
  const session = useContext(FileSession)
  const open = useContext(FileOpenContext)
  const openOutputs = useContext(OutputsOpenContext)
  const [expanded, setExpanded] = useState(false)
  if (!files.length) return null
  const ignoredCount = files.filter(file => file.gitIgnored === true).length
  const inlineFiles = openOutputs && files.length > INLINE_LIMIT ? files.slice(0, INLINE_LIMIT) : files
  const remaining = files.length - inlineFiles.length
  const openPanel = () => {
    openOutputs?.({
      ...(turnId ? { turnId } : {}),
      ...(messageId ? { messageId } : {}),
    })
  }
  return (
    <section className="file-outputs" aria-label={COPY.outputs} data-open={expanded ? '' : undefined}>
      <div className="changed-files-head">
        <span className="changed-files-title">
          {COPY.generated}
          {files.length}
          {COPY.files}
        </span>
        {ignoredCount > 0 && (
          <span className="file-outputs-note">{ignoredCount === files.length ? COPY.allIgnored : COPY.someIgnored(ignoredCount)}</span>
        )}
        <FileListToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        <span className="process-fill" />
        {actions}
        {openOutputs && (
          <Button size="xs" variant="outline" className="file-outputs-panel-open" onClick={openPanel}>
            {COPY.manageFiles}
          </Button>
        )}
      </div>
      <Collapse
        open={expanded}
        onReveal={() => {
          setExpanded(true)
        }}>
        <ul>
          {inlineFiles.map(file => {
            const Glyph = KIND_ICONS[file.kind ?? ''] ?? PageGlyph
            const name = file.path.slice(file.path.lastIndexOf('/') + 1)
            return (
              <li key={`${file.root}\n${file.path}`}>
                {file.kind === 'image' ? (
                  <OutputThumbnail file={file} active={expanded} />
                ) : (
                  <Icon icon={Glyph} size={16} className="file-output-icon" />
                )}
                <span className="file-output-name" title={file.path}>
                  <VisibleText text={name} />
                </span>
                {file.size !== undefined && (
                  <Tooltip content={COPY.bytes(file.size.toLocaleString())}>
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
                    aria-label={COPY.openFile(name)}
                    onClick={() => {
                      open({ sessionId: session.id, reference: file.path, rootId: file.root })
                    }}>
                    {COPY.open}
                  </Button>
                )}
              </li>
            )
          })}
          {remaining > 0 && openOutputs && (
            <li className="file-outputs-more">
              <button type="button" className="file-outputs-more-action" onClick={openPanel}>
                {COPY.moreInPanel(remaining)}
              </button>
            </li>
          )}
        </ul>
      </Collapse>
    </section>
  )
}
