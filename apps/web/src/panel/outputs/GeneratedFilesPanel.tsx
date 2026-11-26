import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileAudio, FileImage, FileVideo, LayoutGrid, List, Presentation, RotateCw, Sheet, Trash2 } from 'lucide-react'
import type {
  FileMention,
  Message,
  OutputsCleanupPreview,
  OutputsCleanupResult,
  SessionOutputFile,
  SessionOutputsList,
} from '@latch/protocol'
import {
  Button,
  Checkbox,
  ChevronDownGlyph,
  ChevronRightGlyph,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  GlobeGlyph,
  ICON_STROKE,
  Icon,
  IconButton,
  InlineNotice,
  Loading,
  PageGlyph,
  SegmentedControl,
  Tooltip,
  type IconComponent,
} from '@latch/ui'
import { VisibleText } from '../../components/VisibleText.tsx'
import { api, errorMessage, newRequestId } from '../../core/api.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'
import { resolveFileImage } from '../../preview/fileImages.ts'

export interface OutputsPanelTarget {
  turnId?: string
  messageId?: string
  nonce: number
}

const COPY = defineCopy(
  {
    region: '生成文件',
    loading: '正在读取生成文件…',
    readFailed: '读不到生成文件',
    retry: '重试',
    refresh: '刷新生成文件',
    listView: '列表视图',
    gridView: '缩略图网格',
    totalSummary: (count: number, size: string) => `${formatNumber(count)} 个文件${size ? ` · ${size}` : ''}`,
    allTurns: (count: number) => `全部 (${formatNumber(count)})`,
    singleTurn: (turnIndex: number, count: number) => `第 ${formatNumber(turnIndex)} 轮 (${formatNumber(count)})`,
    scopeLabel: '轮次范围',
    emptyTitle: '这一会话还没有生成文件',
    emptyDetail: '运行中生成的截图、报告或导出文档会汇总在这里，方便集中查看与一键清理。',
    allCleanedTitle: '生成的文件已全部清理',
    allCleanedDetail: (count: number) => `这个会话曾生成 ${formatNumber(count)} 个文件，当前都已从目录中移除。`,
    ignoredHeading: '临时产物',
    ignoredHint: '这些文件命中了项目的 .gitignore 规则，不会计入代码改动，适合在验证完成后一键清理。',
    projectHeading: '新建文件',
    plainHeading: '生成的文件',
    groupMeta: (count: number, size: string) => `${formatNumber(count)}${size ? ` · ${size}` : ''}`,
    cleanIgnored: (count: number) => `清理临时文件 (${formatNumber(count)})`,
    cleanFolder: '清理',
    cleanFolderLabel: (folder: string) => `清理目录 ${folder}`,
    selectFolder: (folder: string) => `选择目录 ${folder}`,
    selectFile: (path: string) => `选择 ${path}`,
    modifiedBadge: '已修改',
    modifiedHint: '生成后被改动过，自动清理会跳过此文件',
    turnBadge: (turnIndex: number) => `第 ${formatNumber(turnIndex)} 轮`,
    openFile: (name: string) => `打开 ${name}`,
    deleteOne: (name: string) => `删除 ${name}`,
    selectedSummary: (count: number, size: string) => `已选 ${formatNumber(count)} 项${size ? ` · ${size}` : ''}`,
    clearSelection: '取消',
    deleteSelected: (count: number) => `删除所选 (${formatNumber(count)})`,
    agentBusy: '会话运行中，结束后才能清理文件',
    offlineNote: '离线状态下无法清理文件',
    confirmTitle: (count: number) => `删除 ${formatNumber(count)} 个生成文件？`,
    confirmMessage: (count: number, size: string) =>
      `将永久删除 ${formatNumber(count)} 个由会话新建且未被再次修改的文件${size ? `（共 ${size}）` : ''}，空出的子目录会一并移除。此操作不可恢复。`,
    confirmNothing: '所选文件已不存在或已被修改，没有可删除的文件。',
    confirmUnignored: (count: number) => `包含 ${formatNumber(count)} 个未被 .gitignore 忽略的新建文件，删除后不会进入提交。`,
    confirmSkipped: (count: number) => `另有 ${formatNumber(count)} 个文件因生成后被修改或无法校验，将保持原样不删除。`,
    confirmMore: (count: number) => `另有 ${formatNumber(count)} 个文件未展开列出`,
    confirmAction: '永久删除',
    cleanedToast: (count: number) => `已清理 ${formatNumber(count)} 个生成文件`,
    cleanedWithSkipped: (removed: number, skipped: number) =>
      `已清理 ${formatNumber(removed)} 个文件，跳过 ${formatNumber(skipped)} 个已变化文件`,
  },
  {
    region: 'Generated files',
    loading: 'Loading generated files…',
    readFailed: 'Can’t read generated files',
    retry: 'Retry',
    refresh: 'Refresh generated files',
    listView: 'List view',
    gridView: 'Thumbnail grid',
    totalSummary: (count: number, size: string) => `${plural(count, { one: '{n} file', other: '{n} files' })}${size ? ` · ${size}` : ''}`,
    allTurns: (count: number) => `All (${formatNumber(count)})`,
    singleTurn: (turnIndex: number, count: number) => `Turn ${formatNumber(turnIndex)} (${formatNumber(count)})`,
    scopeLabel: 'Turn filter',
    emptyTitle: 'No generated files yet',
    emptyDetail: 'Screenshots, reports and documents created during runs appear here to preview or clean up in one place.',
    allCleanedTitle: 'All generated files cleaned up',
    allCleanedDetail: (count: number) =>
      plural(count, {
        one: '{n} generated file from this session has already been removed.',
        other: 'All {n} generated files from this session have been removed.',
      }),
    ignoredHeading: 'Temporary outputs',
    ignoredHint: 'Matched by .gitignore and excluded from code changes. Safe to clean up after verification.',
    projectHeading: 'New files',
    plainHeading: 'Generated files',
    groupMeta: (count: number, size: string) => `${formatNumber(count)}${size ? ` · ${size}` : ''}`,
    cleanIgnored: (count: number) => `Clean temporary (${formatNumber(count)})`,
    cleanFolder: 'Clean',
    cleanFolderLabel: (folder: string) => `Clean folder ${folder}`,
    selectFolder: (folder: string) => `Select folder ${folder}`,
    selectFile: (path: string) => `Select ${path}`,
    modifiedBadge: 'Modified',
    modifiedHint: 'Modified after creation; skipped by cleanup',
    turnBadge: (turnIndex: number) => `Turn ${formatNumber(turnIndex)}`,
    openFile: (name: string) => `Open ${name}`,
    deleteOne: (name: string) => `Delete ${name}`,
    selectedSummary: (count: number, size: string) =>
      `${plural(count, { one: '{n} selected', other: '{n} selected' })}${size ? ` · ${size}` : ''}`,
    clearSelection: 'Clear',
    deleteSelected: (count: number) => `Delete (${formatNumber(count)})`,
    agentBusy: 'Wait for the run to finish before cleaning up files',
    offlineNote: 'Offline · can’t clean up files',
    confirmTitle: (count: number) => plural(count, { one: 'Delete {n} generated file?', other: 'Delete {n} generated files?' }),
    confirmMessage: (count: number, size: string) =>
      `Permanently delete ${plural(count, { one: '{n} file', other: '{n} files' })}${size ? ` (${size})` : ''} created in this session and still unchanged. Empty subfolders will also be removed. This cannot be undone.`,
    confirmNothing: 'Selected files are already gone or were modified after creation.',
    confirmUnignored: (count: number) =>
      plural(count, {
        one: 'Includes {n} new file not ignored by .gitignore.',
        other: 'Includes {n} new files not ignored by .gitignore.',
      }),
    confirmSkipped: (count: number) =>
      plural(count, {
        one: '{n} file was modified or could not be verified and will be kept.',
        other: '{n} files were modified or could not be verified and will be kept.',
      }),
    confirmMore: (count: number) => plural(count, { one: '{n} more file', other: '{n} more files' }),
    confirmAction: 'Delete permanently',
    cleanedToast: (count: number) => plural(count, { one: 'Cleaned up {n} generated file', other: 'Cleaned up {n} generated files' }),
    cleanedWithSkipped: (removed: number, skipped: number) => `Cleaned up ${formatNumber(removed)}, kept ${formatNumber(skipped)} modified`,
  },
)

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

const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const fileKey = (file: Pick<FileMention, 'root' | 'path'>) => `${file.root}\n${file.path}`

const folderOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

function OutputVisual({ sessionId, file, large = false }: { sessionId: string; file: SessionOutputFile; large?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const key = `${sessionId}\n${file.root}\n${file.path}`
  const isImage = file.kind === 'image'
  const [value, setValue] = useState<{ key: string; url: string; width: number; height: number }>()
  const [failedKey, setFailedKey] = useState('')

  useEffect(() => {
    if (!isImage || !anchor.current) return
    const controller = new AbortController()
    let started = false
    const load = () => {
      if (started || controller.signal.aborted) return
      started = true
      observer?.disconnect()
      void resolveFileImage(sessionId, file.path, file.root, controller.signal).then(
        image => {
          if (!controller.signal.aborted) setValue({ key, ...image })
        },
        () => {
          if (!controller.signal.aborted) setFailedKey(key)
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
  }, [isImage, key, sessionId, file.path, file.root])

  const Glyph = KIND_ICONS[file.kind ?? ''] ?? PageGlyph
  if (!isImage || failedKey === key) {
    const extPos = file.path.lastIndexOf('.')
    const ext = extPos > file.path.lastIndexOf('/') ? file.path.slice(extPos + 1, extPos + 7).toUpperCase() : ''
    return (
      <span className={large ? 'outputs-card-media outputs-card-doc' : 'outputs-icon-tile'} aria-hidden="true">
        <Icon icon={Glyph} size={large ? 20 : 16} className="outputs-file-icon" />
        {large && ext && <span className="outputs-card-ext">{ext}</span>}
      </span>
    )
  }
  return (
    <span ref={anchor} className={large ? 'outputs-card-media' : 'outputs-thumb-tile'} aria-hidden="true">
      {value?.key === key ? (
        <img src={value.url} alt="" width={value.width} height={value.height} loading="lazy" onError={() => setFailedKey(key)} />
      ) : (
        <Icon icon={FileImage} size={large ? 20 : 16} className="outputs-file-icon" />
      )}
    </span>
  )
}

interface FolderBucket {
  folder: string
  files: SessionOutputFile[]
  removable: SessionOutputFile[]
  totalBytes: number
}

function groupByFolder(files: readonly SessionOutputFile[]): FolderBucket[] {
  const map = new Map<string, SessionOutputFile[]>()
  for (const file of files) {
    const dir = folderOf(file.path)
    const list = map.get(dir) ?? []
    list.push(file)
    map.set(dir, list)
  }
  return [...map.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([folder, items]) => ({
      folder,
      files: items.toSorted((a, b) => a.path.localeCompare(b.path)),
      removable: items.filter(item => item.removable),
      totalBytes: items.reduce((sum, item) => sum + (item.size ?? 0), 0),
    }))
}

export function GeneratedFilesPanel({
  sessionId,
  messages,
  revision,
  shown,
  active,
  canRun,
  offline,
  target,
  onOpenFile,
  onChanged,
  onToast,
}: {
  sessionId: string
  messages: readonly Message[]
  revision: string
  shown: boolean
  active: boolean
  canRun: boolean
  offline: boolean
  target?: OutputsPanelTarget | undefined
  onOpenFile: (file: FileMention) => void
  onChanged: () => Promise<void> | void
  onToast: (text: string, tone?: 'ok' | 'error') => void
}) {
  const [reloadNonce, setReloadNonce] = useState(0)
  const [state, setState] = useState<{ key: string; list?: SessionOutputsList; error?: unknown } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [turnScope, setTurnScope] = useState<'all' | 'focused'>('all')
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')
  const [focusedTurn, setFocusedTurn] = useState<{ turnIndex: number; turnId?: string; messageId?: string } | null>(null)
  const [dialog, setDialog] = useState<{
    wanted: FileMention[]
    preview: OutputsCleanupPreview
    unignoredCount: number
    requestId: string
  } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  const outputStamp = useMemo(() => messages.map(message => `${message.id}:${message.outputs?.length ?? 0}`).join(','), [messages])
  const fetchKey = `${sessionId}|${revision}|${outputStamp}|${reloadNonce}`

  useEffect(() => {
    if (!shown) return undefined
    const controller = new AbortController()
    void api<SessionOutputsList>(`tasks/${encodeURIComponent(sessionId)}/outputs`, { signal: controller.signal })
      .then(list => {
        if (!controller.signal.aborted) setState({ key: fetchKey, list })
      })
      .catch(error => {
        if (!controller.signal.aborted) setState({ key: fetchKey, error })
      })
    return () => {
      controller.abort()
    }
  }, [shown, sessionId, fetchKey])

  const allFiles = state?.list?.files ?? []
  const existingFiles = useMemo(() => allFiles.filter(file => file.exists), [allFiles])

  const appliedTargetNonce = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!target || appliedTargetNonce.current === target.nonce || !allFiles.length) return
    appliedTargetNonce.current = target.nonce
    const matched = allFiles.find(
      file => (target.messageId && file.messageId === target.messageId) || (target.turnId && file.turnId === target.turnId),
    )
    if (!matched) {
      setTurnScope('all')
      return
    }
    const distinctTurns = new Set(existingFiles.map(file => file.turnIndex))
    setFocusedTurn({
      turnIndex: matched.turnIndex,
      ...(matched.turnId ? { turnId: matched.turnId } : {}),
      messageId: matched.messageId,
    })
    setTurnScope(distinctTurns.size > 1 ? 'focused' : 'all')
  }, [target, allFiles, existingFiles])

  const scopedFiles = useMemo(() => {
    if (turnScope !== 'focused' || !focusedTurn) return existingFiles
    return existingFiles.filter(file => file.turnIndex === focusedTurn.turnIndex)
  }, [existingFiles, turnScope, focusedTurn])

  const validRemovableKeys = useMemo(() => new Set(scopedFiles.filter(file => file.removable).map(fileKey)), [scopedFiles])
  const activeSelected = useMemo(() => new Set([...selected].filter(key => validRemovableKeys.has(key))), [selected, validRemovableKeys])

  const ignoredFiles = useMemo(() => scopedFiles.filter(file => file.gitIgnored === true), [scopedFiles])
  const projectFiles = useMemo(() => scopedFiles.filter(file => !file.gitIgnored), [scopedFiles])
  const hasIgnoredSplit = ignoredFiles.length > 0
  const hasImages = useMemo(() => scopedFiles.some(file => file.kind === 'image'), [scopedFiles])
  const totalBytes = useMemo(() => scopedFiles.reduce((sum, file) => sum + (file.size ?? 0), 0), [scopedFiles])
  const removableIgnored = useMemo(() => ignoredFiles.filter(file => file.removable), [ignoredFiles])

  const writable = canRun && !offline && !active

  const openCleanupPreview = useCallback(
    async (targets: readonly SessionOutputFile[]) => {
      const removable = targets.filter(file => file.removable)
      if (!removable.length || previewBusy || !writable) return
      const wanted: FileMention[] = removable.map(file => ({ root: file.root, path: file.path }))
      const unignoredCount = removable.filter(file => !file.gitIgnored).length
      setPreviewBusy(true)
      try {
        const preview = await api<OutputsCleanupPreview>(`tasks/${encodeURIComponent(sessionId)}/outputs/cleanup/preview`, {
          method: 'POST',
          body: { files: wanted },
        })
        setDialog({
          wanted,
          preview,
          unignoredCount,
          requestId: newRequestId(),
        })
      } catch (error) {
        onToast(errorMessage(error), 'error')
      } finally {
        setPreviewBusy(false)
      }
    },
    [previewBusy, writable, sessionId, onToast],
  )

  const toggleKeys = (keys: readonly string[], check: boolean) => {
    setSelected(previous => {
      const next = new Set(previous)
      for (const key of keys) {
        if (check) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }

  const toggleFolderCollapse = (id: string) => {
    setCollapsedFolders(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedFiles = useMemo(() => scopedFiles.filter(file => activeSelected.has(fileKey(file))), [scopedFiles, activeSelected])
  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + (file.size ?? 0), 0), [selectedFiles])

  const focusedCount = useMemo(
    () => (focusedTurn ? existingFiles.filter(file => file.turnIndex === focusedTurn.turnIndex).length : 0),
    [existingFiles, focusedTurn],
  )

  const renderFiles = (items: readonly SessionOutputFile[], indented: boolean) => {
    if (viewMode === 'grid' && hasImages) {
      return (
        <ul className="outputs-grid" data-indented={indented ? '' : undefined}>
          {items.map(file => {
            const key = fileKey(file)
            const name = file.path.slice(file.path.lastIndexOf('/') + 1)
            const checked = activeSelected.has(key)
            const openTarget = () => onOpenFile({ root: file.root, path: file.path })
            return (
              <li key={key} className="outputs-card" data-checked={checked ? '' : undefined}>
                <div className="outputs-card-stage">
                  <button
                    type="button"
                    className="outputs-card-open"
                    aria-label={COPY.openFile(name)}
                    title={file.path}
                    onClick={openTarget}>
                    <OutputVisual sessionId={sessionId} file={file} large />
                  </button>
                  {writable && (
                    <span className="outputs-card-check">
                      <Checkbox
                        checked={checked}
                        disabled={!file.removable}
                        aria-label={COPY.selectFile(file.path)}
                        onChange={event => toggleKeys([key], event.currentTarget.checked)}
                      />
                    </span>
                  )}
                  {writable && file.removable && (
                    <span className="outputs-card-delete">
                      <IconButton
                        size="xs"
                        icon={Trash2}
                        label={COPY.deleteOne(name)}
                        disabled={previewBusy}
                        onClick={() => {
                          void openCleanupPreview([file])
                        }}
                      />
                    </span>
                  )}
                </div>
                <div className="outputs-card-foot">
                  <button type="button" className="outputs-file-title" title={file.path} onClick={openTarget}>
                    <VisibleText text={name} />
                  </button>
                  <span className="outputs-file-meta">
                    {[file.size !== undefined ? formatBytes(file.size) : '', COPY.turnBadge(file.turnIndex)].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )
    }

    return (
      <ul className="outputs-list" data-indented={indented ? '' : undefined}>
        {items.map(file => {
          const key = fileKey(file)
          const name = file.path.slice(file.path.lastIndexOf('/') + 1)
          const checked = activeSelected.has(key)
          const openTarget = () => onOpenFile({ root: file.root, path: file.path })
          const metaParts = [file.size !== undefined ? formatBytes(file.size) : '', COPY.turnBadge(file.turnIndex)].filter(Boolean)
          return (
            <li key={key} className="outputs-row" data-checked={checked ? '' : undefined}>
              {writable && (
                <Checkbox
                  checked={checked}
                  disabled={!file.removable}
                  aria-label={COPY.selectFile(file.path)}
                  onChange={event => toggleKeys([key], event.currentTarget.checked)}
                />
              )}
              <button type="button" className="outputs-row-hit" aria-label={COPY.openFile(name)} title={file.path} onClick={openTarget}>
                <OutputVisual sessionId={sessionId} file={file} />
                <span className="outputs-row-text">
                  <span className="outputs-row-title-line">
                    <span className="outputs-file-title">
                      <VisibleText text={name} />
                    </span>
                    {file.changedSince && (
                      <span className="outputs-file-modified" title={COPY.modifiedHint}>
                        {COPY.modifiedBadge}
                      </span>
                    )}
                  </span>
                  {metaParts.length > 0 && <span className="outputs-file-meta">{metaParts.join(' · ')}</span>}
                </span>
              </button>
              {writable && file.removable && (
                <span className="outputs-row-actions">
                  <IconButton
                    size="xs"
                    icon={Trash2}
                    label={COPY.deleteOne(name)}
                    disabled={previewBusy}
                    onClick={() => {
                      void openCleanupPreview([file])
                    }}
                  />
                </span>
              )}
            </li>
          )
        })}
      </ul>
    )
  }

  const renderSection = (sectionId: string, heading: string, sectionFiles: readonly SessionOutputFile[], badge?: ReactNode) => {
    if (!sectionFiles.length) return null
    const buckets = groupByFolder(sectionFiles)
    const sectionBytes = sectionFiles.reduce((sum, item) => sum + (item.size ?? 0), 0)
    return (
      <section className="outputs-group" aria-label={heading}>
        <header className="outputs-group-head">
          <h3 className="outputs-group-title">{heading}</h3>
          {badge}
          <span className="outputs-group-count">{COPY.groupMeta(sectionFiles.length, formatBytes(sectionBytes))}</span>
        </header>
        <div className="outputs-buckets">
          {buckets.map(bucket => {
            if (!bucket.folder) {
              return <div key={`${sectionId}:root`}>{renderFiles(bucket.files, false)}</div>
            }
            const collapseKey = `${sectionId}:${bucket.folder}`
            const collapsed = collapsedFolders.has(collapseKey)
            const bucketKeys = bucket.removable.map(fileKey)
            const checkedCount = bucketKeys.filter(key => activeSelected.has(key)).length
            const allChecked = bucketKeys.length > 0 && checkedCount === bucketKeys.length
            const displayFolder = `${bucket.folder}/`
            return (
              <div key={collapseKey} className="outputs-bucket">
                <div className="outputs-dir-row">
                  {writable && bucketKeys.length > 0 && (
                    <Checkbox
                      checked={allChecked}
                      aria-label={COPY.selectFolder(bucket.folder)}
                      onChange={event => toggleKeys(bucketKeys, event.currentTarget.checked)}
                    />
                  )}
                  <button
                    type="button"
                    className="outputs-dir-toggle"
                    aria-expanded={!collapsed}
                    onClick={() => toggleFolderCollapse(collapseKey)}>
                    {collapsed ? (
                      <ChevronRightGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                    ) : (
                      <ChevronDownGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                    )}
                    <span className="outputs-dir-path" title={bucket.folder}>
                      <VisibleText text={displayFolder} />
                    </span>
                    <span className="outputs-dir-count">{formatNumber(bucket.files.length)}</span>
                  </button>
                  {writable && bucket.removable.length > 0 && (
                    <button
                      type="button"
                      className="outputs-dir-clean"
                      aria-label={COPY.cleanFolderLabel(bucket.folder)}
                      disabled={previewBusy}
                      onClick={() => {
                        void openCleanupPreview(bucket.removable)
                      }}>
                      {COPY.cleanFolder}
                    </button>
                  )}
                </div>
                {!collapsed && renderFiles(bucket.files, true)}
              </div>
            )
          })}
        </div>
      </section>
    )
  }

  return (
    <div className="outputs-panel" role="region" aria-label={COPY.region}>
      <header className="outputs-bar">
        {focusedTurn && existingFiles.length > 0 && focusedCount > 0 && focusedCount < existingFiles.length ? (
          <SegmentedControl
            size="sm"
            label={COPY.scopeLabel}
            value={turnScope}
            options={[
              { value: 'all', label: COPY.allTurns(existingFiles.length) },
              { value: 'focused', label: COPY.singleTurn(focusedTurn.turnIndex, focusedCount) },
            ]}
            onValueChange={setTurnScope}
          />
        ) : (
          <span className="outputs-bar-summary">
            {scopedFiles.length > 0 ? COPY.totalSummary(scopedFiles.length, formatBytes(totalBytes)) : COPY.region}
          </span>
        )}
        <span className="outputs-bar-space" />
        {writable && removableIgnored.length > 0 && activeSelected.size === 0 && (
          <Button
            size="xs"
            variant="secondary"
            loading={previewBusy}
            onClick={() => {
              void openCleanupPreview(removableIgnored)
            }}>
            {COPY.cleanIgnored(removableIgnored.length)}
          </Button>
        )}
        {hasImages && scopedFiles.length > 0 && (
          <IconButton
            size="xs"
            icon={viewMode === 'list' ? LayoutGrid : List}
            label={viewMode === 'list' ? COPY.gridView : COPY.listView}
            onClick={() => setViewMode(mode => (mode === 'list' ? 'grid' : 'list'))}
          />
        )}
        <IconButton
          size="xs"
          icon={RotateCw}
          label={COPY.refresh}
          onClick={() => {
            setReloadNonce(value => value + 1)
          }}
        />
      </header>

      {canRun && active && existingFiles.length > 0 && (
        <div className="outputs-notice-row">
          <InlineNotice tone="neutral">{COPY.agentBusy}</InlineNotice>
        </div>
      )}
      {canRun && offline && existingFiles.length > 0 && (
        <div className="outputs-notice-row">
          <InlineNotice tone="warn">{COPY.offlineNote}</InlineNotice>
        </div>
      )}

      {activeSelected.size > 0 && writable && (
        <div className="outputs-selection-bar">
          <span className="outputs-selection-text">{COPY.selectedSummary(activeSelected.size, formatBytes(selectedBytes))}</span>
          <span className="outputs-bar-space" />
          <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
            {COPY.clearSelection}
          </Button>
          <Button
            size="xs"
            variant="destroy"
            loading={previewBusy}
            onClick={() => {
              void openCleanupPreview(selectedFiles)
            }}>
            {COPY.deleteSelected(activeSelected.size)}
          </Button>
        </div>
      )}

      <div className="outputs-body">
        {!state ? (
          <Loading label={COPY.loading} />
        ) : state.error ? (
          <ErrorState
            title={COPY.readFailed}
            description={errorMessage(state.error)}
            actions={
              <Button size="xs" onClick={() => setReloadNonce(value => value + 1)}>
                {COPY.retry}
              </Button>
            }
          />
        ) : allFiles.length === 0 ? (
          <EmptyState title={COPY.emptyTitle} description={COPY.emptyDetail} />
        ) : existingFiles.length === 0 ? (
          <EmptyState title={COPY.allCleanedTitle} description={COPY.allCleanedDetail(allFiles.length)} />
        ) : hasIgnoredSplit ? (
          <>
            {renderSection(
              'ignored',
              COPY.ignoredHeading,
              ignoredFiles,
              <Tooltip content={COPY.ignoredHint}>
                <code className="outputs-group-tag" tabIndex={0}>
                  .gitignore
                </code>
              </Tooltip>,
            )}
            {renderSection('project', COPY.projectHeading, projectFiles)}
          </>
        ) : (
          renderSection('plain', COPY.plainHeading, scopedFiles)
        )}
      </div>

      {dialog && (
        <ConfirmDialog
          title={COPY.confirmTitle(dialog.preview.remove)}
          message={
            dialog.preview.remove > 0 ? COPY.confirmMessage(dialog.preview.remove, formatBytes(dialog.preview.bytes)) : COPY.confirmNothing
          }
          confirmLabel={COPY.confirmAction}
          danger
          extra={
            <div className="outputs-confirm-extra">
              {dialog.unignoredCount > 0 && dialog.preview.remove > 0 && (
                <InlineNotice tone="warn">{COPY.confirmUnignored(dialog.unignoredCount)}</InlineNotice>
              )}
              {dialog.preview.skipped > 0 && <p className="outputs-confirm-note">{COPY.confirmSkipped(dialog.preview.skipped)}</p>}
              {dialog.preview.removes.length > 0 && (
                <ul className="outputs-confirm-paths">
                  {dialog.preview.removes.slice(0, 12).map(item => (
                    <li key={fileKey(item)}>
                      <VisibleText text={item.path} />
                    </li>
                  ))}
                  {dialog.preview.remove > 12 && <li className="outputs-confirm-more">{COPY.confirmMore(dialog.preview.remove - 12)}</li>}
                </ul>
              )}
            </div>
          }
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            if (dialog.preview.remove === 0) return
            const answer = await api<OutputsCleanupResult>(`tasks/${encodeURIComponent(sessionId)}/outputs/cleanup`, {
              method: 'POST',
              body: {
                files: dialog.wanted,
                confirm: dialog.preview.planHash,
                requestId: dialog.requestId,
              },
            })
            setSelected(new Set())
            setReloadNonce(value => value + 1)
            await onChanged()
            onToast(answer.skipped > 0 ? COPY.cleanedWithSkipped(answer.removed, answer.skipped) : COPY.cleanedToast(answer.removed), 'ok')
          }}
        />
      )}
    </div>
  )
}
