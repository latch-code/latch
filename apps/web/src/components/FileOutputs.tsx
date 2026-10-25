import { useContext, useEffect, useRef, useState } from 'react'
import type { FileChange } from '@latch/protocol'
import { Button, Tooltip } from '@latch/ui'
import { FileOpenContext } from '../preview/fileContext.ts'
import { resolveFileImage } from '../preview/fileImages.ts'
import { FileSession, FileChip } from './FileChip.tsx'
import { VisibleText } from './VisibleText.tsx'
const outputSize = (size: number) =>
  size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
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
const WORDS = { created: '新增', modified: '修改', deleted: '已删除' }
export interface FileOutputsProps {
  files: FileChange[]
  pending?: boolean
  truncated?: boolean
  unavailable?: boolean
}
/** These are observed workspace changes, including other processes; they do not assert who wrote the file. */
export function FileOutputs({ files, pending, truncated, unavailable }: FileOutputsProps) {
  const [expanded, setExpanded] = useState(false)
  if (!files.length && !truncated && !unavailable) return null
  const shown = expanded ? files : files.slice(0, 5)
  return (
    <section className="file-outputs" aria-label="运行期间有变化的文件">
      <Tooltip content="记录项目目录在运行期间及结束后两秒内的变化。其他编辑器或会话的改动也可能包含在内。">
        <span className="file-outputs-heading" tabIndex={0}>
          运行期间有变化的文件{pending ? ' · 正在核对' : ''}
        </span>
      </Tooltip>
      {shown.length > 0 && (
        <ul>
          {shown.map(file => (
            <li key={`${file.root}\n${file.path}`}>
              <span className="file-output-change">{WORDS[file.change]}</span>
              {!pending && file.kind === 'image' && file.change !== 'deleted' && <OutputThumbnail file={file} />}
              {file.change === 'deleted' ? (
                <span className="file-output-deleted">
                  <VisibleText text={file.path} />
                </span>
              ) : (
                <FileChip path={file.path} rootId={file.root} />
              )}
              {file.change !== 'deleted' && file.size !== undefined && (
                <Tooltip content={`${file.size.toLocaleString()} 字节`}>
                  <span className="file-output-size" tabIndex={0}>
                    {outputSize(file.size)}
                  </span>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      {files.length > 5 && (
        <Button variant="ghost" size="xs" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起文件列表' : `查看全部 ${files.length} 个文件`}
        </Button>
      )}
      {truncated && <p>只记录了部分变化；目录过大、观察中断或部分路径无法读取。</p>}
      {unavailable && <p>本轮未能完整观察文件变化，请在项目目录中核对结果。</p>}
    </section>
  )
}
