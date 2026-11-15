import { mentionMarker } from '../fileMentions.ts'
import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from 'react'
import type { FileMention } from '@latch/protocol'
import { FileGlyph, Hint, Icon, Kbd, Suggest } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
export interface FileMentionChoice {
  enabled: boolean
  /** @ would find files, but this device's data scope does not let it list them: the menu says so. */
  hidden?: true
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
/** The chosen row: with a query the first file, with none nothing until an arrow key says so; none while files load. */
export function mentionActive(input: {
  count: number
  loading: boolean
  query: string
  selected?: { query: string; index: number }
}): number {
  const { count, loading, query, selected } = input
  if (loading || !count) return -1
  return selected?.query === query && selected.index < count ? selected.index : query ? 0 : -1
}

/**
 * What a key does while the `@` list is open, by the slash menu's rules: Esc closes; the arrows move and wrap; Tab and
 * Enter take the chosen file; with no row chosen they keep their own meaning (`pass`), except while results for a typed
 * query are still on their way (`wait`), so Enter does not send a half-written reference.
 */
export function mentionKey(input: {
  key: string
  shift: boolean
  count: number
  loading: boolean
  query: string
  active: number
}): { do: 'close' | 'wait' | 'pass' } | { do: 'move' | 'choose'; index: number } {
  const { key, shift, count, loading, query, active } = input
  if (key === 'Escape') return { do: 'close' }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!count || loading) return { do: 'pass' }
    const step = key === 'ArrowDown' ? 1 : -1
    return { do: 'move', index: active < 0 ? (step > 0 ? 0 : count - 1) : (active + step + count) % count }
  }
  if ((key !== 'Enter' && key !== 'Tab') || shift) return { do: 'pass' }
  if (loading && query) return { do: 'wait' }
  return active >= 0 && active < count ? { do: 'choose', index: active } : { do: 'pass' }
}

/**
 * `@` in the input: project files from the Host, in the same suggestion list as the slash menu and with its keys. Tab
 * completes and Enter chooses (both put the file's marker in the draft), Esc closes, the arrows move and wrap, and with
 * nothing typed after `@` no row is selected until an arrow is pressed. Nothing answers while an input method composes.
 */
export function useFileMentions(
  draft: string,
  onDraft: (text: string) => void,
  textarea: RefObject<HTMLTextAreaElement | null>,
  choice: FileMentionChoice | undefined,
  anchorRef: RefObject<HTMLElement | null>,
) {
  const id = useId()
  const [caret, setCaret] = useState(draft.length),
    [files, setFiles] = useState<MentionFile[]>([]),
    [truncated, setTruncated] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<{ query: string; index: number }>(),
    [dismissed, setDismissed] = useState<string>()
  const token = activeFileMention(draft, Math.min(caret, draft.length)),
    scope = choice?.sessionId ?? choice?.workspaceId
  const hiddenOpen = Boolean(choice?.hidden && token && dismissed !== draft)
  const open = Boolean(choice?.enabled && token && dismissed !== draft)
  const query = token?.query ?? ''
  useEffect(() => {
    setDismissed(previous => (previous === draft ? previous : undefined))
  }, [draft])
  useEffect(() => {
    setSelected(undefined)
    setError('')
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
  const active = open ? mentionActive({ count: files.length, loading, query, ...(selected ? { selected } : {}) }) : -1
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
    if ((!open && !hiddenOpen) || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey)
      return false
    // A device that cannot list files only has the note to close.
    const action = open
      ? mentionKey({ key: event.key, shift: event.shiftKey, count: files.length, loading: loading && !!scope, query, active })
      : event.key === 'Escape'
        ? ({ do: 'close' } as const)
        : ({ do: 'pass' } as const)
    if (action.do === 'pass') return false
    event.preventDefault()
    event.stopPropagation()
    if (action.do === 'close') setDismissed(draft)
    else if (action.do === 'move') setSelected({ query, index: action.index })
    else if (action.do === 'choose') choose(files[action.index]!)
    return true
  }
  const severalRoots = new Set(files.map(file => file.root)).size > 1
  const optionId = (index: number) => `${id}-${index}`
  const shown = open || hiddenOpen
  const status = hiddenOpen ? (
    <Hint label="这台设备看不到项目文件">在 Mac 的 设置 › 设备 里为这台设备开启「可以看项目文件」。</Hint>
  ) : !scope ? (
    '先选择一个项目，再引用其中的文件。'
  ) : error ? (
    <span data-tone="error">{error}</span>
  ) : loading ? (
    '正在查找文件…'
  ) : (
    '没有匹配的文件'
  )
  const listed = open && scope && !error && !loading ? files : []
  const menu = (
    <Suggest
      id={id}
      label="引用项目文件"
      open={shown}
      anchorRef={anchorRef}
      activeId={active >= 0 ? optionId(active) : undefined}
      onActiveChange={option => setSelected({ query, index: Number(option.slice(id.length + 1)) })}
      onChoose={option => {
        const file = files[Number(option.slice(id.length + 1))]
        if (file) choose(file)
      }}
      onDismiss={() => setDismissed(draft)}
      groups={[
        {
          id: 'files',
          items: listed.map((file, index) => {
            const folder = file.path.slice(0, Math.max(0, file.path.length - file.name.length - 1))
            const source = [file.ignored ? '已忽略' : '', severalRoots ? file.root : ''].filter(Boolean).join(' · ')
            return {
              id: optionId(index),
              media: <Icon icon={FileGlyph} size={16} />,
              label: <VisibleText text={file.name} />,
              description: folder ? <VisibleText text={folder} /> : '',
              ...(source ? { source: <VisibleText text={source} /> } : {}),
            }
          }),
        },
        ...(listed.length && truncated
          ? [{ id: 'more', items: [], empty: <span role="status">还有更多文件，继续输入缩小范围</span> }]
          : []),
      ]}
      empty={status}
      footer={
        hiddenOpen ? undefined : (
          <>
            <span>
              <Kbd>↑↓</Kbd>
            </span>
            <span>
              <Kbd>Tab</Kbd> 补全
            </span>
            <span>
              <Kbd>⏎</Kbd> 选择
            </span>
            <Kbd>Esc</Kbd>
          </>
        )
      }
    />
  )
  return { menu, keydown, setCaret, open, listId: id, activeId: active >= 0 ? optionId(active) : undefined }
}
