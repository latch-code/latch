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
import { attachmentLimits, type AttachmentDraftController, type DraftAttachment } from '../hooks/useAttachments.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { Menu, type MenuSection } from '../components/overlays.tsx'

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
    controller.setError('文件夹请在 设置 › 项目 中添加。')
    return
  }
  controller.add([...event.dataTransfer.files])
}
/** Why the button adds nothing now, or undefined when it can. */
export function attachmentBlock(controller: AttachmentDraftController): string | undefined {
  if (controller.caps?.images || controller.caps?.text) return undefined
  if (controller.caps?.reason) return controller.caps.reason
  return controller.checking ? '正在确认这个 Harness 能否接收文件…' : '暂时不能添加文件。'
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
  const limits = attachmentLimits(controller.caps)
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
        aria-label="选择附件"
        onChange={event => {
          controller.add([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      {/* Not disabled when it cannot add: pressing it says why, where a touch screen has no hover to tell. */}
      {sections ? (
        <Menu
          label="更多"
          placement="top-start"
          sections={[
            {
              id: 'attachments',
              items: [
                {
                  id: 'attach',
                  label: '添加文件…',
                  description: blocked ?? limits,
                  leading: <Icon icon={FileGlyph} size={14} />,
                  onSelect: pick,
                },
              ],
            },
            ...sections,
          ]}
          trigger={props => <IconButton {...props} icon={PlusGlyph} label="更多" disabled={disabled} className="attachment-button" />}
        />
      ) : (
        <IconButton
          icon={PlusGlyph}
          label="添加文件…"
          className="attachment-button"
          data-unavailable={blocked !== undefined && !disabled ? '' : undefined}
          disabled={disabled}
          tooltip={disabled ? '等待这次提交完成' : (blocked ?? (limits ? `添加文件… · ${limits}` : '添加文件…'))}
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
          <TextAreaField label="粘贴的文字" value={text} maxLength={256 * 1024} onChange={event => setText(event.target.value)} />
        ) : (
          <pre>
            <VisibleText text={text} />
          </pre>
        )}
      </div>
      {item.pastedText !== undefined && (
        <footer className="ui-modal-footer">
          <Button onClick={() => onRestore(text)}>放回输入框</Button>
          <Button variant="primary" onClick={() => onReplace(text)}>
            保存附件
          </Button>
        </footer>
      )}
    </Modal>
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
        <div className="attachment-drafts" aria-label="消息附件">
          {controller.items.map(item => (
            <div key={item.key} className="attachment-draft" data-state={item.status}>
              <Button
                variant="ghost"
                size="sm"
                disabled={locked || (item.status !== 'ready' && item.status !== 'confirm')}
                onClick={() => setPreview(item.key)}>
                <Icon icon={item.ref?.kind === 'image' ? Image : FileGlyph} size={14} />
                <span className="attachment-name">
                  <VisibleText
                    text={item.pastedText === undefined ? item.file.name : `已粘贴 ${item.pastedText.length.toLocaleString()} 字`}
                  />
                </span>
              </Button>
              <span className="attachment-state" role="status">
                {item.status === 'uploading' ? (
                  <>
                    <Spinner size={12} />
                    {`${uploadBytes(item.file.size * item.progress)} / ${uploadBytes(item.file.size)}`}
                  </>
                ) : item.status === 'ready' ? (
                  `${Math.ceil(item.file.size / 1024)} KB`
                ) : (
                  item.error
                )}
              </span>
              {/* A refusal stays a refusal: only removing the file helps. */}
              {(item.status === 'failed' || item.status === 'confirm') && (
                <Button
                  size="xs"
                  disabled={locked}
                  onClick={() => (item.status === 'confirm' ? setConfirm(item.key) : controller.retry(item.key))}>
                  {item.status === 'confirm' ? '确认内容…' : '重试上传'}
                </Button>
              )}
              <IconButton
                label={`移除附件 ${item.file.name}`}
                icon={CloseGlyph}
                disabled={locked}
                onClick={() => controller.remove(item.key)}
              />
            </div>
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
          title="这个附件可能包含密钥"
          message="确认后，附件内容会随消息发送给当前模型服务或 Harness。请先检查内容。"
          confirmLabel="确认添加"
          onClose={() => setConfirm(undefined)}
          onConfirm={async () => {
            controller.retry(confirm, true)
          }}
        />
      )}
    </>
  )
}
