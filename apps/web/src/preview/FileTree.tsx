import { useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Check, ChevronRight, Copy, Ellipsis, File, Folder, Link2, RefreshCw, Search, TextQuote } from 'lucide-react'
import { isFileDirectoryListing, type FileContext, type FileDirectoryListing, type FileMention } from '@latch/protocol'
import { Button, Icon, IconButton, InlineNotice, Loading, Menu } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { useCopy } from '../components/ui.tsx'
import { FileOpenContext, fileContextBody, fileContextKey, fileRoute, targetIn } from './fileContext.ts'

type Branch = { listing?: FileDirectoryListing; loading?: boolean; error?: string; shown: number }
type TreeRow = {
  key: string
  parent?: string
  root: string
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  depth: number
}
const branchKey = (root: string, path: string) => JSON.stringify([root, path])
const PAGE_SIZE = 100
const CACHE_LIMIT = 32

/** Lazily reads one directory. Collapsed branches never issue recursive requests. */
export function FileTree({
  context,
  onSearch,
  onMention,
}: {
  context: FileContext
  onSearch(): void
  onMention?(mention: FileMention): void
}) {
  const open = useContext(FileOpenContext)
  const copy = useCopy()
  const [roots, setRoots] = useState<FileDirectoryListing['roots']>([])
  const [branches, setBranches] = useState<Record<string, Branch>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string>()
  const [showHidden, setShowHidden] = useState(false)
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [generation, setGeneration] = useState(0)
  const tree = useRef<HTMLDivElement>(null)
  const controllers = useRef(new Map<string, AbortController>())
  const readTail = useRef(Promise.resolve())
  const loadedBranches = useRef(new Set<string>())
  const openBranches = useRef(expanded)
  openBranches.current = expanded
  const contextKey = fileContextKey(context)
  const contextRef = useRef(context)
  contextRef.current = context
  const load = useCallback(
    async (root: string, path: string) => {
      const key = branchKey(root, path)
      if (controllers.current.has(key)) return
      if (
        !loadedBranches.current.has(key)
        && [...loadedBranches.current].filter(id => openBranches.current.has(id)).length >= CACHE_LIMIT
      ) {
        setNotice('展开的目录较多。收起暂时不用的目录，或搜索文件名。')
        return
      }
      const controller = new AbortController()
      controllers.current.set(key, controller)
      setBranches(previous => {
        const next = { ...previous }
        for (const cached of Object.keys(next)) {
          if (Object.keys(next).length < CACHE_LIMIT) break
          if (!openBranches.current.has(cached) && !controllers.current.has(cached)) {
            delete next[cached]
            loadedBranches.current.delete(cached)
          }
        }
        next[key] = { ...next[key], loading: true, error: '', shown: next[key]?.shown ?? PAGE_SIZE }
        return next
      })
      const preceding = readTail.current
      let release!: () => void
      readTail.current = new Promise<void>(resolve => {
        release = resolve
      })
      try {
        await preceding
        if (controller.signal.aborted) return
        if (
          !loadedBranches.current.has(key)
          && [...loadedBranches.current].filter(id => openBranches.current.has(id)).length >= CACHE_LIMIT
        ) {
          setNotice('展开的目录较多。收起暂时不用的目录，或搜索文件名。')
          setBranches(previous => ({ ...previous, [key]: { shown: PAGE_SIZE, error: '收起一些目录后重试。' } }))
          return
        }
        const params = new URLSearchParams({
          ...fileContextBody(contextRef.current),
          rootId: root,
          dir: path,
          showHidden: String(showHidden),
        })
        const result = await api<unknown>(`${fileRoute(contextRef.current, 'list')}?${params}`, { signal: controller.signal })
        if (
          !isFileDirectoryListing(result)
          || fileContextKey(result.context) !== contextKey
          || result.rootId !== root
          || result.dir !== path
        )
          throw new Error('文件夹响应无效，请重试。')
        if (!controller.signal.aborted) {
          loadedBranches.current.add(key)
          setBranches(previous => ({ ...previous, [key]: { listing: result, shown: PAGE_SIZE } }))
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setBranches(previous => ({
            ...previous,
            [key]: { ...previous[key], loading: false, error: errorMessage(cause), shown: PAGE_SIZE },
          }))
      } finally {
        release()
        if (controllers.current.get(key) === controller) controllers.current.delete(key)
      }
    },
    [contextKey, showHidden],
  )
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setNotice('')
    setRoots([])
    setBranches({})
    loadedBranches.current.clear()
    setExpanded(new Set())
    setSelected(undefined)
    const params = new URLSearchParams(fileContextBody(contextRef.current))
    void api<unknown>(`${fileRoute(contextRef.current, 'list')}?${params}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return
        if (!isFileDirectoryListing(result) || fileContextKey(result.context) !== contextKey) throw new Error('项目文件响应无效。')
        setRoots(result.roots)
        const first = result.roots[0]
        if (first) {
          setExpanded(new Set([branchKey(first.id, '')]))
          void load(first.id, '')
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      for (const request of controllers.current.values()) request.abort()
      controllers.current.clear()
    }
  }, [contextKey, generation, showHidden])
  const rows: TreeRow[] = []
  let clipped = false
  const append = (row: TreeRow) => {
    if (rows.length >= 1000) {
      clipped = true
      return
    }
    rows.push(row)
    if (!expanded.has(row.key) || row.depth >= 32) return
    const branch = branches[row.key]
    for (const entry of branch?.listing?.entries.slice(0, branch.shown) ?? []) {
      const path = row.path ? `${row.path}/${entry.name}` : entry.name
      append({
        key: branchKey(row.root, path),
        parent: row.key,
        root: row.root,
        path,
        name: entry.name,
        kind: entry.kind,
        depth: row.depth + 1,
      })
    }
  }
  for (const root of roots) append({ key: branchKey(root.id, ''), root: root.id, path: '', name: root.name, kind: 'directory', depth: 0 })
  const byKey = new Map(rows.map(row => [row.key, row]))
  const focusRow = (key: string) => {
    setSelected(key)
    requestAnimationFrame(() =>
      Array.from(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])
        .find(item => item.dataset.treeKey === key)
        ?.focus(),
    )
  }
  const toggle = (row: TreeRow, value = !expanded.has(row.key)) => {
    if (row.kind !== 'directory') return
    if (!value) setNotice('')
    setExpanded(previous => {
      const next = new Set(previous)
      if (value) next.add(row.key)
      else next.delete(row.key)
      return next
    })
    if (value && !branches[row.key]?.listing) void load(row.root, row.path)
  }
  const activate = (row: TreeRow) => {
    setSelected(row.key)
    if (row.kind === 'directory') toggle(row)
    else if (row.kind === 'file') open?.(targetIn(context, row.path, row.root))
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>, row: TreeRow) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return
    const index = rows.findIndex(item => item.key === row.key)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusRow(rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]!.key)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusRow(rows[event.key === 'Home' ? 0 : rows.length - 1]!.key)
    } else if (event.key === 'ArrowRight' && row.kind === 'directory') {
      event.preventDefault()
      if (!expanded.has(row.key)) toggle(row, true)
      else if (rows[index + 1]?.parent === row.key) focusRow(rows[index + 1]!.key)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (expanded.has(row.key)) toggle(row, false)
      else if (row.parent) focusRow(row.parent)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate(row)
    }
  }
  return (
    <section className="file-tree" aria-label="项目文件">
      <header className="file-tree-head">
        <strong>文件</strong>
        <IconButton label="搜索文件" icon={Search} onClick={onSearch} />
        <IconButton label="刷新文件树" icon={RefreshCw} onClick={() => setGeneration(value => value + 1)} />
        <Menu
          label="文件显示选项"
          trigger={props => <IconButton {...props} label="文件显示选项" icon={Ellipsis} />}
          sections={[
            {
              id: 'view',
              items: [
                {
                  id: 'hidden',
                  label: showHidden ? '隐藏隐藏项和生成目录' : '显示隐藏项和生成目录',
                  ...(showHidden ? { icon: Check } : {}),
                  onSelect: () => setShowHidden(value => !value),
                },
              ],
            },
          ]}
        />
      </header>
      {notice && <InlineNotice>{notice}</InlineNotice>}
      {loading && <Loading label="正在读取项目文件…" />}
      {error && (
        <InlineNotice
          tone="error"
          action={
            <Button size="xs" onClick={() => setGeneration(value => value + 1)}>
              重试
            </Button>
          }>
          {error}
        </InlineNotice>
      )}
      {!loading && !error && (
        <div ref={tree} className="file-tree-items" role="tree" aria-label="项目文件夹">
          {rows.map((row, index) => {
            const branch = branches[row.key],
              isExpanded = expanded.has(row.key),
              folder = row.kind === 'directory'
            const next = rows[index + 1]
            const closing: TreeRow[] = []
            let ancestor: TreeRow | undefined = row
            while (ancestor) {
              const followed =
                next
                && next.root === ancestor.root
                && next.depth > ancestor.depth
                && (ancestor.path === '' || next.path.startsWith(`${ancestor.path}/`))
              if (expanded.has(ancestor.key) && !followed) closing.push(ancestor)
              ancestor = ancestor.parent ? byKey.get(ancestor.parent) : undefined
            }
            return (
              <div key={row.key} className="file-tree-node">
                <div
                  role="treeitem"
                  aria-label={row.name}
                  aria-level={row.depth + 1}
                  aria-expanded={folder ? isExpanded : undefined}
                  aria-selected={selected === row.key}
                  aria-disabled={row.kind === 'symlink' || row.kind === 'other' || undefined}
                  data-tree-key={row.key}
                  data-kind={row.kind}
                  data-expanded={isExpanded ? '' : undefined}
                  className="file-tree-row"
                  style={{ '--tree-depth': row.depth } as CSSProperties}
                  tabIndex={selected === row.key || (!selected && index === 0) ? 0 : -1}
                  onFocus={() => setSelected(row.key)}
                  onClick={() => activate(row)}
                  onKeyDown={event => keydown(event, row)}>
                  <Icon
                    icon={folder ? ChevronRight : row.kind === 'symlink' ? Link2 : File}
                    size={14}
                    className={folder ? 'file-tree-chevron' : undefined}
                  />
                  {folder && <Icon icon={Folder} size={14} />}
                  <span className="file-tree-name">
                    <VisibleText text={row.name} />
                  </span>
                  {row.kind === 'symlink' && <small>符号链接</small>}
                  {row.kind === 'file' && (
                    <div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                      <Menu
                        label={`${row.name} 文件操作`}
                        trigger={props => <IconButton {...props} label={`${row.name} 文件操作`} size="xs" icon={Ellipsis} />}
                        sections={[
                          {
                            id: 'file',
                            items: [
                              {
                                id: 'preview',
                                label: '预览文件',
                                icon: File,
                                onSelect: () => open?.(targetIn(context, row.path, row.root)),
                              },
                              {
                                id: 'copy',
                                label: '复制相对路径',
                                icon: Copy,
                                onSelect: () => {
                                  void copy.copy(row.path)
                                },
                              },
                              ...(onMention
                                ? [
                                    {
                                      id: 'quote',
                                      label: '引用到输入框',
                                      icon: TextQuote,
                                      onSelect: () => onMention({ root: row.root, path: row.path }),
                                    },
                                  ]
                                : []),
                            ],
                          },
                        ]}
                      />
                    </div>
                  )}
                </div>
                {folder && isExpanded && branch?.loading && (
                  <p className="file-tree-message">
                    <Loading label={`正在读取 ${row.name}…`} />
                  </p>
                )}
                {folder && isExpanded && branch?.error && (
                  <InlineNotice
                    tone="error"
                    action={
                      <Button
                        size="xs"
                        onClick={() => {
                          void load(row.root, row.path)
                        }}>
                        重试
                      </Button>
                    }>
                    {branch.error}
                  </InlineNotice>
                )}
                {folder && isExpanded && branch?.listing?.entries.length === 0 && <p className="file-tree-message">空文件夹</p>}
                {closing.map(item => {
                  const current = branches[item.key]
                  if (!current?.listing) return null
                  return current.listing.entries.length > current.shown ? (
                    <Button
                      key={item.key}
                      size="xs"
                      variant="ghost"
                      className="file-tree-more"
                      onClick={() =>
                        setBranches(previous => ({ ...previous, [item.key]: { ...previous[item.key]!, shown: current.shown + PAGE_SIZE } }))
                      }>
                      显示更多 · {item.name}
                    </Button>
                  ) : current.listing.truncated ? (
                    <p key={item.key} className="file-tree-message">
                      此目录只显示部分内容，可搜索文件名缩小范围。
                    </p>
                  ) : null
                })}
              </div>
            )
          })}
          {!rows.length && <p className="file-tree-message">这个项目没有可用的文件夹。</p>}
        </div>
      )}
      {clipped && <p className="file-tree-message">先显示 1,000 行。收起一些目录，或搜索文件名。</p>}
      <span role="status" className="sr-only">
        {copy.state === 'copied' ? '已复制路径' : copy.state === 'failed' ? '复制不可用' : ''}
      </span>
    </section>
  )
}
