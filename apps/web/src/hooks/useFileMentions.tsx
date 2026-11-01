import { mentionMarker } from '../fileMentions.ts'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { FileMention } from '@latch/protocol'
import { Button, InlineNotice, Loading } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
export interface FileMentionChoice {
  enabled: boolean
  sessionId?: string
  workspaceId?: string
  harnessId: string
  refs: FileMention[]
  onRefs(refs: FileMention[]): void
}

type MentionFile = FileMention & { name: string; ignored?: boolean }

export function activeFileMention(draft: string, caret: number): { start: number; end: number; query: string } | undefined {
  const before = draft.slice(0, caret),
    match = /(?:^|\s)@([^\s@]*)$/u.exec(before)
  if (!match) return
  return { start: caret - match[1]!.length - 1, end: caret, query: match[1]! }
}
export function useFileMentions(
  draft: string,
  onDraft: (text: string) => void,
  textarea: RefObject<HTMLTextAreaElement | null>,
  choice?: FileMentionChoice,
) {
  const [caret, setCaret] = useState(draft.length),
    [files, setFiles] = useState<MentionFile[]>([]),
    [truncated, setTruncated] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(0),
    [dismissed, setDismissed] = useState<string>()
  const token = activeFileMention(draft, Math.min(caret, draft.length)),
    scope = choice?.sessionId ?? choice?.workspaceId
  const open = Boolean(choice?.enabled && token && dismissed !== draft)
  const query = token?.query ?? ''
  const list = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, files])
  useEffect(() => {
    setError('')
    setSelected(0)
    if (!open || !scope || !choice) {
      setFiles([])
      setTruncated(false)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      const path = choice.sessionId
        ? `tasks/${encodeURIComponent(choice.sessionId)}/files/search`
        : `workspaces/${encodeURIComponent(scope)}/files/search`
      void api<{ files: MentionFile[]; truncated?: boolean }>(path, {
        method: 'POST',
        body: { q: query, limit: 30, ...(choice.sessionId ? {} : { harnessId: choice.harnessId }) },
        signal: controller.signal,
      })
        .then(result => {
          if (controller.signal.aborted) return
          setTruncated(result.truncated === true)
          setFiles(
            result.files
              .slice(0, 30)
              .filter(
                file =>
                  typeof file.name === 'string'
                  && file.name.length <= 200
                  && typeof file.root === 'string'
                  && typeof file.path === 'string'
                  && file.path.length <= 4096,
              ),
          )
        })
        .catch(cause => {
          if (controller.signal.aborted) return
          setFiles([])
          setTruncated(false)
          setError(errorMessage(cause))
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 160)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, scope, choice?.sessionId, choice?.harnessId, query])
  const choose = (file: FileMention) => {
    if (!choice || !token) return
    if (choice.refs.length >= 32) {
      setError('每条消息最多引用 32 个文件。')
      return
    }
    const marker = `${mentionMarker(file)} `
    onDraft(`${draft.slice(0, token.start)}${marker}${draft.slice(token.end)}`)
    choice.onRefs([...choice.refs.filter(ref => ref.root !== file.root || ref.path !== file.path), { root: file.root, path: file.path }])
    setDismissed(undefined)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(token.start + marker.length, token.start + marker.length)
      setCaret(token.start + marker.length)
    })
  }
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(draft)
      return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(previous => (files.length ? (previous + files.length + (event.key === 'ArrowDown' ? 1 : -1)) % files.length : 0))
      return true
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!loading && files[selected]) choose(files[selected])
      return true
    }
    return false
  }
  const severalRoots = new Set(files.map(file => file.root)).size > 1
  const menu = open ? (
    <section ref={list} className="file-mentions" aria-label="引用项目文件" aria-busy={loading}>
      {!scope ? (
        <InlineNotice>先选择一个项目，再引用其中的文件。</InlineNotice>
      ) : error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : files.length ? (
        <>
          {files.map((file, index) => {
            const folder = file.path.slice(0, Math.max(0, file.path.length - file.name.length - 1))
            return (
              <Button
                key={`${file.root}:${file.path}`}
                variant={selected === index ? 'secondary' : 'ghost'}
                size="sm"
                title={file.path}
                onClick={() => choose(file)}
                aria-current={selected === index ? 'true' : undefined}>
                <span className="file-mention-path">
                  <span className="file-mention-name">
                    <VisibleText text={file.name} />
                  </span>
                  {folder ? (
                    <span className="file-mention-folder">
                      <VisibleText text={folder} />
                    </span>
                  ) : null}
                </span>
                {file.ignored ? <span className="attachment-state">已忽略</span> : null}
                {severalRoots ? <span className="attachment-state">{file.root}</span> : null}
              </Button>
            )
          })}
          {truncated ? <p>还有更多文件，继续输入缩小范围</p> : null}
        </>
      ) : loading ? (
        <Loading label="正在查找文件…" />
      ) : (
        <p>没有匹配的文件</p>
      )}
    </section>
  ) : null
  return { menu, keydown, setCaret }
}
