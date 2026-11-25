import { mentionMarker } from '../fileMentions.ts'
import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react'
import type { FileMention } from '@latch/protocol'
import { FileGlyph, Hint, Icon, Kbd, Spinner, Suggest, Tooltip } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { defineCopy } from '../core/i18n.ts'
import type { PromptInput } from '../composer/PromptEditor.tsx'

const COPY = defineCopy(
  {
    limit: '每条消息最多引用 32 个文件。',
    noAccess: '这台设备看不到项目文件',
    grantAccess: '在 Mac 的 设置 › 设备 里为这台设备开启「可以看项目文件」。',
    chooseProject: '先选择一个项目，再引用其中的文件。',
    finding: '正在查找文件…',
    findingBeside: '正在查找…',
    noMatches: '没有匹配的文件',
    mention: '引用项目文件',
    files: '文件',
    mentionMembers: '提到成员或文件',
    ignored: '已忽略',
    more: '还有更多文件，继续输入缩小范围',
    complete: ' 补全',
    choose: ' 选择',
  },
  {
    limit: 'Mention up to 32 files per message.',
    noAccess: 'This device cannot view project files',
    grantAccess: 'Allow this device to view project files in Settings › Devices on the Mac.',
    chooseProject: 'Choose a project first to mention its files.',
    finding: 'Finding files…',
    findingBeside: 'Finding…',
    noMatches: 'No matching files',
    mention: 'Mention project files',
    files: 'Files',
    mentionMembers: 'Mention members or files',
    ignored: 'Ignored',
    more: 'More files are available. Type to narrow down.',
    complete: ' to complete',
    choose: ' to choose',
  },
)

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

/**
 * Members of the team the open session leads, listed above the files after `@`: choosing one puts its `token` in the
 * draft, where it stays text. One that cannot take work now is listed, not chosen, with `disabled` as the reason on hover.
 */
export interface MentionMembers {
  label: string
  /** A personal chat keeps its selected recipient separately from the text. */
  onChoose?(id: string): void
  owner?: string | undefined
  empty?: string
  items: ReadonlyArray<{
    id: string
    token: string
    /** What the member is called, the list's line; `title`, its task, is found by a search too. */
    name: string
    title: string
    media: ReactNode
    description?: ReactNode
    source?: ReactNode
    disabled?: string
  }>
}

/** Members a query after `@` finds: by name, task or token, case-insensitively; all of them with nothing typed. */
export function matchingMembers<T extends { name?: string; title: string; token: string }>(items: readonly T[], query: string): T[] {
  const words = query.trim().toLocaleLowerCase()
  if (!words) return [...items]
  return items.filter(
    item =>
      (item.name ?? '').toLocaleLowerCase().includes(words)
      || item.title.toLocaleLowerCase().includes(words)
      || item.token.slice(1).toLocaleLowerCase().includes(words),
  )
}

export function activeFileMention(draft: string, caret: number): { start: number; end: number; query: string } | undefined {
  const before = draft.slice(0, caret),
    match = /(?:^|\s)@([^\s@]*)$/u.exec(before)
  if (!match) return
  return { start: caret - match[1]!.length - 1, end: caret, query: match[1]! }
}
/** A personal Agent can follow Chinese prose directly. An email and punctuation after a name close the picker. */
export function activeAgentMention(draft: string, caret: number) {
  const match = /(?:^|[^a-zA-Z0-9._%+@＠-])[@＠]([^\s\p{P}]{0,80})$/u.exec(draft.slice(0, caret))
  if (!match) return undefined
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
  caret: number | null,
  onDraft: (text: string, selection?: { start: number; end: number }) => void,
  textarea: RefObject<PromptInput | null>,
  choice: FileMentionChoice | undefined,
  anchorRef: RefObject<HTMLElement | null>,
  members?: MentionMembers,
) {
  const id = useId()
  const [files, setFiles] = useState<MentionFile[]>([]),
    [truncated, setTruncated] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<{ query: string; index: number }>(),
    [dismissed, setDismissed] = useState<string>()
  // The toolbar opens only people. Typing @ still searches both people and project files.
  const [picker, setPicker] = useState<{
    owner: string
    at: number
    inserted?: { before: string; after: string; original: string; selection: { start: number; end: number } }
  }>()
  const fileToken = caret === null ? undefined : activeFileMention(draft, caret)
  const memberToken = members?.onChoose && caret !== null ? activeAgentMention(draft, caret) : fileToken
  const token = memberToken ?? fileToken
  const scope = choice?.sessionId ?? choice?.workspaceId
  const query = token?.query ?? ''
  const inPicker = !!memberToken && !!picker && picker.owner === members?.owner && picker.at === memberToken.start
  const people = members && memberToken && dismissed !== draft ? matchingMembers(members.items, query) : []
  const choosable = people.filter(item => !item.disabled)
  const hiddenOpen = Boolean(!inPicker && choice?.hidden && fileToken && dismissed !== draft && !people.length)
  const filesOpen = Boolean(!inPicker && choice?.enabled && fileToken && dismissed !== draft)
  const memberSearch = Boolean(members?.empty && memberToken && dismissed !== draft)
  const open = filesOpen || people.length > 0 || memberSearch
  useEffect(() => {
    setDismissed(previous => (previous === draft ? previous : undefined))
  }, [draft])
  useEffect(() => {
    setSelected(undefined)
    setError('')
    if (!filesOpen || !scope || !choice) {
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
  }, [filesOpen, scope, choice?.sessionId, choice?.harnessId, query])
  // A member found is ready at once: the files still on their way do not hold Enter back from it.
  const listedFiles = filesOpen && scope && !error && !loading ? files : []
  const count = choosable.length + listedFiles.length
  const waiting = loading && filesOpen && !!scope && !choosable.length
  const active = open ? mentionActive({ count, loading: waiting, query, ...(selected ? { selected } : {}) }) : -1
  const openPeople = () => {
    const field = textarea.current
    if (!field || !members?.owner) return
    if (inPicker && open) {
      dismiss()
      field.focus({ preventScroll: true })
      return
    }
    const start = field.selectionStart
    const end = field.selectionEnd
    const existing = start === end && start === caret ? activeAgentMention(draft, start) : undefined
    setSelected(undefined)
    setDismissed(undefined)
    if (existing) {
      setPicker({ owner: members.owner, at: existing.start })
    } else {
      // The editor excludes quoted text, chips and selections from inline completion. Keep its search outside that content.
      const separateLine = caret === null && draft.length > 0
      const before = separateLine ? '' : draft.slice(0, start)
      const marker = before && !/\s$/u.test(before) ? ' @' : '@'
      const after = separateLine ? '\n' + draft : draft.slice(start)
      const next = before + marker + after
      const to = before.length + marker.length
      setPicker({ owner: members.owner, at: to - 1, inserted: { before, after, original: draft, selection: { start, end } } })
      onDraft(next, { start: to, end: to })
    }
    requestAnimationFrame(() => field.focus({ preventScroll: true }))
  }
  // A toolbar search is temporary. Leave the prose and selection it was opened over intact.
  const inserted =
    inPicker && picker.inserted && draft.startsWith(picker.inserted.before) && draft.slice(memberToken.end) === picker.inserted.after
      ? picker.inserted
      : undefined
  const restoreSearch = () => {
    if (!inserted) return
    onDraft(inserted.original, inserted.selection)
  }
  const dismiss = () => {
    restoreSearch()
    setPicker(undefined)
    setDismissed(draft)
  }
  const chooseMember = (item: MentionMembers['items'][number]) => {
    if (!token || item.disabled) return
    setPicker(undefined)
    members?.onChoose?.(item.id)
    if (inserted) restoreSearch()
    else {
      const marker = members?.onChoose ? '' : `${item.token} `
      const next = `${draft.slice(0, token.start)}${marker}${draft.slice(token.end)}`
      const caret = token.start + marker.length
      onDraft(next, { start: caret, end: caret })
    }
    setDismissed(undefined)
    requestAnimationFrame(() => textarea.current?.focus())
  }
  const chooseEntry = (index: number) => {
    if (index < choosable.length) chooseMember(choosable[index]!)
    else {
      const file = listedFiles[index - choosable.length]
      if (file) choose(file)
    }
  }
  const choose = (file: FileMention) => {
    if (!choice || !token) return
    if (choice.refs.length >= 32) {
      setError(COPY.limit)
      return
    }
    const marker = `${mentionMarker(file)} `
    const caret = token.start + marker.length
    // The reference first, so the marker is a chip as soon as it is in the text.
    choice.onRefs([...choice.refs.filter(ref => ref.root !== file.root || ref.path !== file.path), { root: file.root, path: file.path }])
    onDraft(`${draft.slice(0, token.start)}${marker}${draft.slice(token.end)}`, { start: caret, end: caret })
    setDismissed(undefined)
    requestAnimationFrame(() => textarea.current?.focus())
  }
  const keydown = (event: KeyboardEvent) => {
    if ((!open && !hiddenOpen) || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return false
    // A device that cannot list files only has the note to close.
    const action = open
      ? mentionKey({ key: event.key, shift: event.shiftKey, count, loading: waiting, query, active })
      : event.key === 'Escape'
        ? ({ do: 'close' } as const)
        : ({ do: 'pass' } as const)
    if (action.do === 'pass') {
      if (inPicker && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        return true
      }
      if (inPicker && event.key === 'Tab') dismiss()
      return false
    }
    event.preventDefault()
    event.stopPropagation()
    if (action.do === 'close') dismiss()
    else if (action.do === 'move') setSelected({ query, index: action.index })
    else if (action.do === 'choose') chooseEntry(action.index)
    return true
  }
  const severalRoots = new Set(files.map(file => file.root)).size > 1
  const optionId = (index: number) => `${id}-${index}`
  const shown = open || hiddenOpen
  const fileStatus = hiddenOpen ? (
    <Hint label={COPY.noAccess}>{COPY.grantAccess}</Hint>
  ) : !scope ? (
    COPY.chooseProject
  ) : error ? (
    <span data-tone="error">{error}</span>
  ) : loading ? (
    <span className="mention-finding">
      <Spinner size={12} />
      {people.length ? COPY.findingBeside : COPY.finding}
    </span>
  ) : (
    COPY.noMatches
  )
  const suggestions = (
    <Suggest
      frosted={!hiddenOpen}
      id={id}
      label={memberSearch && !filesOpen ? members!.label : people.length ? COPY.mentionMembers : COPY.mention}
      open={shown}
      anchorRef={anchorRef}
      activeId={active >= 0 ? optionId(active) : undefined}
      onActiveChange={option => setSelected({ query, index: Number(option.slice(id.length + 1)) })}
      onChoose={option => {
        const index = Number(option.slice(id.length + 1))
        if (Number.isInteger(index)) chooseEntry(index)
      }}
      onDismiss={dismiss}
      groups={[
        ...(people.length && members
          ? [
              {
                id: 'members',
                label: members.label,
                items: people.map(item => {
                  const at = choosable.indexOf(item)
                  return {
                    id: at >= 0 ? optionId(at) : `${id}-off-${item.id}`,
                    media: item.media,
                    label: (
                      <Tooltip content={item.disabled}>
                        <span className="mention-member" tabIndex={item.disabled ? -1 : undefined}>
                          <VisibleText text={item.name} />
                        </span>
                      </Tooltip>
                    ),
                    ...(item.description ? { description: item.description } : {}),
                    ...(item.source ? { source: item.source } : {}),
                    ...(item.disabled ? { disabled: true } : {}),
                  }
                }),
              },
            ]
          : []),
        {
          id: 'files',
          ...(people.length ? { label: COPY.files } : {}),
          // Beside the members, a search under way or one that failed is said under 文件; no match shows no files.
          ...(people.length && filesOpen && scope && (error || loading) ? { empty: fileStatus } : {}),
          items: listedFiles.map((file, fileIndex) => {
            const index = choosable.length + fileIndex
            const folder = file.path.slice(0, Math.max(0, file.path.length - file.name.length - 1))
            const source = [file.ignored ? COPY.ignored : '', severalRoots ? file.root : ''].filter(Boolean).join(' · ')
            return {
              id: optionId(index),
              media: <Icon icon={FileGlyph} size={16} />,
              label: <VisibleText text={file.name} />,
              description: folder ? <VisibleText text={folder} /> : '',
              ...(source ? { source: <VisibleText text={source} /> } : {}),
            }
          }),
        },
        ...(listedFiles.length && truncated ? [{ id: 'more', items: [], empty: <span role="status">{COPY.more}</span> }] : []),
      ]}
      empty={memberSearch && !filesOpen ? members?.empty : fileStatus}
      footer={
        hiddenOpen ? undefined : (
          <>
            <span>
              <Kbd>↑↓</Kbd>
            </span>
            <span>
              <Kbd>Tab</Kbd>
              {COPY.complete}
            </span>
            <span>
              <Kbd>⏎</Kbd>
              {COPY.choose}
            </span>
            <Kbd>Esc</Kbd>
          </>
        )
      }
    />
  )
  const menu = memberSearch ? <div className="composer-peer-suggestions">{suggestions}</div> : suggestions
  return {
    menu,
    keydown,
    openPeople,
    pickingPerson: inPicker && open,
    open,
    listId: id,
    activeId: active >= 0 ? optionId(active) : undefined,
  }
}
