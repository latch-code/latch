import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { GitCompare, MessageSquareQuote } from 'lucide-react'
import { isFileMetadata, type FileMetadata, type FileMention } from '@latch/protocol'
import {
  Button,
  IconButton,
  InlineNotice,
  Loading,
  Menu,
  useCopy,
  type MenuItem,
  CodeGlyph,
  CopyGlyph,
  DownloadGlyph,
  MoreGlyph,
  ExternalGlyph,
  EyeGlyph,
  FolderOpenGlyph,
  EditGlyph,
  RefreshGlyph,
} from '@latch/ui'
import { api, ApiError, errorMessage, fileBytes, MessageError } from '../core/api.ts'
import { currentShell, revealLabel, shellFiles } from '../core/shell.ts'
import { editorLabel, openInEditor, useEditors } from '../components/OpenInEditor.tsx'
import { describeFailure, fileRefusalText } from '../core/securityCopy.ts'
import { basename } from '../format.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { DocumentPreview } from './DocumentPreview.tsx'
import { FileSandbox } from './FileSandbox.tsx'
import { TextPreview } from './TextPreview.tsx'
import { MarkdownPreview } from './MarkdownPreview.tsx'
import { HtmlPreview } from './HtmlPreview.tsx'
import { ImagePreview } from './ImagePreview.tsx'
import { FileOpenContext, FolderOpenContext, contextOf, fileContextBody, fileContextKey, fileRoute, targetIn } from './fileContext.ts'
import { resolvedFolder } from './treeFiles.ts'
import { resolveFileImage } from './fileImages.ts'
import type { FileTab } from './useFileTabs.ts'
import { selectedQuote, type FileQuote, type PreviewQuote } from './quote.ts'
import { FileBreadcrumb, writtenPlace } from './FileBreadcrumb.tsx'
import { ViewerActionsProvider, useViewerActionsHost } from './viewerActions.tsx'
import { FileEditor } from './FileEditor.tsx'
import { decodeEditable, editHash, mixedLineEndings } from './editText.ts'
import { notePersonEdit } from './personEdits.ts'
import { draftKey, editDraft, setEditDraft } from './editDrafts.ts'
import { useViewport } from '../breakpoints.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    largeFile: (size: number) => `文件较大，仅显示前 ${formatNumber(size)} MiB。`,
    badAttachment: '附件响应无效。',
    cannotRead: '无法读取这个文件。',
    folder: '这是一个文件夹。',
    previous: '文件暂不可用；之前读到的内容仍保留在这里。',
    busy: '上一个操作还没有完成，请稍后再试。',
    preview: '文件预览',
    sessionFolder: '会话文件夹',
    updated: '已更新',
    saved: '已保存',
    editRestricted: '不能在这里编辑这个文件',
    agentEditing: 'Agent 运行中，不能编辑',
    edit: '编辑',
    source: '源码',
    quote: '引用到对话',
    defaultApp: '用默认应用打开',
    actions: '文件操作',
    quickLook: '快速查看',
    changes: '查看改动',
    copy: '复制路径',
    downloading: '正在下载',
    download: '下载文件',
    downloadingReason: '下载还未结束',
    refresh: '更新预览',
    copied: '已复制',
    manualCopy: '复制不可用，请手动选择路径',
    retry: '重试',
    updating: '正在更新预览…',
    readingInfo: '正在读取文件信息…',
    show: '显示内容',
    mayContainSecrets: '这个文件可能包含密钥。',
    plain: '显示后，内容只以纯文本呈现。',
    viewOnMac: '请在 Mac 上查看。',
    cannotPreview: '不能在这里预览这个文件。',
    unsupported: '这个文件尚不支持预览。',
    reading: '正在读取内容…',
  },
  {
    largeFile: (size: number) => `Large file · Showing the first ${formatNumber(size)} MiB.`,
    badAttachment: 'Invalid attachment response.',
    cannotRead: 'Can’t read this file.',
    folder: 'This is a folder.',
    previous: 'File unavailable for now; what was read earlier stays here.',
    busy: 'The last action hasn’t finished. Try again shortly.',
    preview: 'File preview',
    sessionFolder: 'Session folder',
    updated: 'Updated',
    saved: 'Saved',
    editRestricted: 'This file can’t be edited here',
    agentEditing: 'Editing is unavailable while the agent runs',
    edit: 'Edit',
    source: 'Source',
    quote: 'Quote in chat',
    defaultApp: 'Open in default app',
    actions: 'File actions',
    quickLook: 'Quick Look',
    changes: 'View changes',
    copy: 'Copy path',
    downloading: 'Downloading',
    download: 'Download file',
    downloadingReason: 'Download in progress',
    refresh: 'Refresh preview',
    copied: 'Copied',
    manualCopy: 'Can’t copy. Select the path by hand.',
    retry: 'Retry',
    updating: 'Updating preview…',
    readingInfo: 'Reading file info…',
    show: 'Show content',
    mayContainSecrets: 'This file may contain secret keys.',
    plain: ' Once shown, it appears as plain text only.',
    viewOnMac: ' View it on the Mac.',
    cannotPreview: 'This file can’t be previewed here.',
    unsupported: 'Preview isn’t supported for this file yet.',
    reading: 'Reading…',
  },
)

interface ResolveResult {
  files: Array<{ status: string; code?: string; line?: number; file?: unknown; directory?: unknown }>
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
  running = false,
}: {
  /** A turn runs in the session: editing waits for it. */
  running?: boolean
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
  const editors = useEditors()
  const [file, setFile] = useState<FileMetadata>(),
    [error, setError] = useState(''),
    [retained, setRetained] = useState(false),
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
  const openFolder = useContext(FolderOpenContext)
  const [folder, setFolder] = useState(false)
  const [text, setText] = useState<string>(),
    [downloading, setDownloading] = useState(false)
  /** The text as the editor would take it and the hash of its bytes, for the version on screen. */
  const [editBase, setEditBase] = useState<{ text: string; hash: string }>()
  /** The whole file uses more than one line ending, which the Host refuses: said here before anyone tries. */
  const [mixedEol, setMixedEol] = useState(false)
  /** Open editor: the version it started from stays fixed while the preview follows the file; kept per tab. */
  const editSession = contextOf(tab.target).kind === 'session' ? (contextOf(tab.target) as { sessionId: string }).sessionId : undefined
  const tabKey = draftKey(tab.file?.root ?? tab.target.rootId, tab.file?.path ?? tab.target.reference)
  const [editing, setEditingState] = useState(() => (editSession ? editDraft(editSession, tabKey) : undefined))
  const editKey = editing ? draftKey(editing.file.root, editing.file.path) : tabKey
  // A tab restored before its file resolved finds its editor once the folder ID is known.
  useEffect(() => {
    if (!editing && editSession) {
      const stored = editDraft(editSession, tabKey)
      if (stored) setEditingState(stored)
    }
  }, [tabKey])
  const setEditing = (next: { file: FileMetadata; text: string; hash: string } | undefined) => {
    const draft = next ? { ...next, state: { draft: next.text, phase: 'editing' as const } } : undefined
    if (editSession) setEditDraft(editSession, next ? draftKey(next.file.root, next.file.path) : editKey, draft)
    setEditingState(draft)
  }
  const [saved, setSaved] = useState(false)
  const phone = useViewport() === 'phone'
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
        if (!isFileMetadata(result.file) || result.file.source !== 'attachment') throw new MessageError(COPY.badAttachment)
        if (signal?.aborted) return
        setFile(result.file)
        resolved.current(result.file)
        setError('')
        setRetained(false)
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
      if (signal?.aborted) return
      setFolder(answer?.status === 'folder')
      if (answer?.status === 'folder') {
        setFile(undefined)
        setText(undefined)
        setError('')
        setRetained(false)
        const directory = resolvedFolder(answer.directory)
        if (directory && context.kind === 'session') openFolder?.(context.sessionId, directory.root, directory.path, tab.id)
        return
      }
      if (!answer || answer.status !== 'ok' || !isFileMetadata(answer.file))
        throw new MessageError(() => (answer?.code ? describeFailure(403, answer.code, { fallback: COPY.cannotRead }) : COPY.cannotRead))
      setFile(answer.file)
      if (announce) {
        setSelection(undefined)
        setUpdated(true)
      }
      resolved.current(answer.file)
      setError('')
      setRetained(false)
    },
    [contextKey, reference, rootId, showSecret, attachmentId, openFolder, tab.id],
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
              setRetained(true)
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
              } else setRetained(true)
            })
            return
          }
          if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
            setFile(undefined)
            setText(undefined)
            setError(errorMessage(cause))
            return
          }
          setRetained(true)
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
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 6000)
    return () => clearTimeout(timer)
  }, [saved])
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
        setEditBase(undefined)
        const mixed = !!file.actions.edit && mixedLineEndings(head)
        setMixedEol(mixed)
        const editable = file.actions.edit && !file.truncated && !mixed ? decodeEditable(head) : undefined
        if (editable !== undefined)
          void editHash(head).then(hash => {
            if (!controller.signal.aborted && hash) setEditBase({ text: editable, hash })
          })
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
  // A file the conversation named outside the session's folders carries its own folder, which is never browsed.
  const written = file ? undefined : writtenPlace(reference)
  const base = file ? (file.folder ?? (folders?.length ? folders.find(folder => folder.id === file.root)?.path : cwd)) : undefined
  const fullPath = file && base ? `${base.replace(/[\\/]+$/u, '')}/${file.path}` : (file?.path ?? reference)
  const editorText = editorLabel(editors)
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
      if (result.status === 'busy') setError(COPY.busy)
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
        : onMention && file.source !== 'attachment' && file.folder === undefined
          ? {
              ready: true,
              run: () => {
                onMention({ root: file.root, path: file.path })
              },
            }
          : null
  const canToggleSource = !!file && !file.secret && (viewer.source !== null || ['markdown', 'svg'].includes(file.kind))
  const canEdit = context.kind === 'session' && !!file?.actions.edit && !file.secret && !file.truncated && !!editBase && !updatingText
  // The Host says why a text file is not editable here: shown as the disabled button's name, nothing more.
  const editRefusal =
    context.kind === 'session' && file ? (!file.actions.edit ? file.refused?.edit : mixedEol ? 'file-mixed-eol' : undefined) : undefined
  if (editing && context.kind === 'session')
    return (
      <FileEditor
        sessionId={context.sessionId}
        file={editing.file}
        text={editing.text}
        baseHash={editing.hash}
        running={running}
        phone={phone}
        initial={editing.state}
        onState={state => {
          if (editDraft(context.sessionId, editKey)) setEditDraft(context.sessionId, editKey, { ...editing, state })
        }}
        onSaved={() => {
          notePersonEdit(context.sessionId)
          setEditing(undefined)
          setSaved(true)
          refresh()
        }}
        onClose={reread => {
          setEditing(undefined)
          if (reread) refresh()
        }}
      />
    )
  return (
    <section
      className="file-preview"
      aria-label={COPY.preview}
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
          {...(file && file.folder === undefined ? { root: file.root } : {})}
          rootName={base ? basename(base) : COPY.sessionFolder}
          path={file?.path ?? written?.name ?? reference}
          name={file?.name ?? written?.name ?? reference}
          folder={file ? file.folder : written?.folder}
          attachment={file?.source === 'attachment' || attachmentId !== undefined}
          browsable={browsable && file?.folder === undefined}
          onOpen={path => openFile?.(targetIn(context, path, file?.root))}
        />
        {updated && !saved && (
          <span className="file-preview-updated" role="status">
            {COPY.updated}
          </span>
        )}
        {saved && (
          <span className="file-preview-updated" role="status">
            {COPY.saved}
          </span>
        )}
        <span className="file-preview-actions">
          {editRefusal && (
            <IconButton size="xs" label={describeFailure(403, editRefusal, { fallback: COPY.editRestricted })} icon={EditGlyph} disabled />
          )}
          {canEdit && (
            <IconButton
              size="xs"
              label={running ? COPY.agentEditing : COPY.edit}
              icon={EditGlyph}
              disabled={running}
              onClick={() => {
                if (file && editBase) setEditing({ file, text: editBase.text, hash: editBase.hash })
              }}
            />
          )}
          {canToggleSource && (
            <IconButton
              size="xs"
              label={COPY.source}
              icon={CodeGlyph}
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
              label={COPY.quote}
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
              icon={FolderOpenGlyph}
              onClick={() => {
                void native('reveal')
              }}
            />
          )}
          {nativeFiles && file?.actions.open && (
            <IconButton
              size="xs"
              label={COPY.defaultApp}
              icon={ExternalGlyph}
              onClick={() => {
                void native('open')
              }}
            />
          )}
          {file && (
            <Menu
              label={COPY.actions}
              align="end"
              trigger={props => <IconButton {...props} size="xs" label={COPY.actions} icon={MoreGlyph} />}
              sections={[
                { id: 'renderer', items: [...viewer.menu] },
                {
                  id: 'file',
                  items: [
                    ...(nativeFiles && file.actions.editor === true && editorText
                      ? [
                          {
                            id: 'editor',
                            label: editorText,
                            icon: CodeGlyph,
                            onSelect: () => {
                              const owner =
                                context.kind === 'session'
                                  ? context.sessionId
                                  : { workspaceId: context.workspaceId, harnessId: context.harnessId }
                              void openInEditor(owner, { handle: file.handle }, tab.target.line).then(result => {
                                if (result.status === 'refused' || result.status === 'failed') setError(fileRefusalText(result.code))
                                if (result.status === 'busy') setError(COPY.busy)
                              })
                            },
                          },
                        ]
                      : []),
                    ...(nativeFiles && file.actions.quicklook
                      ? [
                          {
                            id: 'quicklook',
                            label: COPY.quickLook,
                            icon: EyeGlyph,
                            onSelect: () => {
                              void native('quickLook')
                            },
                          },
                        ]
                      : []),
                    ...(onHistory ? [{ id: 'history', label: COPY.changes, icon: GitCompare, onSelect: onHistory }] : []),
                    ...(file.source !== 'attachment'
                      ? [
                          {
                            id: 'copy',
                            label: COPY.copy,
                            icon: CopyGlyph,
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
                            label: downloading ? COPY.downloading : COPY.download,
                            icon: DownloadGlyph,
                            ...(downloading ? { disabledReason: COPY.downloadingReason } : {}),
                            onSelect: () => {
                              void download()
                            },
                          },
                        ]
                      : []),
                    { id: 'refresh', label: COPY.refresh, icon: RefreshGlyph, onSelect: refresh },
                  ] satisfies MenuItem[],
                },
              ]}
            />
          )}
        </span>
        <span className="sr-only" role="status">
          {copied.state === 'copied' ? COPY.copied : copied.state === 'failed' ? COPY.manualCopy : ''}
        </span>
      </header>
      {retained && (
        <InlineNotice
          tone="warn"
          action={
            <Button size="xs" onClick={refresh}>
              {COPY.refresh}
            </Button>
          }>
          {COPY.previous}
        </InlineNotice>
      )}
      {error && (
        <InlineNotice
          tone="error"
          action={
            file && !textFailed ? undefined : (
              <Button size="xs" onClick={refresh}>
                {COPY.retry}
              </Button>
            )
          }>
          {error}
        </InlineNotice>
      )}
      {updatingText && text !== undefined && (
        <p className="file-preview-caption" role="status">
          {COPY.updating}
        </p>
      )}
      {folder && (
        <InlineNotice
          action={
            <Button size="xs" onClick={() => void copied.copy(reference)}>
              {COPY.copy}
            </Button>
          }>
          {COPY.folder}
        </InlineNotice>
      )}
      {!file && !error && !folder && <Loading label={COPY.readingInfo} />}
      {file && (
        <ViewerActionsProvider value={viewer.value}>
          {file.truncated && <InlineNotice tone="warn">{COPY.largeFile(Math.round(file.limit / 1024 / 1024))}</InlineNotice>}
          {file.secret && !showSecret ? (
            <InlineNotice
              tone="warn"
              action={
                (local || file.source === 'attachment') && ['text', 'code', 'markdown', 'html', 'csv'].includes(file.kind) ? (
                  <Button size="xs" onClick={() => setShowSecret(true)}>
                    {COPY.show}
                  </Button>
                ) : undefined
              }>
              {COPY.mayContainSecrets}
              {local || file.source === 'attachment' ? COPY.plain : COPY.viewOnMac}
            </InlineNotice>
          ) : !file.actions.preview ? (
            <InlineNotice>
              {file.refused?.preview ? describeFailure(403, file.refused.preview, { fallback: COPY.cannotPreview }) : COPY.unsupported}
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
                    <Loading label={COPY.reading} />
                  )
                ) : (
                  <TextPreview text={text} path={file.path} line={tab.target.line} lineRequest={tab.target} sensitive />
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
                  <Loading label={COPY.reading} />
                )
              ) : file.kind === 'html' && tab.target.line === undefined ? (
                <HtmlPreview
                  text={text}
                  path={file.path}
                  versionKey={`${file.etag}:${version}`}
                  local={local}
                  preferenceKey={deviceId ? `latch.html-scripts.${deviceId}.${contextKey}.${file.root}.${file.path}` : undefined}
                />
              ) : file.kind === 'markdown' && !sourceMode && tab.target.line === undefined ? (
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
                <TextPreview text={text} path={file.path} line={tab.target.line} lineRequest={tab.target} />
              )}
            </div>
          )}
        </ViewerActionsProvider>
      )}
    </section>
  )
}
