import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import type { FileEditResult, FileMetadata } from '@latch/protocol'
import { Button, ConfirmDialog, InlineNotice, StatusWord, useCopy, CopyGlyph } from '@latch/ui'
import { ApiError, api, errorMessage, fileBytes, isUncertain, newRequestId } from '../core/api.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { useVisualViewportFit } from '../hooks/useVisualViewportFit.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { decodeEditable, editHash } from './editText.ts'
import type { EditPhase as Phase, EditSent as Sent, EditTheirs as Theirs, EditorState } from './editDrafts.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    agentBusy: 'Agent 正在这个文件夹里运行，结束后再保存。',
    saving: '正在保存',
    unknown: '结果未知',
    changed: '文件已在别处修改',
    running: 'Agent 运行中',
    unsaved: '未保存',
    retry: '重试保存',
    save: '保存',
    edit: (value1: string | number) => `编辑 ${value1}`,
    cancel: '取消',
    current: '文件现在的内容',
    reading: '正在读取…',
    readFailed: '无法读取文件现在的内容。',
    changes: '你的修改',
    copied: '已复制',
    copyUnavailable: '复制不可用',
    copyChanges: '复制我的修改',
    loadLatest: '载入最新',
    fileContents: (value1: string | number) => `${value1} 的内容`,
    conflict: '文件已在别处修改，你的修改还没有保存',
    saveUnknown: '保存结果未知',
    loadTitle: '载入最新？',
    loadText: '你的修改会被替换，需要的话先复制。',
    load: '载入',
    discardTitle: '放弃你的修改？',
    discardText: '还没有保存的修改会丢失。',
    discard: '放弃',
  },
  {
    agentBusy: 'The agent is running in this folder. Save once it finishes.',
    saving: 'Saving',
    unknown: 'Outcome unknown',
    changed: 'File changed elsewhere',
    running: 'Agent running',
    unsaved: 'Not saved',
    retry: 'Retry save',
    save: 'Save',
    edit: (value1: string | number) => `Edit ${value1}`,
    cancel: 'Cancel',
    current: 'Current file contents',
    reading: 'Reading…',
    readFailed: 'Couldn’t read the current file contents.',
    changes: 'Your changes',
    copied: 'Copied',
    copyUnavailable: 'Can’t copy',
    copyChanges: 'Copy my changes',
    loadLatest: 'Load latest',
    fileContents: (value1: string | number) => `Contents of ${value1}`,
    conflict: 'The file changed elsewhere. Your changes haven’t been saved.',
    saveUnknown: 'Save outcome unknown',
    loadTitle: 'Load the latest version?',
    loadText: 'This replaces your changes. Copy them first if you need them.',
    load: 'Load',
    discardTitle: 'Discard your changes?',
    discardText: 'Unsaved changes will be lost.',
    discard: 'Discard',
  },
)

/**
 * A plain editor for a small text file of a session, opened from its preview: a monospace text area with line numbers,
 * 取消 and 保存. A save names the version it started from; when the file changed elsewhere meanwhile nothing is written:
 * both versions stay on screen, the person copies their text (复制我的修改) or loads the file as it is now (载入最新) and
 * edits from there, as on iOS. A save without an answer keeps its request for 重试保存. On a phone it is a page of its
 * own with the bar on top, clear of the keyboard.
 */
export function FileEditor({
  sessionId,
  file,
  text,
  baseHash,
  running,
  phone,
  initial,
  onState,
  onSaved,
  onClose,
}: {
  /** What the editor showed before its tab or panel went away. */
  initial?: EditorState
  /** Every change of what it shows, so the panel can keep it. */
  onState?(state: EditorState): void
  sessionId: string
  file: FileMetadata
  /** The text the preview read, and the SHA-256 of its bytes. */
  text: string
  baseHash: string
  /** A turn runs in the session: saving waits. */
  running: boolean
  phone: boolean
  onSaved(result: FileEditResult): void
  /** `reread`: the file changed, so the preview reads it again. */
  onClose(reread: boolean): void
}) {
  // 载入最新 moves the version the editor works from; until then it is the one the preview read.
  const [base, setBase] = useState(initial?.base ?? { text, hash: baseHash })
  const [draft, setDraft] = useState(initial?.draft ?? text)
  // A save that was under way when the editor went away has no answer here: it is retried with the same request.
  const [phase, setPhase] = useState<Phase>(initial?.phase === 'saving' ? 'unknown' : (initial?.phase ?? 'editing'))
  const [sent, setSent] = useState<Sent | undefined>(initial?.sent)
  const [theirs, setTheirs] = useState<Theirs | undefined>(initial?.theirs)
  const report = useRef(onState)
  report.current = onState
  useEffect(() => {
    const moved = base.hash !== baseHash || base.text !== text
    report.current?.({ draft, phase, ...(sent ? { sent } : {}), ...(theirs ? { theirs } : {}), ...(moved ? { base } : {}) })
  }, [draft, phase, sent, theirs, base, baseHash, text])
  const [error, setError] = useState('')
  /** The refusal was a turn running: a wait, not a failure. */
  const [waiting, setWaiting] = useState(false)
  const [asking, setAsking] = useState<'latest' | 'discard'>()
  const area = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLPreElement>(null)
  const root = useRef<HTMLElement>(null)
  const copied = useCopy()
  const dirty = draft !== base.text
  const busy = phase === 'saving'

  useEffect(() => {
    area.current?.focus({ preventScroll: true })
  }, [])
  // The phone page follows the visible viewport, so the keyboard never covers the text being typed.
  useVisualViewportFit(root, phone)
  useBackLayer(phone && asking === undefined, () => {
    if (dirty || phase === 'unknown' || phase === 'conflict') setAsking('discard')
    else onClose(false)
  })

  const lines = draft.split('\n').length
  const numbers = useRef('')
  if (numbers.current.split('\n').length !== lines) numbers.current = Array.from({ length: lines }, (_, index) => index + 1).join('\n')

  async function send(request: Sent): Promise<void> {
    setPhase('saving')
    setError('')
    setSent(request)
    try {
      const result = await api<FileEditResult>(`tasks/${encodeURIComponent(sessionId)}/files/${file.handle}`, {
        method: 'PUT',
        body: request,
        timeoutMs: 30_000,
      })
      setSent(undefined)
      onSaved(result)
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'file-changed') {
        setSent(undefined)
        await showTheirs(typeof cause.details.currentHash === 'string' ? cause.details.currentHash : undefined)
        return
      }
      if (isUncertain(cause)) {
        // Kept for the retry, which must send the same request.
        setPhase('unknown')
        return
      }
      setSent(undefined)
      setPhase(theirs ? 'conflict' : 'editing')
      const turn = cause instanceof ApiError && cause.code === 'file-turn-running'
      setWaiting(turn)
      setError(turn ? COPY.agentBusy : errorMessage(cause))
    }
  }

  /** Reads the file as it is now; the person's text stays where it is. */
  async function showTheirs(hash: string | undefined): Promise<void> {
    setPhase('conflict')
    try {
      const bytes = new Uint8Array(await fileBytes(file.handle))
      const read = decodeEditable(bytes)
      setTheirs({ hash: (await editHash(bytes)) ?? hash ?? '', ...(read === undefined ? {} : { text: read }) })
    } catch {
      setTheirs({ hash: hash ?? '' })
    }
  }

  const save = () => {
    if (busy || running || !dirty) return
    void send({ requestId: newRequestId(), baseHash: base.hash, content: draft })
  }
  /** The file as it is now becomes the version to edit; the person's text goes, unless they copied it. */
  const loadLatest = () => {
    if (theirs?.text === undefined || !theirs.hash) {
      onClose(true)
      return
    }
    setBase({ text: theirs.text, hash: theirs.hash })
    setDraft(theirs.text)
    setTheirs(undefined)
    setPhase('editing')
    setError('')
    requestAnimationFrame(() => area.current?.focus({ preventScroll: true }))
  }
  const cancel = () => {
    if (busy) return
    if (dirty || phase === 'unknown' || phase === 'conflict') setAsking('discard')
    else onClose(false)
  }
  const keys = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (phase === 'unknown' && sent) void send(sent)
      else if (phase === 'editing') save()
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && asking === undefined) {
      event.preventDefault()
      cancel()
    }
  }

  const status =
    phase === 'saving' ? (
      <StatusWord tone="running">{COPY.saving}</StatusWord>
    ) : phase === 'unknown' ? (
      <StatusWord tone="warn">{COPY.unknown}</StatusWord>
    ) : phase === 'conflict' ? (
      <StatusWord tone="waiting">{COPY.changed}</StatusWord>
    ) : running ? (
      <StatusWord tone="neutral">{COPY.running}</StatusWord>
    ) : dirty ? (
      <StatusWord tone="neutral">{COPY.unsaved}</StatusWord>
    ) : null

  const action =
    phase === 'unknown' && sent ? (
      <Button variant="primary" size={phone ? 'lg' : 'sm'} onClick={() => void send(sent)}>
        {COPY.retry}
      </Button>
    ) : phase === 'conflict' ? null : (
      <Button
        variant="primary"
        size={phone ? 'lg' : 'sm'}
        disabled={running || !dirty}
        loading={busy}
        loadingLabel={COPY.saving}
        onClick={save}>
        {COPY.save}
      </Button>
    )

  return (
    <section ref={root} className="file-editor" data-phone={phone ? '' : undefined} aria-label={COPY.edit(file.name)} onKeyDown={keys}>
      <header className="file-editor-bar">
        <Button variant="ghost" size={phone ? 'lg' : 'sm'} disabled={busy} onClick={cancel}>
          {COPY.cancel}
        </Button>
        <span className="file-editor-title">
          <span className="file-editor-name">
            <VisibleText text={file.name} />
          </span>
          {status}
        </span>
        {action}
      </header>
      {error && <InlineNotice tone={waiting ? 'warn' : 'error'}>{error}</InlineNotice>}
      {phase === 'conflict' ? (
        <div className="file-editor-conflict">
          <div className="file-editor-versions">
            <section className="file-editor-version" aria-label={COPY.current}>
              <h3 className="file-editor-version-title">{COPY.current}</h3>
              {theirs === undefined ? (
                <p className="file-editor-version-note">{COPY.reading}</p>
              ) : theirs.text === undefined ? (
                <p className="file-editor-version-note">{COPY.readFailed}</p>
              ) : (
                <pre className="file-editor-version-text" tabIndex={0}>
                  {theirs.text}
                </pre>
              )}
            </section>
            <section className="file-editor-version" aria-label={COPY.changes}>
              <h3 className="file-editor-version-title">{COPY.changes}</h3>
              <pre className="file-editor-version-text" tabIndex={0}>
                {draft}
              </pre>
            </section>
          </div>
          <div className="file-editor-choices">
            <Button
              size={phone ? 'lg' : 'sm'}
              icon={CopyGlyph}
              onClick={() => {
                void copied.copy(draft)
              }}>
              {copied.state === 'copied' ? COPY.copied : copied.state === 'failed' ? COPY.copyUnavailable : COPY.copyChanges}
            </Button>
            <Button
              variant="primary"
              size={phone ? 'lg' : 'sm'}
              disabled={theirs === undefined || busy}
              onClick={() => {
                if (copied.state === 'copied' || theirs?.text === draft) loadLatest()
                else setAsking('latest')
              }}>
              {COPY.loadLatest}
            </Button>
          </div>
        </div>
      ) : (
        <div className="file-editor-body">
          <pre ref={gutter} className="file-editor-gutter" aria-hidden="true">
            {numbers.current}
          </pre>
          <textarea
            ref={area}
            className="file-editor-text"
            aria-label={COPY.fileContents(file.name)}
            value={draft}
            readOnly={busy || phase === 'unknown'}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            wrap="off"
            onChange={event => {
              setDraft(event.target.value)
              if (error && !running) setError('')
            }}
            onScroll={event => {
              if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop
            }}
          />
        </div>
      )}
      <span className="sr-only" role="status">
        {phase === 'conflict' ? COPY.conflict : phase === 'unknown' ? COPY.saveUnknown : ''}
      </span>
      {asking === 'latest' && (
        <ConfirmDialog
          title={COPY.loadTitle}
          message={COPY.loadText}
          confirmLabel={COPY.load}
          danger
          onConfirm={async () => {
            setAsking(undefined)
            loadLatest()
          }}
          onClose={() => setAsking(undefined)}
        />
      )}
      {asking === 'discard' && (
        <ConfirmDialog
          title={COPY.discardTitle}
          message={COPY.discardText}
          confirmLabel={COPY.discard}
          danger
          onConfirm={async () => {
            setAsking(undefined)
            onClose(phase === 'conflict')
          }}
          onClose={() => setAsking(undefined)}
        />
      )}
    </section>
  )
}
