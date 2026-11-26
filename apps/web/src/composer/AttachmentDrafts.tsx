import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from 'react'
import type { AttachmentRef, FileMetadata } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  Hint,
  Icon,
  IconButton,
  InlineNotice,
  Loading,
  Menu as UiMenu,
  Modal,
  TextAreaField,
  CodeGlyph,
  FileGlyph,
  MoreGlyph,
  PlusGlyph,
  CloseGlyph,
} from '@latch/ui'
import { deliveryHint, draftSize, type AttachmentDraftController, type DraftAttachment } from '../hooks/useAttachments.ts'
import { AttachmentTile, draftDocumentKind, extOf, isMarkdownFile, tileType } from '../components/AttachmentTile.tsx'
import { FileSession } from '../components/FileChip.tsx'
import { MessageAttachment } from '../components/MessageAttachments.tsx'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import { PictureGroup, usePictureViewer } from '../components/PictureViewer.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'
import { DocumentPreview } from '../preview/DocumentPreview.tsx'
import { FileOpenContext } from '../preview/fileContext.ts'
import { FileSandbox } from '../preview/FileSandbox.tsx'
import { HighlightedCode } from '../preview/HighlightedCode.tsx'
import { languageForPath } from '../preview/highlight-protocol.ts'
import { MarkdownPreview } from '../preview/MarkdownPreview.tsx'
import { ViewerActionsProvider, useViewerActionsHost } from '../preview/viewerActions.tsx'

const PREVIEW_TEXT_BYTES = 256 * 1024

const COPY = defineCopy(
  {
    folderSettings: '文件夹请在 设置 › 项目 中添加。',
    checking: '正在确认能否添加附件…',
    unavailable: '暂时不能添加文件。',
    choose: '选择附件',
    more: '更多',
    addMenu: '添加文件…',
    add: '添加文件',
    pending: '等待这次提交完成',
    pastedText: '粘贴的文字',
    restoreText: '放回输入框',
    save: '保存附件',
    pastedCount: (count: number) => `已粘贴 ${formatNumber(count)} 字`,
    originalImage: (size: string) => `原图 ${size}`,
    shrinking: '缩小中',
    retrieving: '取回中',
    shrunk: (size: string) => `已缩小 · ${size}`,
    review: '确认内容…',
    retry: '重试上传',
    remove: (name: string) => `移除附件 ${name}`,
    attachments: '消息附件',
    possibleSecret: '这个附件可能包含密钥',
    confirmDetail: '确认后，附件内容会随消息发送给当前模型服务或 Harness。请先检查内容。',
    confirm: '确认添加',
    source: '源码',
    moreActions: '预览选项',
    reading: '正在读取内容…',
    readFailed: '无法读取这个附件的内容。',
    truncatedText: '文件较大，仅显示前 256 KB。',
    close: '关闭',
  },
  {
    folderSettings: 'Add folders in Settings › Projects.',
    checking: 'Checking whether you can add attachments…',
    unavailable: 'Files cannot be added right now.',
    choose: 'Choose attachments',
    more: 'More',
    addMenu: 'Add files…',
    add: 'Add files',
    pending: 'Wait for this submission',
    pastedText: 'Pasted text',
    restoreText: 'Return to input',
    save: 'Save attachment',
    pastedCount: (count: number) => plural(count, { one: 'Pasted {n} character', other: 'Pasted {n} characters' }),
    originalImage: (size: string) => `Original image ${size}`,
    shrinking: 'Resizing',
    retrieving: 'Retrieving',
    shrunk: (size: string) => `Resized · ${size}`,
    review: 'Review content…',
    retry: 'Retry upload',
    remove: (name: string) => `Remove attachment ${name}`,
    attachments: 'Message attachments',
    possibleSecret: 'This attachment may contain secrets',
    confirmDetail:
      'After you confirm, the attachment goes to the current model service or Harness with your message. Review its contents first.',
    confirm: 'Confirm attachment',
    source: 'Source',
    moreActions: 'Preview options',
    reading: 'Reading…',
    readFailed: 'Could not read this attachment.',
    truncatedText: 'Large file · Showing the first 256 KB.',
    close: 'Close',
  },
)

const uploadBytes = (value: number) =>
  value < 1024
    ? `${Math.round(value)} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`

export function decodePreviewBytes(bytes: ArrayBuffer, truncated = false): string {
  const head = new Uint8Array(bytes)
  const encoding = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8'
  const decoded = new TextDecoder(encoding).decode(bytes)
  // Slicing raw UTF-8 at 256 KiB can split a multi-byte character at the cut, leaving one trailing U+FFFD.
  return truncated && encoding === 'utf-8' && decoded.endsWith('\ufffd') ? decoded.slice(0, -1) : decoded
}

/** Whether a draft tile opens a preview: media, text, code, Markdown, CSV and Office/PDF documents. */
export function canPreviewDraft(input: {
  name: string
  mime?: string
  kind?: AttachmentRef['kind']
  size: number
  pastedText?: string
  status: DraftAttachment['status']
}): boolean {
  if (input.status !== 'ready' && input.status !== 'confirm') return false
  if (input.pastedText !== undefined) return true
  const type = tileType(input)
  if (['image', 'video', 'audio', 'text', 'code'].includes(type)) return true
  const doc = draftDocumentKind(input)
  if (!doc) return false
  return input.status === 'ready' || doc === 'csv'
}

/** A paste into the input: files become attachments, and so does a long text, as a file; the rest is the input's. */
export function pasteAttachments(event: ClipboardEvent, controller: AttachmentDraftController) {
  if (!event.clipboardData) return
  const files = [...event.clipboardData.files]
  if (files.length) {
    event.preventDefault()
    controller.add(files)
    return
  }
  const text = event.clipboardData.getData('text/plain')
  if (text.length > 2000) {
    event.preventDefault()
    controller.add([new File([text], 'pasted-text.txt', { type: 'text/plain' })], text)
  }
}
export function dropAttachments(event: DragEvent, controller: AttachmentDraftController) {
  if (![...event.dataTransfer.types].includes('Files')) return
  event.preventDefault()
  event.stopPropagation()
  controller.setDragging(false)
  if ([...event.dataTransfer.items].some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
    controller.setError(COPY.folderSettings)
    return
  }
  controller.add([...event.dataTransfer.files])
}
/** Why the button adds nothing now, or undefined when it can. */
export function attachmentBlock(controller: AttachmentDraftController): string | undefined {
  if (controller.caps?.images || controller.caps?.text || controller.caps?.files) return undefined
  if (controller.caps?.reason) return controller.caps.reason
  return controller.checking ? COPY.checking : COPY.unavailable
}

export function AttachmentButton({
  controller,
  disabled = false,
  sections,
}: {
  controller: AttachmentDraftController
  disabled?: boolean
  sections?: MenuSection[]
}) {
  const input = useRef<HTMLInputElement>(null)
  const blocked = attachmentBlock(controller)
  const pick = () => {
    if (blocked !== undefined) controller.explain(blocked, controller.caps?.reason === blocked ? controller.caps.reasonDetail : undefined)
    else input.current?.click()
  }
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={COPY.choose}
        onChange={event => {
          controller.add([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      {/* Not disabled when it cannot add: pressing it says why, where a touch screen has no hover to tell. */}
      {sections ? (
        <Menu
          label={COPY.more}
          placement="top-start"
          sections={[
            {
              id: 'attachments',
              items: [
                {
                  id: 'attach',
                  label: COPY.addMenu,
                  description: blocked,
                  leading: <Icon icon={FileGlyph} size={14} />,
                  onSelect: pick,
                },
              ],
            },
            ...sections,
          ]}
          trigger={props => <IconButton {...props} icon={PlusGlyph} label={COPY.more} disabled={disabled} className="attachment-button" />}
        />
      ) : (
        <IconButton
          icon={PlusGlyph}
          label={COPY.add}
          className="attachment-button"
          data-unavailable={blocked !== undefined && !disabled ? '' : undefined}
          disabled={disabled}
          tooltip={disabled ? COPY.pending : (blocked ?? COPY.add)}
          onClick={pick}
        />
      )}
    </>
  )
}

/**
 * Every composer preview shares the dimmed window stage (`picture-viewer`): media stands frameless in the middle, and
 * documents, Markdown, code and pasted text float as a clean reading sheet without a dialog header frame behind them.
 */
function DraftPreview({
  item,
  onClose,
  onReplace,
  onRestore,
  locked,
}: {
  item: DraftAttachment
  onClose(): void
  onReplace(text: string): void
  onRestore(text: string): void
  locked: boolean
}) {
  const mime = item.ref?.mime || item.file.type
  const type = tileType({ name: item.file.name, mime, ...(item.ref ? { kind: item.ref.kind } : {}) })
  const media = type === 'video' || type === 'audio'
  const pasted = item.pastedText !== undefined
  // A file flagged for secrets stays plain text and never enters a sandboxed frame or worker.
  const sensitive = item.status === 'confirm' || item.secretAcknowledged === true
  const docKind =
    !pasted && !media && !sensitive && item.status === 'ready'
      ? draftDocumentKind({ name: item.file.name, mime, size: item.file.size })
      : undefined
  const markdown = !pasted && !media && !docKind && isMarkdownFile({ name: item.file.name, mime })

  const [url, setUrl] = useState('')
  const [text, setText] = useState<string | undefined>(item.pastedText)
  const [readFailed, setReadFailed] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  const pressedStage = useRef(false)
  const viewer = useViewerActionsHost()

  useEffect(() => {
    setSourceMode(false)
  }, [item.key])

  useEffect(() => {
    if (!media) {
      setUrl('')
      return
    }
    const value = URL.createObjectURL(item.file)
    setUrl(value)
    return () => URL.revokeObjectURL(value)
  }, [item.file, media])

  useEffect(() => {
    if (item.pastedText !== undefined) {
      setText(item.pastedText)
      setReadFailed(false)
      return
    }
    if (media || docKind !== undefined) return
    let cancelled = false
    setText(undefined)
    setReadFailed(false)
    void item.file
      .slice(0, PREVIEW_TEXT_BYTES)
      .arrayBuffer()
      .then(
        bytes => {
          if (!cancelled) setText(decodePreviewBytes(bytes, item.file.size > PREVIEW_TEXT_BYTES))
        },
        () => {
          if (!cancelled) setReadFailed(true)
        },
      )
    return () => {
      cancelled = true
    }
  }, [item.file, item.pastedText, media, docKind])

  const docFile = useMemo<FileMetadata | undefined>(
    () =>
      docKind
        ? {
            handle: item.key,
            name: item.file.name,
            root: 'attachment',
            path: item.file.name,
            ext: extOf(item.file.name),
            kind: docKind,
            mime: mime || 'application/octet-stream',
            size: item.file.size,
            mtime: item.file.lastModified || 0,
            etag: `"${item.ref?.sha256.slice(0, 32) ?? item.key}"`,
            limit: item.file.size,
            secret: false,
            source: 'attachment',
            attachmentId: item.ref?.id ?? item.key,
            actions: { preview: true, download: false, reveal: false, quicklook: false, open: false },
          }
        : undefined,
    [docKind, item.file, item.key, item.ref, mime],
  )

  const readLocal = useCallback(
    async (start?: number, end?: number, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      const begin = start ?? 0
      const finish = end === undefined ? item.file.size : Math.min(item.file.size, end + 1)
      const bytes = await item.file.slice(begin, finish).arrayBuffer()
      signal?.throwIfAborted()
      return bytes
    },
    [item.file],
  )

  const onStagePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pressedStage.current = event.target === event.currentTarget
  }
  const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (pressedStage.current && event.target === event.currentTarget) onClose()
    pressedStage.current = false
  }

  const label = pasted ? COPY.pastedText : item.file.name
  const truncated = !pasted && !media && !docFile && item.file.size > PREVIEW_TEXT_BYTES
  const sourceToggle =
    viewer.source ?? (markdown && !sensitive ? { showing: sourceMode, onToggle: () => setSourceMode(value => !value) } : null)

  return (
    <Modal label={label} variant="dialog" onClose={onClose} className="picture-viewer attachment-preview">
      <div
        className="picture-viewer-frame"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Escape') event.stopPropagation()
        }}>
        {media ? (
          <div
            className="picture-viewer-stage attachment-preview-stage"
            data-media={type}
            tabIndex={-1}
            data-autofocus=""
            onPointerDown={onStagePointerDown}
            onClick={onStageClick}>
            {url && type === 'video' ? (
              <video className="attachment-preview-video-player" src={url} controls playsInline autoPlay />
            ) : url ? (
              <audio className="attachment-preview-audio-player" src={url} controls autoPlay />
            ) : null}
          </div>
        ) : (
          <div
            className="picture-viewer-stage attachment-preview-stage"
            data-sheet=""
            onPointerDown={onStagePointerDown}
            onClick={onStageClick}>
            <div
              className="attachment-preview-sheet"
              data-document={docFile ? '' : undefined}
              data-pasted={pasted ? '' : undefined}
              {...(pasted ? {} : { tabIndex: -1, 'data-autofocus': '' })}>
              {pasted ? (
                <>
                  <div className="attachment-preview-body">
                    <TextAreaField
                      label={COPY.pastedText}
                      value={text ?? ''}
                      maxLength={PREVIEW_TEXT_BYTES}
                      onChange={event => setText(event.target.value)}
                    />
                  </div>
                  <footer className="ui-modal-footer attachment-preview-footer">
                    <Button disabled={locked} onClick={() => onRestore(text ?? '')}>
                      {COPY.restoreText}
                    </Button>
                    <Button disabled={locked} variant="primary" onClick={() => onReplace(text ?? '')}>
                      {COPY.save}
                    </Button>
                  </footer>
                </>
              ) : docFile ? (
                <ViewerActionsProvider value={viewer.value}>
                  <DocumentPreview
                    file={docFile}
                    versionKey={item.key}
                    read={readLocal}
                    renderFrame={input => <FileSandbox {...input} />}
                  />
                </ViewerActionsProvider>
              ) : (
                <div className="attachment-preview-body">
                  {truncated && (
                    <p className="attachment-preview-note" role="status">
                      {COPY.truncatedText}
                    </p>
                  )}
                  {readFailed ? (
                    <InlineNotice tone="error">{COPY.readFailed}</InlineNotice>
                  ) : text === undefined ? (
                    <Loading label={COPY.reading} />
                  ) : markdown && !sensitive && !sourceMode ? (
                    <div className="attachment-preview-markdown">
                      <FileSession.Provider value={undefined}>
                        <FileOpenContext.Provider value={undefined}>
                          <MarkdownPreview text={text} path={item.file.name} renderFrame={input => <FileSandbox {...input} />} />
                        </FileOpenContext.Provider>
                      </FileSession.Provider>
                    </div>
                  ) : (
                    <pre className="attachment-preview-code">
                      <code>
                        <HighlightedCode code={text} language={languageForPath(item.file.name)} enabled={!sensitive} />
                      </code>
                    </pre>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="picture-viewer-actions">
          {sourceToggle && (
            <IconButton label={COPY.source} icon={CodeGlyph} size="md" pressed={sourceToggle.showing} onClick={sourceToggle.onToggle} />
          )}
          {viewer.menu.length > 0 && (
            <UiMenu
              label={COPY.moreActions}
              align="end"
              sections={[{ id: 'renderer', items: [...viewer.menu] }]}
              trigger={props => <IconButton {...props} label={COPY.moreActions} icon={MoreGlyph} size="md" />}
            />
          )}
          <IconButton label={COPY.close} icon={CloseGlyph} size="md" data-layer-close="" onClick={onClose} />
        </div>
      </div>
    </Modal>
  )
}

function RemoveAttachment({ name, locked, onRemove }: { name: string; locked: boolean; onRemove(): void }) {
  // A toolbar icon button grows on touch screens; this button sits in the corner of a 64px tile.
  return (
    <button
      type="button"
      className="attachment-remove"
      aria-label={COPY.remove(name)}
      title={COPY.remove(name)}
      disabled={locked}
      onClick={onRemove}>
      <Icon icon={CloseGlyph} size={12} />
    </button>
  )
}

/**
 * A compact tile of the file itself: a picture, a video's first frame with its play mark and length, a sound's length,
 * else its type and extension; the name under it, cut in the middle, and a round × on its corner. Progress and a
 * failure are on the tile; a failure says why under it, with what to do.
 */
function DraftAttachmentCard({
  item,
  controller,
  locked,
  onPreview,
  onConfirm,
}: {
  item: DraftAttachment
  controller: AttachmentDraftController
  locked: boolean
  onPreview(): void
  onConfirm(): void
}) {
  const name = item.pastedText === undefined ? item.file.name : COPY.pastedCount(item.pastedText.length)
  const mime = item.ref?.mime || item.file.type
  const type = tileType({ name: item.file.name, mime, ...(item.ref ? { kind: item.ref.kind } : {}) })
  const drawn = type === 'image' || type === 'video' || type === 'audio'
  const [url, setUrl] = useState<{ file: File; url: string }>()
  useEffect(() => {
    if (!drawn || !item.file.size) return
    const value = URL.createObjectURL(item.file)
    setUrl({ file: item.file, url: value })
    return () => URL.revokeObjectURL(value)
  }, [item.file, drawn])
  const failed = item.status === 'failed' || item.status === 'refused'
  const opens = canPreviewDraft({
    name: item.file.name,
    mime,
    ...(item.ref ? { kind: item.ref.kind } : {}),
    size: draftSize(item),
    ...(item.pastedText === undefined ? {} : { pastedText: item.pastedText }),
    status: item.status,
  })
  // A picture is looked at large the same way as one in a message (its own file, so nothing to download); the rest open
  // on the same dimmed stage in the composer's own preview.
  const face = useRef<HTMLButtonElement>(null)
  const picture = usePictureViewer(
    type === 'image' && opens && url?.file === item.file
      ? { url: url.url, name: item.file.name, download: false, element: () => face.current }
      : undefined,
  )
  const size = uploadBytes(draftSize(item))
  const hint = deliveryHint(item.ref, controller.caps)
  const title = [
    name,
    item.shrunkFrom === undefined ? size : `${COPY.shrunk(size)} · ${COPY.originalImage(uploadBytes(item.shrunkFrom))}`,
    hint,
  ]
    .filter(Boolean)
    .join(' · ')
  const state =
    item.status === 'uploading' ? (
      <span className="attachment-state" role="status">
        {item.shrink
          ? COPY.shrinking
          : item.source
            ? COPY.retrieving
            : `${uploadBytes(item.file.size * item.progress)} / ${uploadBytes(item.file.size)}`}
      </span>
    ) : failed ? (
      <span className="attachment-state" role="status">
        {item.error}
      </span>
    ) : item.status === 'ready' ? (
      <span
        className="attachment-state"
        role="status"
        title={item.shrunkFrom === undefined ? undefined : COPY.originalImage(uploadBytes(item.shrunkFrom))}>
        {item.shrunkFrom === undefined ? size : COPY.shrunk(size)}
      </span>
    ) : null
  return (
    <div
      className="attachment-draft"
      data-state={item.status}
      data-kind={type === 'image' ? 'image' : 'file'}
      data-delivery={hint ? 'path' : undefined}>
      <AttachmentTile
        ref={face}
        name={name}
        type={type}
        {...(url?.file === item.file ? { src: url.url } : {})}
        {...(item.status === 'uploading' ? (item.shrink || item.source ? { busy: true } : { progress: item.progress }) : {})}
        failed={failed}
        title={title}
        label={name}
        disabled={locked}
        {...(opens ? { onOpen: type === 'image' && url?.file === item.file ? picture.open : onPreview } : {})}
        corner={<RemoveAttachment name={item.file.name} locked={locked} onRemove={() => controller.remove(item.key)} />}
      />
      {state}
      {picture.viewer}
      {picture.menu}
      {(item.status === 'failed' || item.status === 'confirm') && (
        <Button
          className="attachment-retry"
          size="xs"
          disabled={locked}
          onClick={() => (item.status === 'confirm' ? onConfirm() : controller.retry(item.key))}>
          {item.status === 'confirm' ? COPY.review : COPY.retry}
        </Button>
      )}
    </div>
  )
}

export function AttachmentDrafts({
  controller,
  locked,
  onRestore,
  queued,
}: {
  controller: AttachmentDraftController
  locked: boolean
  onRestore(text: string): boolean
  queued?: { sessionId: string; refs: AttachmentRef[]; remove(id: string): void }
}) {
  const [preview, setPreview] = useState<string>(),
    [confirm, setConfirm] = useState<string>()
  const item = controller.items.find(item => item.key === preview)
  return (
    <>
      {controller.error && <InlineNotice tone="error">{controller.error}</InlineNotice>}
      {controller.note && !controller.error && (
        <InlineNotice>
          {/* The notice draws its own glyph: the Hint adds only its label and ⓘ. */}
          {controller.noteDetail ? (
            <Hint lead={<></>} label={controller.note}>
              {controller.noteDetail}
            </Hint>
          ) : (
            controller.note
          )}
        </InlineNotice>
      )}
      {controller.heldBack && <InlineNotice tone="warn">{controller.heldBack}</InlineNotice>}
      {(controller.items.length > 0 || !!queued?.refs.length) && (
        <div className="attachment-drafts" aria-label={COPY.attachments}>
          <PictureGroup>
            {queued?.refs.map(ref => (
              <MessageAttachment
                key={ref.id}
                attachment={ref}
                sessionId={queued.sessionId}
                corner={<RemoveAttachment name={ref.name} locked={locked} onRemove={() => queued.remove(ref.id)} />}
              />
            ))}
            {controller.items.map(item => (
              <DraftAttachmentCard
                key={item.key}
                item={item}
                controller={controller}
                locked={locked}
                onPreview={() => setPreview(item.key)}
                onConfirm={() => setConfirm(item.key)}
              />
            ))}
          </PictureGroup>
        </div>
      )}
      {item && (
        <DraftPreview
          key={item.key}
          item={item}
          locked={locked}
          onClose={() => setPreview(undefined)}
          onReplace={text => {
            controller.remove(item.key)
            controller.add([new File([text], 'pasted-text.txt', { type: 'text/plain' })], text)
            setPreview(undefined)
          }}
          onRestore={text => {
            if (!onRestore(text)) return
            controller.remove(item.key)
            setPreview(undefined)
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={COPY.possibleSecret}
          message={COPY.confirmDetail}
          confirmLabel={COPY.confirm}
          onClose={() => setConfirm(undefined)}
          onConfirm={async () => {
            controller.retry(confirm, true)
          }}
        />
      )}
    </>
  )
}
