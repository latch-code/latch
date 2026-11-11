import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Code, Copy, Download, Ellipsis, ExternalLink, Eye, FolderOpen, GitCompare, MessageSquareQuote, RefreshCw } from 'lucide-react'
import { isFileMetadata, type FileMetadata, type FileMention } from '@latch/protocol'
import { Button, IconButton, InlineNotice, Loading, Menu, useCopy, type MenuItem } from '@latch/ui'
import { api, ApiError, errorMessage, fileBytes } from '../core/api.ts'
import { currentShell, revealLabel, shellFiles } from '../core/shell.ts'
import { describeFailure, fileRefusalText } from '../core/securityCopy.ts'
import { basename } from '../format.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { DocumentPreview } from './DocumentPreview.tsx'
import { FileSandbox } from './FileSandbox.tsx'
import { TextPreview } from './TextPreview.tsx'
import { MarkdownPreview } from './MarkdownPreview.tsx'
import { HtmlPreview } from './HtmlPreview.tsx'
import { ImagePreview } from './ImagePreview.tsx'
import { FileOpenContext, contextOf, fileContextBody, fileContextKey, fileRoute, targetIn } from './fileContext.ts'
import { resolveFileImage } from './fileImages.ts'
import type { FileTab } from './useFileTabs.ts'
import { selectedQuote, type FileQuote, type PreviewQuote } from './quote.ts'
import { FileBreadcrumb } from './FileBreadcrumb.tsx'
import { ViewerActionsProvider, useViewerActionsHost } from './viewerActions.tsx'

interface ResolveResult {
  files: Array<{ status: string; code?: string; line?: number; file?: unknown }>
}
export function FilePreview({
  tab,
  local,
  deviceId,
  onHistory,
  folders,
  cwd,
  onResolved,
  onMention,
  onQuote,
  browsable = false,
}: {
  /** This device may list the session's folders. */
  browsable?: boolean
  tab: FileTab
  local: boolean
  deviceId?: string
  onHistory?(): void
  folders?: Array<{ id: string; path: string }>
  cwd?: string
  onResolved(file: FileMetadata): void
  onMention?(mention: FileMention): void
  onQuote?(value: FileQuote): void
}) {
  const [file, setFile] = useState<FileMetadata>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [version, setVersion] = useState(0),
    [showSecret, setShowSecret] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  const [selection, setSelection] = useState<PreviewQuote>()
  const [updated, setUpdated] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const [updatingText, setUpdatingText] = useState(false)
  /** The bytes behind a known file could not be read; other errors (a download, a native action) leave the preview standing. */
  const [textFailed, setTextFailed] = useState(false)
  const openFile = useContext(FileOpenContext)
  const [text, setText] = useState<string>(),
    [downloading, setDownloading] = useState(false)
  const copied = useCopy()
  const viewer = useViewerActionsHost()
  const downloadController = useRef<AbortController | undefined>(undefined)
  const expiredRetry = useRef(false)
  const playback = useRef({ time: 0, playing: false })
  useEffect(() => () => downloadController.current?.abort(), [])
  const current = useRef<FileMetadata | undefined>(undefined),
    resolved = useRef(onResolved)
  current.current = file
  resolved.current = onResolved
  const { reference, rootId, attachmentId } = tab.target
  const context = contextOf(tab.target)
  const contextKey = fileContextKey(context)
  const load = useCallback(
    async (signal?: AbortSignal, announce = false) => {
      if (attachmentId) {
        const result = await api<{ file: unknown }>(`attachments/${attachmentId}/resolve`, {
          method: 'POST',
          ...(signal ? { signal } : {}),
        })
        if (!isFileMetadata(result.file) || result.file.source !== 'attachment') throw new Error('附件响应无效。')
        if (signal?.aborted) return
        setFile(result.file)
        resolved.current(result.file)
        setError('')
        setNotice('')
        return
      }
      const result = await api<ResolveResult>(fileRoute(context, 'resolve'), {
        method: 'POST',
        body: {
          ...fileContextBody(context),
          paths: [reference],
          ...(rootId ? { rootId } : {}),
          ...(showSecret ? { showSecret: true } : {}),
        },
        ...(signal ? { signal } : {}),
      })
      const answer = result.files[0]
      if (!answer || answer.status !== 'ok' || !isFileMetadata(answer.file))
        throw new Error(answer?.code ? describeFailure(403, answer.code, '无法读取这个文件。') : '无法读取这个文件。')
      if (signal?.aborted) return
      setFile(answer.file)
      if (announce) {
        setSelection(undefined)
        setUpdated(true)
      }
      resolved.current(answer.file)
      setError('')
      setNotice('')
    },
    [contextKey, reference, rootId, showSecret, attachmentId],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : errorMessage(cause))
    })
    return () => controller.abort()
  }, [load, version])
  useEffect(() => {
    if (!file || file.source === 'attachment') return
    const controller = new AbortController()
    let checking = false
    const timer = setInterval(() => {
      if (checking || document.hidden) return
      checking = true
      void api<unknown>(`files/${file.handle}/meta`, { signal: controller.signal })
        .then(async value => {
          if (controller.signal.aborted) return
          const next = value && typeof value === 'object' && 'file' in value ? value.file : value
          if (
            next
            && typeof next === 'object'
            && 'etag' in next
            && typeof next.etag === 'string'
            && /^"[a-f0-9]{32}"$/u.test(next.etag)
            && next.etag !== file.etag
          ) {
            await load(controller.signal, true)
          }
        })
        .catch(cause => {
          if (controller.signal.aborted) return
          if (cause instanceof ApiError && cause.status === 410) {
            if (expiredRetry.current) {
              setNotice('文件暂不可用；之前读到的内容仍保留在这里。')
              return
            }
            expiredRetry.current = true
            void load(controller.signal).catch(cause => {
              if (controller.signal.aborted) return
              if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
                setFile(undefined)
                setText(undefined)
                setSelection(undefined)
                setError(errorMessage(cause))
              } else setNotice('文件暂不可用；之前读到的内容仍保留在这里。')
            })
            return
          }
          if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
            setFile(undefined)
            setText(undefined)
            setError(errorMessage(cause))
            return
          }
          setNotice('文件暂不可用；之前读到的内容仍保留在这里。')
        })
        .finally(() => {
          checking = false
        })
    }, 2000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [file?.handle, file?.etag, load])
  useEffect(() => {
    if (!updated) return
    const timer = setTimeout(() => setUpdated(false), 6000)
    return () => clearTimeout(timer)
  }, [updated, file?.etag])
  const quote = (excerpt: PreviewQuote) => {
    if (!file || file.secret || !onQuote || current.current?.etag !== file.etag || !excerpt.text.trim()) return
    onQuote({
      contextKey,
      file: { root: file.root, path: file.path, name: file.name, source: file.source, size: file.size, mtime: file.mtime, etag: file.etag },
      excerpt,
    })
    setSelection(undefined)
  }
  const read = useCallback(
    (start?: number, end?: number, signal?: AbortSignal) => {
      if (!file) return Promise.reject(new Error('file-unavailable'))
      return fileBytes(file.handle, start, end, signal, file.etag, file.source).catch(cause => {
        if (
          !signal?.aborted
          && cause instanceof ApiError
          && (cause.status === 401 || cause.status === 403)
          && current.current?.handle === file.handle
          && current.current.etag === file.etag
        ) {
          setFile(undefined)
          setText(undefined)
          setSelection(undefined)
          setError(errorMessage(cause))
        }
        throw cause
      })
    },
    [file?.handle, file?.etag, file?.source],
  )
  useEffect(() => {
    if (
      !file
      || (!file.actions.preview && !(file.secret && showSecret))
      || (!file.secret
        && (['pptx', 'docx', 'xlsx', 'pdf', 'csv', 'image', 'audio', 'video'].includes(file.kind) || (file.kind === 'svg' && !sourceMode)))
    ) {
      setUpdatingText(false)
      return
    }
    const controller = new AbortController()
    setUpdatingText(true)
    setTextFailed(false)
    void read(undefined, undefined, controller.signal).then(
      bytes => {
        if (controller.signal.aborted) return
        const head = new Uint8Array(bytes)
        const encoding = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8'
        setText(new TextDecoder(encoding).decode(bytes))
        setSelection(undefined)
        setError('')
        setUpdatingText(false)
      },
      cause => {
        if (!controller.signal.aborted) {
          setUpdatingText(false)
          setTextFailed(true)
          setError(errorMessage(cause))
        }
      },
    )
    return () => controller.abort()
  }, [file?.etag, file?.handle, file?.kind, file?.actions.preview, showSecret, sourceMode, read, version])
  const refresh = () => {
    expiredRetry.current = false
    setError('')
    setVersion(value => value + 1)
  }
  const download = async () => {
    if (!file || !file.actions.download) return
    setDownloading(true)
    downloadController.current?.abort()
    const controller = new AbortController()
    downloadController.current = controller
    try {
      const bytes = await read(undefined, undefined, controller.signal)
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.name
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDownloading(false)
    }
  }
  const base = file ? (folders?.length ? folders.find(folder => folder.id === file.root)?.path : cwd) : undefined
  const fullPath = file && base ? `${base.replace(/[\\/]+$/u, '')}/${file.path}` : (file?.path ?? reference)
  const shell = shellFiles()
  const nativeFiles = local && file?.source !== 'attachment' && (context.kind === 'session' || shell?.protocolVersion === 2) ? shell : null
  const native = async (action: 'reveal' | 'quickLook' | 'open') => {
    if (!nativeFiles || !file) return
    try {
      const result = await nativeFiles[action](
        context.kind === 'session' ? context.sessionId : { workspaceId: context.workspaceId, harnessId: context.harnessId },
        { handle: file.handle },
      )
      if (result.status === 'refused' || result.status === 'failed') setError(fileRefusalText(result.code))
      if (result.status === 'busy') setError('上一个操作还没有完成，请稍后再试。')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  const mediaEvents = {
    onTimeUpdate: (event: { currentTarget: HTMLMediaElement }) => {
      playback.current.time = event.currentTarget.currentTime
    },
    onPlay: () => {
      playback.current.playing = true
    },
    onPause: () => {
      playback.current.playing = false
    },
    onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) => {
      const media = event.currentTarget
      if (Number.isFinite(media.duration)) media.currentTime = Math.min(playback.current.time, media.duration)
      if (playback.current.playing)
        void media.play().catch(() => {
          playback.current.playing = false
        })
    },
  }
  const source = file
    ? file.source === 'attachment'
      ? `/link/api/attachments/${file.handle}/content`
      : `/link/api/files/${file.handle}?v=${file.etag.slice(1, -1)}`
    : ''
  const imageRoot = file?.root ?? rootId
  const resolveImage = useCallback(
    (reference: string, signal: AbortSignal) => resolveFileImage(context, reference, imageRoot, signal),
    [contextKey, imageRoot],
  )
  // A document's own renderer knows its selection and page. In text, the selection quotes, and without one the file itself.
  const quoteAction = viewer.quote
    ? viewer.quote
    : !file || file.secret || (!onQuote && !onMention) || ['pptx', 'docx', 'xlsx', 'pdf', 'csv'].includes(file.kind)
      ? null
      : selection && onQuote
        ? {
            ready: !updatingText,
            run: () => {
              quote(selection)
            },
          }
        : onMention && file.source !== 'attachment'
          ? {
              ready: true,
              run: () => {
                onMention({ root: file.root, path: file.path })
              },
            }
          : null
  const canToggleSource = !!file && !file.secret && (viewer.source !== null || ['markdown', 'svg'].includes(file.kind))
  return (
    <section
      className="file-preview"
      aria-label="文件预览"
      onKeyDown={event => {
        if (
          event.defaultPrevented
          || event.nativeEvent.isComposing
          || event.code !== 'Space'
          || event.metaKey
          || event.ctrlKey
          || event.altKey
          || !nativeFiles
          || !file?.actions.quicklook
        )
          return
        const target = event.target
        if (
          !(target instanceof Element)
          || target.closest('input,textarea,select,button,a,audio,video,[contenteditable="true"],[role="slider"]')
        )
          return
        event.preventDefault()
        event.stopPropagation()
        void native('quickLook')
      }}>
      <header className="file-preview-head">
        <FileBreadcrumb
          context={context}
          {...(file ? { root: file.root } : {})}
          rootName={base ? basename(base) : '会话文件夹'}
          path={file?.path ?? reference}
          name={file?.name ?? reference}
          attachment={file?.source === 'attachment' || attachmentId !== undefined}
          browsable={browsable}
          onOpen={path => openFile?.(targetIn(context, path, file?.root))}
        />
        {updated && (
          <span className="file-preview-updated" role="status">
            已更新
          </span>
        )}
        <span className="file-preview-actions">
          {canToggleSource && (
            <IconButton
              size="xs"
              label="源码"
              icon={Code}
              pressed={viewer.source ? viewer.source.showing : sourceMode}
              onClick={() => {
                if (viewer.source) viewer.source.onToggle()
                else setSourceMode(!sourceMode)
              }}
            />
          )}
          {quoteAction && (
            <IconButton
              size="xs"
              label="引用到对话"
              icon={MessageSquareQuote}
              disabled={!quoteAction.ready}
              onPointerDown={event => event.preventDefault()}
              onClick={quoteAction.run}
            />
          )}
          {nativeFiles && file?.actions.reveal && (
            <IconButton
              size="xs"
              label={revealLabel(currentShell()?.platform)}
              icon={FolderOpen}
              onClick={() => {
                void native('reveal')
              }}
            />
          )}
          {nativeFiles && file?.actions.open && (
            <IconButton
              size="xs"
              label="用默认应用打开"
              icon={ExternalLink}
              onClick={() => {
                void native('open')
              }}
            />
          )}
          {file && (
            <Menu
              label="文件操作"
              align="end"
              trigger={props => <IconButton {...props} size="xs" label="文件操作" icon={Ellipsis} />}
              sections={[
                { id: 'renderer', items: [...viewer.menu] },
                {
                  id: 'file',
                  items: [
                    ...(nativeFiles && file.actions.quicklook
                      ? [
                          {
                            id: 'quicklook',
                            label: '快速查看',
                            icon: Eye,
                            onSelect: () => {
                              void native('quickLook')
                            },
                          },
                        ]
                      : []),
                    ...(onHistory ? [{ id: 'history', label: '查看改动', icon: GitCompare, onSelect: onHistory }] : []),
                    ...(file.source !== 'attachment'
                      ? [
                          {
                            id: 'copy',
                            label: '复制路径',
                            icon: Copy,
                            onSelect: () => {
                              void copied.copy(fullPath)
                            },
                          },
                        ]
                      : []),
                    ...(file.actions.download
                      ? [
                          {
                            id: 'download',
                            label: downloading ? '正在下载' : '下载文件',
                            icon: Download,
                            ...(downloading ? { disabledReason: '下载还未结束' } : {}),
                            onSelect: () => {
                              void download()
                            },
                          },
                        ]
                      : []),
                    { id: 'refresh', label: '更新预览', icon: RefreshCw, onSelect: refresh },
                  ] satisfies MenuItem[],
                },
              ]}
            />
          )}
        </span>
        <span className="sr-only" role="status">
          {copied.state === 'copied' ? '已复制' : copied.state === 'failed' ? '复制不可用，请手动选择路径' : ''}
        </span>
      </header>
      {notice && (
        <InlineNotice
          tone="warn"
          action={
            <Button size="xs" onClick={refresh}>
              更新预览
            </Button>
          }>
          {notice}
        </InlineNotice>
      )}
      {error && (
        <InlineNotice
          tone="error"
          action={
            file && !textFailed ? undefined : (
              <Button size="xs" onClick={refresh}>
                重试
              </Button>
            )
          }>
          {error}
        </InlineNotice>
      )}
      {updatingText && text !== undefined && (
        <p className="file-preview-caption" role="status">
          正在更新预览…
        </p>
      )}
      {!file && !error && <Loading label="正在读取文件信息…" />}
      {file && (
        <ViewerActionsProvider value={viewer.value}>
          {file.truncated && <InlineNotice tone="warn">文件较大，仅显示前 {(file.limit / 1024 / 1024).toFixed(0)} MiB。</InlineNotice>}
          {file.secret && !showSecret ? (
            <InlineNotice
              tone="warn"
              action={
                (local || file.source === 'attachment') && ['text', 'code', 'markdown', 'html', 'csv'].includes(file.kind) ? (
                  <Button size="xs" onClick={() => setShowSecret(true)}>
                    显示内容
                  </Button>
                ) : undefined
              }>
              这个文件可能包含密钥。{local || file.source === 'attachment' ? '显示后，内容只以纯文本呈现。' : '请在 Mac 上查看。'}
            </InlineNotice>
          ) : !file.actions.preview ? (
            <InlineNotice>
              {file.refused?.preview ? describeFailure(403, file.refused.preview, '不能在这里预览这个文件。') : '这个文件尚不支持预览。'}
            </InlineNotice>
          ) : (
            <div
              className="file-preview-body"
              ref={body}
              onMouseUp={() => setSelection(selectedQuote(body.current))}
              onKeyUp={() => setSelection(selectedQuote(body.current))}>
              {file.secret ? (
                text === undefined ? (
                  textFailed ? null : (
                    <Loading label="正在读取内容…" />
                  )
                ) : (
                  <TextPreview text={text} path={file.path} line={tab.target.line} sensitive />
                )
              ) : ['pptx', 'docx', 'xlsx', 'pdf', 'csv'].includes(file.kind) ? (
                <DocumentPreview
                  file={file}
                  versionKey={`${file.etag}:${version}`}
                  read={read}
                  renderFrame={input => <FileSandbox {...input} />}
                  onQuote={onQuote ? quote : undefined}
                />
              ) : file.kind === 'image' || (file.kind === 'svg' && !sourceMode) ? (
                <ImagePreview file={file} source={source} local={local} />
              ) : file.kind === 'audio' ? (
                <audio {...mediaEvents} controls src={source} preload="metadata" />
              ) : file.kind === 'video' ? (
                <video {...mediaEvents} controls src={source} preload="metadata" playsInline />
              ) : text === undefined ? (
                textFailed ? null : (
                  <Loading label="正在读取内容…" />
                )
              ) : file.kind === 'html' ? (
                <HtmlPreview
                  text={text}
                  path={file.path}
                  versionKey={`${file.etag}:${version}`}
                  local={local}
                  preferenceKey={deviceId ? `latch.html-scripts.${deviceId}.${contextKey}.${file.root}.${file.path}` : undefined}
                />
              ) : file.kind === 'markdown' && !sourceMode ? (
                <div className="file-markdown">
                  <MarkdownPreview
                    text={text}
                    path={file.path}
                    onOpenFile={reference => openFile?.(targetIn(context, reference, file.root))}
                    resolveImage={resolveImage}
                    renderFrame={input => <FileSandbox {...input} />}
                  />
                </div>
              ) : (
                <TextPreview text={text} path={file.path} line={tab.target.line} />
              )}
            </div>
          )}
        </ViewerActionsProvider>
      )}
    </section>
  )
}
