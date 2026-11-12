import { useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Link2, MessageSquareQuote } from 'lucide-react'
import { isFileDirectoryListing, type FileChange, type FileContext, type FileDirectoryListing, type FileMention } from '@latch/protocol'
import {
  Button,
  Icon,
  IconButton,
  InlineNotice,
  Kbd,
  Loading,
  Menu,
  Tooltip,
  useCopy,
  type MenuItem,
  CopyGlyph,
  MoreGlyph,
  ExternalGlyph,
  EyeGlyph,
  FolderGlyph,
  FolderOpenGlyph,
  RefreshGlyph,
  SearchGlyph,
} from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { fileRefusalText } from '../core/securityCopy.ts'
import { currentShell, revealLabel, shellFiles } from '../core/shell.ts'
import { referenceIcon } from '../fileReference.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { FileOpenContext, fileContextBody, fileContextKey, fileRoute, targetIn } from './fileContext.ts'
import { readTreeFile, soleFolder, treeChanges, treeFullPath, treeKey as branchKey, treeLocation, type FileTreeView } from './treeFiles.ts'

type Branch = { listing?: FileDirectoryListing; loading?: boolean; error?: string; shown: number }
type TreeRow = {
  key: string
  parent?: string
  root: string
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  depth: number
  /** The folders this row stands for when single children read as one row, outermost first. */
  chain?: string[]
}
const PAGE_SIZE = 100
const CACHE_LIMIT = 32

/** Lazily reads one directory. Collapsed branches never issue recursive requests. */
export function FileTree({
  context,
  onSearch,
  onMention,
  local = false,
  folders,
  cwd,
  fileChanges = [],
  revision,
  initialView,
  onViewChange,
  rootReveal,
}: {
  context: FileContext
  /** Opens ⌘P; absent on a device that cannot search. */
  onSearch?(): void
  /** The folder itself, through the desktop shell's folder bridge; absent elsewhere. */
  /** The action for a root that can be shown in the file manager as the folder this tree is listing. */
  rootReveal?(rootId: string): (() => void) | undefined
  onMention?(mention: FileMention): void
  local?: boolean
  folders?: readonly { id: string; path: string }[]
  cwd?: string
  fileChanges?: readonly FileChange[]
  /** Changes only when a Host-observed file set or run generation changes, never for each streamed text chunk. */
  revision?: string | number
  initialView?: FileTreeView
  onViewChange?(view: FileTreeView): void
}) {
  const open = useContext(FileOpenContext)
  const copy = useCopy()
  const [roots, setRoots] = useState<FileDirectoryListing['roots']>([])
  const [branches, setBranches] = useState<Record<string, Branch>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialView?.expanded ?? []))
  const [selected, setSelected] = useState<string | undefined>(initialView?.selected)
  const [showHidden, setShowHidden] = useState(initialView?.showHidden ?? false)
  const changedView = useRef(onViewChange)
  changedView.current = onViewChange
  useEffect(() => {
    changedView.current?.({ expanded: [...expanded].slice(0, CACHE_LIMIT), selected, showHidden })
  }, [expanded, selected, showHidden])
  const [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false),
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
  const lastContext = useRef<{ key: string; showHidden: boolean } | undefined>(undefined)
  const nativeLocal = useRef(local)
  nativeLocal.current = local
  const action = useRef<AbortController | undefined>(undefined)
  const [acting, setActing] = useState(false)
  const changes = treeChanges(fileChanges)
  useEffect(
    () => () => {
      action.current?.abort()
      action.current = undefined
      setActing(false)
    },
    [contextKey, local],
  )
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
          setBranches(previous => ({ ...previous, [key]: { listing: result, shown: previous[key]?.shown ?? PAGE_SIZE } }))
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setBranches(previous => ({
            ...previous,
            [key]: { loading: false, error: errorMessage(cause), shown: PAGE_SIZE },
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
    const priorExpanded = [...openBranches.current]
    const reset = lastContext.current?.key !== contextKey || lastContext.current.showHidden !== showHidden
    lastContext.current = { key: contextKey, showHidden }
    if (reset) setLoading(true)
    else setRefreshing(true)
    setError('')
    setNotice('')
    if (reset) {
      setRoots([])
      setBranches({})
      loadedBranches.current.clear()
    }
    const params = new URLSearchParams(fileContextBody(contextRef.current))
    void api<unknown>(`${fileRoute(contextRef.current, 'list')}?${params}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return
        if (!isFileDirectoryListing(result) || fileContextKey(result.context) !== contextKey) throw new Error('项目文件响应无效。')
        setRoots(result.roots)
        const first = result.roots[0]
        if (first) {
          const available = new Set(result.roots.map(root => root.id))
          const preferred = reset ? priorExpanded : [...openBranches.current]
          const opened = (preferred.length ? preferred : [branchKey(first.id, '')]).flatMap(key => {
            const location = treeLocation(key)
            return location && available.has(location.root) ? [location] : []
          })
          if (!opened.length) opened.push({ root: first.id, path: '' })
          setExpanded(new Set(opened.map(location => branchKey(location.root, location.path))))
          setBranches(previous =>
            Object.fromEntries(
              Object.entries(previous).filter(([key]) => {
                const location = treeLocation(key)
                return location && available.has(location.root)
              }),
            ),
          )
          for (const location of opened) void load(location.root, location.path)
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted) {
          setRoots([])
          setBranches({})
          loadedBranches.current.clear()
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
          setRefreshing(false)
        }
      })
    return () => {
      controller.abort()
      for (const request of controllers.current.values()) request.abort()
      controllers.current.clear()
    }
  }, [contextKey, generation, showHidden, revision])
  // A folder whose only entry is a folder reads as one row, so opening one opens the rest of the run.
  useEffect(() => {
    for (const key of expanded) {
      const location = treeLocation(key)
      const only = soleFolder(branches[key]?.listing)
      if (!location || !only || location.path === '') continue
      const child = branchKey(location.root, `${location.path}/${only}`)
      if (expanded.has(child)) continue
      setExpanded(previous => new Set(previous).add(child))
      if (!branches[child]?.listing) void load(location.root, `${location.path}/${only}`)
    }
  }, [branches, expanded, load])
  const fileAction = async (row: TreeRow, kind: 'copy' | 'reveal' | 'open' | 'quickLook') => {
    if (action.current || !local) return
    const controller = new AbortController()
    action.current = controller
    setActing(true)
    setNotice('')
    try {
      const file = await readTreeFile(context, { root: row.root, path: row.path }, controller.signal)
      if (!nativeLocal.current || fileContextKey(contextRef.current) !== contextKey) return
      if (kind === 'copy') {
        const path = treeFullPath(file, folders, cwd)
        if (!path) throw new Error('找不到这个文件所属的冻结文件夹，请重新同步会话。')
        await copy.copy(path)
      } else {
        const shell = shellFiles()
        const allowed = kind === 'reveal' ? file.actions.reveal : kind === 'open' ? file.actions.open : file.actions.quicklook
        if (!shell || shell.protocolVersion !== 2 || !allowed) throw new Error('当前桌面端无法这样打开这个文件。')
        const result = await shell[kind](
          context.kind === 'session' ? context.sessionId : { workspaceId: context.workspaceId, harnessId: context.harnessId },
          { handle: file.handle },
        )
        if (result.status === 'busy') throw new Error('上一个文件操作还没有完成，请稍后重试。')
        if (result.status === 'refused' || result.status === 'failed') throw new Error(fileRefusalText(result.code))
      }
    } catch (cause) {
      if (!controller.signal.aborted) setNotice(errorMessage(cause))
    } finally {
      if (action.current === controller) {
        action.current = undefined
        setActing(false)
      }
    }
  }
  const rowMenu = (element: HTMLElement, row: TreeRow) => {
    const button = element.querySelector<HTMLButtonElement>('[data-tree-menu]')
    if (!button) return false
    setSelected(row.key)
    button.focus({ preventScroll: true })
    if (button.getAttribute('aria-expanded') !== 'true') button.click()
    return true
  }
  const rows: TreeRow[] = []
  let clipped = false
  const append = (first: TreeRow) => {
    if (rows.length >= 1000) {
      clipped = true
      return
    }
    let row = first
    if (row.kind === 'directory' && row.depth > 0)
      for (
        let only = soleFolder(branches[row.key]?.listing);
        only && expanded.has(row.key);
        only = soleFolder(branches[row.key]?.listing)
      ) {
        const path = `${row.path}/${only}`
        row = {
          ...row,
          key: branchKey(row.root, path),
          path,
          name: `${row.name}/${only}`,
          chain: [...(row.chain ?? [row.key]), branchKey(row.root, path)],
        }
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
  // The selection can name a folder a merged row has since absorbed.
  const current = rows.find(row => row.key === selected || (selected !== undefined && row.chain?.includes(selected)))?.key
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
    // A run closes into its first folder, so the row's place in the tab order has to follow it there.
    if (!value && row.chain?.[0]) setSelected(row.chain[0])
    setExpanded(previous => {
      const next = new Set(previous)
      if (value) next.add(row.key)
      else for (const key of row.chain ?? [row.key]) next.delete(key)
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
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      if (rowMenu(event.currentTarget, row)) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
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
  const busy = acting ? { disabledReason: '请等待当前文件操作完成。' } : {}
  const rootItems = (row: TreeRow): MenuItem[] => {
    const path = folders?.length ? folders.find(folder => folder.id === row.root)?.path : cwd
    const reveal = rootReveal?.(row.root)
    return [
      ...(path
        ? [
            {
              id: 'copy',
              label: '复制路径',
              icon: CopyGlyph,
              onSelect: () => {
                void copy.copy(path)
              },
            },
          ]
        : []),
      ...(reveal ? [{ id: 'reveal', label: revealLabel(currentShell()?.platform), icon: FolderOpenGlyph, onSelect: reveal }] : []),
    ]
  }
  const fileItems = (row: TreeRow): MenuItem[] => {
    const full = local ? treeFullPath({ root: row.root, path: row.path }, folders, cwd) : undefined
    const native = local && shellFiles()?.protocolVersion === 2
    return [
      ...(onMention
        ? [
            {
              id: 'quote',
              label: '引用到对话',
              icon: MessageSquareQuote,
              onSelect: () => {
                onMention({ root: row.root, path: row.path })
              },
            },
          ]
        : []),
      full
        ? { id: 'copy', label: '复制路径', icon: CopyGlyph, ...busy, onSelect: () => void fileAction(row, 'copy') }
        : {
            id: 'copy',
            label: '复制路径',
            icon: CopyGlyph,
            onSelect: () => {
              void copy.copy(row.path)
            },
          },
      ...(full
        ? [
            {
              id: 'copy-relative',
              label: '复制相对路径',
              icon: CopyGlyph,
              onSelect: () => {
                void copy.copy(row.path)
              },
            },
          ]
        : []),
      ...(native
        ? [
            {
              id: 'reveal',
              label: revealLabel(currentShell()?.platform),
              icon: FolderOpenGlyph,
              ...busy,
              onSelect: () => void fileAction(row, 'reveal'),
            },
            { id: 'open', label: '用默认应用打开', icon: ExternalGlyph, ...busy, onSelect: () => void fileAction(row, 'open') },
            { id: 'quicklook', label: '快速查看', icon: EyeGlyph, ...busy, onSelect: () => void fileAction(row, 'quickLook') },
          ]
        : []),
    ]
  }
  return (
    <section className="file-tree" aria-label="项目文件">
      <header className="file-tree-head">
        {onSearch ? (
          <button type="button" className="file-tree-search" aria-label="搜索文件" onClick={onSearch}>
            <Icon icon={SearchGlyph} size={14} />
            <span>搜索文件</span>
            <Kbd keys="mod+p" />
          </button>
        ) : (
          <span className="file-tree-search-gap" />
        )}
        <Menu
          label="文件显示选项"
          align="end"
          trigger={props => <IconButton {...props} size="xs" label="文件显示选项" icon={MoreGlyph} />}
          sections={[
            {
              id: 'view',
              items: [
                {
                  id: 'hidden',
                  label: '显示隐藏项',
                  description: '也列出点开头的文件和生成目录',
                  checked: showHidden,
                  onSelect: () => setShowHidden(value => !value),
                },
                { id: 'refresh', label: '刷新文件树', icon: RefreshGlyph, onSelect: () => setGeneration(value => value + 1) },
              ],
            },
          ]}
        />
      </header>
      {notice && <InlineNotice>{notice}</InlineNotice>}
      {loading && <Loading label="正在读取项目文件…" />}
      <span className="sr-only" role="status">
        {refreshing ? '正在更新已展开的文件夹' : acting ? '正在核对文件' : ''}
      </span>
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
              // A run's key grows as it opens; the element has to survive that or focus falls out of the tree.
              <div key={row.chain?.[0] ?? row.key} className="file-tree-node">
                <div
                  role="treeitem"
                  aria-label={row.name}
                  aria-level={row.depth + 1}
                  aria-expanded={folder ? isExpanded : undefined}
                  aria-selected={current === row.key}
                  aria-disabled={row.kind === 'symlink' || row.kind === 'other' || undefined}
                  data-tree-key={row.key}
                  data-kind={row.kind}
                  data-expanded={isExpanded ? '' : undefined}
                  className="file-tree-row"
                  style={{ '--tree-depth': row.depth } as CSSProperties}
                  tabIndex={current === row.key || (!current && index === 0) ? 0 : -1}
                  onFocus={() => setSelected(row.key)}
                  onClick={() => activate(row)}
                  onContextMenu={event => {
                    if (rowMenu(event.currentTarget, row)) {
                      event.preventDefault()
                      event.stopPropagation()
                    }
                  }}
                  onKeyDown={event => keydown(event, row)}>
                  <Icon
                    icon={folder ? (isExpanded ? FolderOpenGlyph : FolderGlyph) : row.kind === 'symlink' ? Link2 : referenceIcon(row.name)}
                    size={14}
                  />
                  <span className="file-tree-name">
                    <VisibleText text={row.name} />
                  </span>
                  {row.kind === 'file' && changes.has(row.key) && (
                    <Tooltip content="本轮运行期间有变化，也可能包含其他程序的改动。">
                      <span className="file-tree-change" aria-label="本轮运行期间有变化" />
                    </Tooltip>
                  )}
                  {row.kind === 'symlink' && <small>符号链接</small>}
                  {(row.kind === 'file' || row.path === '') && (
                    <div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                      <Menu
                        label={`${row.name} 文件操作`}
                        align="end"
                        trigger={props => (
                          <IconButton {...props} data-tree-menu="" label={`${row.name} 文件操作`} size="xs" icon={MoreGlyph} />
                        )}
                        sections={[
                          {
                            id: 'file',
                            items: row.path === '' ? rootItems(row) : fileItems(row),
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
