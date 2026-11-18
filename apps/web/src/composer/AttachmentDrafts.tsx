import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { Image } from 'lucide-react'
import {
  Button,
  ConfirmDialog,
  Hint,
  Icon,
  IconButton,
  InlineNotice,
  Modal,
  ModalHeader,
  Spinner,
  TextAreaField,
  FileGlyph,
  PlusGlyph,
  CloseGlyph,
} from '@latch/ui'
import { draftSize, type AttachmentDraftController, type DraftAttachment } from '../hooks/useAttachments.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'

const COPY = defineCopy(
  {
    folderSettings: '文件夹请在 设置 › 项目 中添加。',
    checking: '正在确认这个 Harness 能否接收文件…',
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
  },
  {
    folderSettings: 'Add folders in Settings › Projects.',
    checking: 'Checking whether this Harness accepts files…',
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
  },
)

const uploadBytes = (value: number) =>
  value < 1024
    ? `${Math.round(value)} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`

export function pasteAttachments(event: ClipboardEvent<HTMLTextAreaElement>, controller: AttachmentDraftController) {
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
  if (controller.caps?.images || controller.caps?.text) return undefined
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
function DraftPreview({
  item,
  onClose,
  onReplace,
  onRestore,
}: {
  item: DraftAttachment
  onClose(): void
  onReplace(text: string): void
  onRestore(text: string): void
}) {
  const [url, setUrl] = useState(''),
    [text, setText] = useState(item.pastedText ?? '')
  useEffect(() => {
    if (item.ref?.kind === 'image') {
      const value = URL.createObjectURL(item.file)
      setUrl(value)
      return () => URL.revokeObjectURL(value)
    }
    if (item.pastedText === undefined)
      void item.file
        .slice(0, 256 * 1024)
        .text()
        .then(setText)
  }, [item.file, item.ref?.kind])
  return (
    <Modal label={item.file.name} variant="dialog" onClose={onClose} className="attachment-preview">
      <ModalHeader title={item.file.name} onClose={onClose} />
      <div className="ui-modal-body">
        {url ? (
          <img src={url} alt={item.file.name} />
        ) : item.pastedText !== undefined ? (
          <TextAreaField label={COPY.pastedText} value={text} maxLength={256 * 1024} onChange={event => setText(event.target.value)} />
        ) : (
          <pre>
            <VisibleText text={text} />
          </pre>
        )}
      </div>
      {item.pastedText !== undefined && (
        <footer className="ui-modal-footer">
          <Button onClick={() => onRestore(text)}>{COPY.restoreText}</Button>
          <Button variant="primary" onClick={() => onReplace(text)}>
            {COPY.save}
          </Button>
        </footer>
      )}
    </Modal>
  )
}

/** An image is a thumbnail; any other attachment is a chip one line high: its glyph, name, size and ×. */
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
  const image = item.ref?.kind === 'image'
  const [picture, setPicture] = useState<{ file: File; url: string }>()
  useEffect(() => {
    if (!image) return
    const url = URL.createObjectURL(item.file)
    setPicture({ file: item.file, url })
    return () => URL.revokeObjectURL(url)
  }, [item.file, image])
  const name = item.pastedText === undefined ? item.file.name : COPY.pastedCount(item.pastedText.length)
  const status = (
    <span
      className="attachment-state"
      role="status"
      title={item.shrunkFrom === undefined ? undefined : COPY.originalImage(uploadBytes(item.shrunkFrom))}>
      {item.status === 'uploading' && item.shrink ? (
        <>
          <Spinner size={12} />
          {COPY.shrinking}
        </>
      ) : item.status === 'uploading' ? (
        <>
          <Spinner size={12} />
          {item.source ? COPY.retrieving : `${uploadBytes(item.file.size * item.progress)} / ${uploadBytes(item.file.size)}`}
        </>
      ) : item.status === 'ready' ? (
        item.shrunkFrom === undefined ? (
          `${Math.ceil(draftSize(item) / 1024)} KB`
        ) : (
          COPY.shrunk(uploadBytes(item.file.size))
        )
      ) : (
        item.error
      )}
    </span>
  )
  const content = image ? (
    picture?.file === item.file ? (
      <img src={picture.url} alt="" decoding="async" />
    ) : (
      <Icon icon={Image} size={20} />
    )
  ) : (
    <>
      <span className="attachment-file-icon">
        <Icon icon={FileGlyph} size={14} />
      </span>
      <span className="attachment-file-copy">
        <span className="attachment-name">
          <VisibleText text={name} />
        </span>
        {status}
      </span>
    </>
  )
  return (
    <div className="attachment-draft" data-state={item.status} data-kind={image ? 'image' : 'file'}>
      {item.status === 'ready' || item.status === 'confirm' ? (
        <Button variant="ghost" size="sm" className="attachment-draft-open" aria-label={name} disabled={locked} onClick={onPreview}>
          {content}
        </Button>
      ) : (
        <div className="attachment-draft-open">{content}</div>
      )}
      {image && (item.status !== 'ready' || item.shrunkFrom !== undefined) && status}
      {(item.status === 'failed' || item.status === 'confirm') && (
        <Button
          className="attachment-retry"
          size="xs"
          disabled={locked}
          onClick={() => (item.status === 'confirm' ? onConfirm() : controller.retry(item.key))}>
          {item.status === 'confirm' ? COPY.review : COPY.retry}
        </Button>
      )}
      <IconButton
        label={COPY.remove(item.file.name)}
        icon={CloseGlyph}
        {...(image ? {} : { size: 'xs' as const })}
        disabled={locked}
        className="attachment-remove"
        onClick={() => controller.remove(item.key)}
      />
    </div>
  )
}

export function AttachmentDrafts({
  controller,
  locked,
  onRestore,
}: {
  controller: AttachmentDraftController
  locked: boolean
  onRestore(text: string): void
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
      {controller.items.length > 0 && (
        <div className="attachment-drafts" aria-label={COPY.attachments}>
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
        </div>
      )}
      {item && (
        <DraftPreview
          key={item.key}
          item={item}
          onClose={() => setPreview(undefined)}
          onReplace={text => {
            controller.remove(item.key)
            controller.add([new File([text], 'pasted-text.txt', { type: 'text/plain' })], text)
            setPreview(undefined)
          }}
          onRestore={text => {
            controller.remove(item.key)
            onRestore(text)
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
