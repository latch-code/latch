import { FileOpenContext } from '../preview/fileContext.ts'
import { createContext, useContext, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { AppWindow } from 'lucide-react'
import {
  Hint,
  Icon,
  Menu,
  MenuFooterNote,
  Swap,
  Tooltip,
  type IconComponent,
  type MenuItem,
  type MenuSection,
  type MenuTriggerProps,
  useCopy,
  CheckGlyph,
  AlertGlyph,
  CodeGlyph,
  CopyGlyph,
  EyeGlyph,
  FolderOpenGlyph,
  InfoGlyph,
  LockGlyph,
} from '@latch/ui'
import { FILE_COPY, fileNote, type FileNote } from '../core/securityCopy.ts'
import { currentShell, revealLabel, shellFiles, type FileActionResult, type FileInspection, type ShellFiles } from '../core/shell.ts'
import { absoluteReference, referenceIcon, referenceName, splitPath } from '../fileReference.ts'
import { editorLabel, openInEditor, useEditors } from './OpenInEditor.tsx'

/** The session whose replies are shown and its folder: the desktop app asks about a file of that session. */
export interface FileSessionInfo {
  id: string
  /** The session's working directory, which relative references start from. */
  folder?: string
  folders?: Array<{ id: string; path: string }>
}
export const FileRootContext = createContext<string | undefined>(undefined)
export const FileSession = createContext<FileSessionInfo | undefined>(undefined)

/** How long the desktop menu waits for the Host's answer before it opens with 「正在检查…」. */
const INSPECT_WAIT_MS = 400
const TONE_ICON: Record<FileNote['tone'], IconComponent> = { lock: LockGlyph, info: InfoGlyph, alert: AlertGlyph }

interface ChipProps {
  /** The reference as the reader sees it (what the Host is asked about). */
  path: string
  rootId?: string
  onPreview?: () => void
  actionPath?: string
  /** The link's own text; the path when there is none. */
  label?: ReactNode
  /** `![](…)`: the chip starts with 「图片」. */
  image?: boolean
  /** An image's description: it leads the chip, the file name follows it, quieter. */
  alt?: string
  /** The label is the path or its file name, so it is set in the mono face and keeps the file name whole. */
  mono?: boolean
}

/**
 * A file a reply refers to. It never navigates the page; a click opens a small menu named after the file. In the
 * desktop app the menu lists what the Host allows for that file (快速查看, 用默认应用打开, 在访达中显示) and 复制路径;
 * elsewhere it offers 复制路径 and says where the file can be opened.
 */
export function FileChip(props: ChipProps) {
  const session = useContext(FileSession)
  const files = shellFiles()
  const open = useContext(FileOpenContext)
  const rootId = useContext(FileRootContext)
  const position = /(?::([1-9]\d*)(?::\d+)?|#L([1-9]\d*)(?:C\d+)?)$/u.exec(props.path)
  const line = position ? Math.min(10_000_000, Number(position[1] ?? position[2])) : undefined
  const preview =
    open && session
      ? () =>
          open({
            sessionId: session.id,
            reference: props.path,
            ...(line ? { line } : {}),
            ...((props.rootId ?? rootId) ? { rootId: props.rootId ?? rootId } : {}),
          })
      : undefined
  const selectedRoot = props.rootId ?? rootId
  const folder = selectedRoot
    ? (session?.folders?.find(folder => folder.id === selectedRoot)?.path ?? (selectedRoot === 'default' ? session?.folder : undefined))
    : session?.folder
  const nativePath = folder ? absoluteReference(props.path, folder) : props.path
  return files && session && (!selectedRoot || folder) ? (
    <DesktopFileChip
      {...props}
      label={props.label ?? props.path}
      actionPath={nativePath}
      onPreview={preview}
      {...(line ? { line } : {})}
      files={files}
      session={session}
    />
  ) : (
    <CopyFileChip {...props} onPreview={preview} />
  )
}

/** A path label: the folders shrink with an ellipsis, the file name stays whole. */
function PathText({ text }: { text: string }) {
  const [folders, name] = splitPath(text)
  return folders ? (
    <span className="file-chip-text file-chip-path" data-mono="">
      <span className="file-chip-folders">{folders}</span>
      <span className="file-chip-name">{name}</span>
    </span>
  ) : (
    <span className="file-chip-text" data-mono="">
      {text}
    </span>
  )
}

function ChipBody({ path, label, image, alt, mono = true, icon }: ChipProps & { icon: ReactNode }) {
  const name = referenceName(path)
  const described = image === true && alt !== undefined && alt !== name
  const text = label === undefined ? path : typeof label === 'string' ? label : undefined
  return (
    <>
      {icon}
      {image && <span className="file-chip-prefix">{FILE_COPY.image}</span>}
      {described ? (
        <>
          <span className="file-chip-text">{alt}</span>
          <span className="file-chip-meta" data-mono="">
            {name}
          </span>
        </>
      ) : mono && text !== undefined ? (
        <PathText text={text} />
      ) : (
        <span className="file-chip-text" data-mono={mono ? '' : undefined}>
          {label ?? path}
        </span>
      )}
    </>
  )
}

const spoken = ({ path, image, alt }: ChipProps) =>
  image ? `${FILE_COPY.image}${alt && alt !== referenceName(path) ? `「${alt}」` : ''}：${path}` : path

function CopyStatus({ state }: { state: 'idle' | 'copied' | 'failed' }) {
  return (
    <span className="sr-only" role="status">
      {state === 'copied' ? FILE_COPY.copiedPath : state === 'failed' ? FILE_COPY.copyFailed : ''}
    </span>
  )
}

const copySection = (onCopy: () => void): MenuSection => ({
  id: 'copy',
  items: [{ id: 'copy', label: FILE_COPY.copy, icon: CopyGlyph, onSelect: onCopy }],
})

interface ChipMenuProps extends ChipProps {
  name: string
  checking?: boolean
  sections: MenuSection[]
  note?: FileNote
  copied: boolean
  /** A press of the chip while its menu is closed; the default opens it. */
  onOpen?: (menu: MenuTriggerProps) => void
  triggerRef?: MutableRefObject<MenuTriggerProps | null>
}

/** The chip and its menu, 「文件：deck.pptx」: the header names the file, the foot says why something is not offered or where it is. */
function ChipMenu({ name, checking = false, sections, note, copied, onOpen, triggerRef, ...props }: ChipMenuProps) {
  return (
    <Menu
      label="文件"
      header={{ title: name, ...(checking ? { meta: FILE_COPY.checking } : {}) }}
      sections={sections}
      footer={
        note?.detail ? (
          <Hint className="file-chip-note" lead={<Icon icon={TONE_ICON[note.tone]} size={12} />} label={note.text}>
            {note.detail}
          </Hint>
        ) : note ? (
          <MenuFooterNote icon={TONE_ICON[note.tone]}>{note.text}</MenuFooterNote>
        ) : undefined
      }
      width={260}
      trigger={menu => {
        if (triggerRef) triggerRef.current = menu
        const open = () => {
          if (onOpen) onOpen(menu)
          else menu.onClick()
        }
        return (
          <Tooltip content={<span className="file-chip-tip-path">{props.path}</span>}>
            <button
              ref={menu.ref}
              type="button"
              className="file-chip"
              data-file-chip=""
              aria-haspopup={menu['aria-haspopup']}
              aria-expanded={menu['aria-expanded']}
              aria-label={props.onPreview ? `预览文件：${spoken(props)}` : spoken(props)}
              onKeyDown={event => {
                if (event.key !== 'ArrowDown' || menu['aria-expanded']) return
                event.preventDefault()
                open()
              }}
              onContextMenu={event => {
                if (!props.onPreview) return
                event.preventDefault()
                if (!menu['aria-expanded']) open()
              }}
              onClick={event => {
                if (props.onPreview) {
                  if (event.detail <= 1) props.onPreview()
                  return
                }
                // The second click of a double click (Finder's way to open a file) neither closes the menu nor asks again.
                if (event.detail > 1) return
                if (menu['aria-expanded']) menu.onClick()
                else open()
              }}>
              <ChipBody
                {...props}
                icon={
                  <Swap value={copied} className="file-chip-icon">
                    <Icon icon={copied ? CheckGlyph : referenceIcon(props.path)} size={12} />
                  </Swap>
                }
              />
            </button>
          </Tooltip>
        )
      }}
    />
  )
}

/** Phones, other computers and the browser: the menu copies the path and says where the file can be opened. */
function CopyFileChip(props: ChipProps) {
  const { state, copy } = useCopy()
  // A desktop shell from before file actions can do it once it is restarted; another computer's page never has them.
  const shell = currentShell()
  const outdated = shell !== null && shell.remote !== true && shellFiles() === null
  return (
    <>
      <ChipMenu
        {...props}
        name={referenceName(props.path)}
        copied={state === 'copied'}
        sections={[
          copySection(() => {
            void copy(props.path)
          }),
        ]}
        note={outdated ? { text: FILE_COPY.shellOutdated, tone: 'info' } : { text: FILE_COPY.elsewhere(), tone: 'lock' }}
      />
      <CopyStatus state={state} />
    </>
  )
}

type Action = 'quickLook' | 'open' | 'reveal' | 'editor'

/** One line at the foot of the menu saying why something is not offered, or what went wrong. */
function noteOf(inspection: FileInspection | undefined, context: { name: string; platform?: string }): FileNote | undefined {
  if (!inspection) return undefined
  if (inspection.status === 'busy') return fileNote('busy')
  if (inspection.status !== 'ok') return fileNote(inspection.code, context)
  const { quickLook, open } = inspection.refused ?? {}
  // A type Quick Look does not take but the default app does (YAML) needs no word: the item is simply absent. Office
  // documents and Markdown say why they are not previewed yet.
  if (open === undefined) return quickLook === 'file-preview-unverified' ? fileNote(quickLook, context) : undefined
  if (open === 'unsupported' && (quickLook === undefined || quickLook === 'unsupported')) return undefined
  return fileNote(open, context)
}

function DesktopFileChip({ files, session, line, ...props }: ChipProps & { files: ShellFiles; session: FileSessionInfo; line?: number }) {
  const { state, copy } = useCopy()
  const editors = useEditors()
  const [inspection, setInspection] = useState<FileInspection | undefined>()
  const [outcome, setOutcome] = useState<FileNote | undefined>()
  const asking = useRef(false)
  const request = useRef(0)
  const trigger = useRef<MenuTriggerProps | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const platform = currentShell()?.platform
  const name = inspection?.status === 'ok' && inspection.name ? inspection.name : referenceName(props.path)
  const context = { name, ...(platform ? { platform } : {}) }

  /** Asks main before the menu opens, so it opens with what is offered; a slow answer opens it with 「正在检查…」. */
  const ask = async () => {
    // A press while the Host is still being asked belongs to the same question.
    if (asking.current) return
    asking.current = true
    const asked = ++request.current
    setOutcome(undefined)
    setInspection(undefined)
    let opened = false
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      opened = true
      trigger.current?.onClick()
    }, INSPECT_WAIT_MS)
    const result = await files
      .inspect(session.id, props.actionPath ?? props.path)
      .catch((): FileInspection => ({ status: 'failed', code: 'shell-failed' }))
    asking.current = false
    if (asked !== request.current) return
    clearTimeout(timer.current)
    setInspection(result)
    if (!opened) trigger.current?.onClick()
  }

  /** A refusal or failure reopens the menu with the reason at its foot; success shows itself. */
  const run = async (action: Action) => {
    const target = props.actionPath ?? props.path
    const call = action === 'quickLook' ? files.quickLook : action === 'open' ? files.open : files.reveal
    const result =
      action === 'editor'
        ? await openInEditor(session.id, target, line)
        : await call(session.id, target).catch((): FileActionResult => ({
            status: 'failed',
            code: 'shell-failed',
          }))
    if (result.status === 'shown' || result.status === 'opened' || result.status === 'canceled') return
    setOutcome(result.status === 'busy' ? fileNote('busy') : fileNote(result.code, context))
    if (trigger.current && !trigger.current['aria-expanded']) trigger.current.onClick()
  }

  const offered = inspection?.status === 'ok' ? inspection.actions : undefined
  const item = (id: Action, label: string, icon: MenuItem['icon']): MenuItem[] =>
    offered?.[id]
      ? [
          {
            id,
            label,
            icon,
            onSelect: () => {
              void run(id)
            },
          },
        ]
      : []
  const sections: MenuSection[] = [
    {
      id: 'system',
      items: [
        ...item('quickLook', FILE_COPY.quickLook, EyeGlyph),
        ...item('open', FILE_COPY.open, AppWindow),
        ...(editorLabel(editors) ? item('editor', editorLabel(editors)!, CodeGlyph) : []),
        ...item('reveal', revealLabel(platform), FolderOpenGlyph),
      ],
    },
    // On the computer that runs Latch the path to copy is the whole one, ready for Finder's 「前往文件夹」 or a terminal.
    copySection(() => {
      void copy(props.actionPath ?? absoluteReference(props.path, session.folder))
    }),
  ]
  return (
    <>
      <ChipMenu
        {...props}
        name={name}
        checking={inspection === undefined}
        sections={sections}
        note={outcome ?? noteOf(inspection, context)}
        copied={state === 'copied'}
        triggerRef={trigger}
        onOpen={() => {
          void ask()
        }}
      />
      <CopyStatus state={state} />
    </>
  )
}
