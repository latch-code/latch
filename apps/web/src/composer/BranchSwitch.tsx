import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { readsProjectFiles, type AppSnapshot, type BranchListing, type BranchSwitchResult } from '@latch/protocol'
import {
  Button,
  ICON_STROKE,
  Icon,
  InlineNotice,
  MenuPanel,
  MenuSearch,
  Popover,
  SegmentedControl,
  Spinner,
  Tooltip,
  useLayerClose,
  useLayerOpen,
  BranchGlyph,
  UpDownGlyph,
  type MenuItem,
} from '@latch/ui'
import { BranchName } from '../components/MiddleEllipsis.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { api, ApiError, errorMessage, isUncertain, newRequestId } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { branchRows, choosable, enterChoice, type BranchGroup, type SwitchState } from './branchList.ts'

const COPY = defineCopy(
  {
    label: '分支',
    location: '分支位置',
    local: '本地分支',
    worktrees: '其他工作树',
    tip: (name: string) => `分支 ${name}`,
    trigger: (name: string) => `分支：${name}，切换分支`,
    reading: '正在读取分支',
    none: '没有匹配的分支',
    more: (count: number) => `还有 ${count} 个，搜索查看`,
    omitted: (count: number) => `仓库中另有 ${count} 个分支未列出`,
    held: '已在另一个工作树检出',
    retry: '重试',
    unknown: '没有收到答复，结果未知',
    retrySame: '重试同一请求',
    switching: '正在切换',
    unreadable: '读不到分支',
    hookKind: '仓库自己的配置设置了钩子，切换会运行它们：在终端里切换',
    filterKind: '仓库配置了 filter 驱动（如 Git LFS），切换会运行它：在终端里切换',
  },
  {
    label: 'Branch',
    location: 'Branch location',
    local: 'Local branches',
    worktrees: 'Other worktrees',
    tip: (name: string) => `Branch ${name}`,
    trigger: (name: string) => `Branch: ${name}, switch branch`,
    reading: 'Reading branches',
    none: 'No matching branches',
    more: (count: number) => `${count} more, search to see them`,
    omitted: (count: number) => `${count} other branches in this repository were omitted`,
    held: 'Checked out in another worktree',
    retry: 'Retry',
    unknown: 'No answer; the result is unknown',
    retrySame: 'Retry the same request',
    switching: 'Switching',
    unreadable: 'Couldn’t read branches',
    hookKind: 'The repository sets hooks a switch would run. Switch in a terminal.',
    filterKind: 'The repository has a filter driver (such as Git LFS) a switch would run. Switch in a terminal.',
  },
)

/** Whether this device may switch a project folder's branch: the Host's route, `run`, the project's files, and online. */
export function canSwitchBranch(snapshot: AppSnapshot, access: DeviceAccess, connection: ConnectionStatus): boolean {
  return (
    snapshot.catalog?.features?.branchSwitch === true
    && access.scopes.has('run')
    && readsProjectFiles(snapshot.device.dataScope)
    && connection === 'connected'
  )
}

type ListState = { state: 'reading' } | { state: 'ready'; listing: BranchListing } | { state: 'failed'; message: string }

/** A refusal's words: the Host's, with the kind of setting named for a configuration that keeps the switch from running. */
function refusalText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'branch-switch-config') {
    const kind: unknown = Reflect.get(error.details, 'kind')
    return kind === 'hook' ? COPY.hookKind : kind === 'filter' ? COPY.filterKind : errorMessage(error)
  }
  return errorMessage(error)
}

/**
 * The branch of a project's folder as a control: the name (its middle gives way first) and an up-down mark; pressing it
 * opens the local branches with a search on top, as a popover pinned to it or a sheet on a phone. Choosing one asks the
 * Host to switch; the chip changes only with the Host's answer.
 */
export function BranchSwitch(props: BranchSwitchProps) {
  // Another project is another control: nothing of one project's switch is shown for the next.
  return <ProjectBranchSwitch key={props.projectId} {...props} />
}

interface BranchSwitchProps {
  projectId: string
  /** The branch as the Host shows it (「分离于 3f2a1c9」 for a detached HEAD). */
  branch: string
  variant: 'status' | 'header' | 'subline'
}

function ProjectBranchSwitch({ projectId, branch, variant }: BranchSwitchProps) {
  // The Host answered with a new branch before the snapshot did: shown until the snapshot says anything else, the
  // answer itself or a branch someone switched to since.
  const [landed, setLanded] = useState<{ from: string; to: string }>()
  if (landed && branch !== landed.from) setLanded(undefined)
  const shown = landed ? landed.to : branch
  const [switching, setSwitching] = useState<SwitchState>({ state: 'idle' })
  const busy = switching.state === 'switching'
  return (
    <Popover
      label={COPY.label}
      size="md"
      align="start"
      side="auto"
      maxHeight={420}
      onOpenChange={open => {
        // A refusal was read where it was said; the next time the list opens it starts clean. No answer stays, for its retry.
        if (!open && switching.state === 'refused') setSwitching({ state: 'idle' })
      }}
      trigger={props => (
        <Tooltip content={COPY.tip(escapeHiddenCharacters(shown))}>
          <button
            {...props}
            type="button"
            className={`branch-switch${variant === 'header' ? ' topbar-session-branch' : variant === 'subline' ? ' topbar-branch' : ''}`}
            data-variant={variant}
            data-busy={busy ? '' : undefined}
            aria-label={COPY.trigger(escapeHiddenCharacters(shown))}>
            {busy ? (
              <Spinner size={12} />
            ) : (
              <BranchGlyph size={variant === 'status' ? 12 : 14} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            )}
            <BranchName branch={shown} className="branch-switch-name" />
            <Icon icon={UpDownGlyph} size={12} className="branch-switch-chevron" />
          </button>
        </Tooltip>
      )}>
      <WhenOpen>
        <BranchList
          projectId={projectId}
          switching={switching}
          setSwitching={setSwitching}
          onLanded={to => {
            setLanded({ from: branch, to })
          }}
        />
      </WhenOpen>
    </Popover>
  )
}

/** The list exists only while the layer is open: it is read when it opens, never for a closed chip. */
function WhenOpen({ children }: { children: ReactNode }) {
  return useLayerOpen() ? children : null
}

function BranchList({
  projectId,
  switching,
  setSwitching,
  onLanded,
}: {
  projectId: string
  switching: SwitchState
  setSwitching: (state: SwitchState) => void
  onLanded: (branch: string) => void
}) {
  const close = useLayerClose()
  const [list, setList] = useState<ListState>({ state: 'reading' })
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<BranchGroup>('local')
  const panel = useRef<HTMLDivElement>(null)
  const asked = useRef(0)
  const load = useCallback(() => {
    const ask = ++asked.current
    void api<BranchListing>(`workspaces/${encodeURIComponent(projectId)}/branches`).then(
      listing => {
        if (asked.current === ask) setList({ state: 'ready', listing })
      },
      (cause: unknown) => {
        if (asked.current === ask) setList({ state: 'failed', message: errorMessage(cause) })
      },
    )
  }, [projectId])
  // Read each time the list opens, so it is the folder as it is now.
  useEffect(load, [load])
  const read = () => {
    setList(previous => (previous.state === 'ready' ? previous : { state: 'reading' }))
    load()
  }

  const send = (branch: string, requestId: string) => {
    setSwitching({ state: 'switching', branch, requestId })
    void api<BranchSwitchResult>(`workspaces/${encodeURIComponent(projectId)}/branches/switch`, {
      method: 'POST',
      body: { requestId, branch },
    }).then(
      result => {
        setSwitching({ state: 'idle' })
        onLanded(result.branch)
        close()
      },
      (cause: unknown) => {
        // No answer: the same request goes again, so the Host can say what happened to the first.
        if (isUncertain(cause)) setSwitching({ state: 'unknown', branch, requestId })
        else {
          setSwitching({ state: 'refused', branch, message: refusalText(cause) })
          read()
        }
      },
    )
  }
  const choose = (name: string) => {
    if (switching.state === 'switching') return
    send(name, newRequestId())
  }

  const ready = list.state === 'ready' ? list.listing : undefined
  const hasWorktrees = ready?.branches.some(branch => branch.checkedOut)
  const { rows, hidden } = ready ? branchRows(ready, query, hasWorktrees ? group : 'local') : { rows: [], hidden: 0 }
  const items: MenuItem[] = rows.map(row => ({
    id: row.name,
    label: row.name,
    checked: row.current,
    ...(row.checkedOut ? { disabledReason: COPY.held } : {}),
    ...(switching.state === 'switching' && switching.branch === row.name ? { meta: <Spinner size={12} label={COPY.switching} /> } : {}),
    onSelect: () => {
      if (choosable(row, switching)) choose(row.name)
    },
  }))
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      panel.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const row = enterChoice(rows)
      if (row) choose(row.name)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return (
    <div className="branch-list" data-switching={switching.state === 'switching' ? '' : undefined}>
      <div className="branch-list-filters">
        <MenuSearch label={COPY.label} value={query} onValueChange={setQuery} onKeyDown={searchKeys} />
        {hasWorktrees && (
          <SegmentedControl<BranchGroup>
            label={COPY.location}
            value={group}
            options={[
              { value: 'local', label: COPY.local },
              { value: 'worktrees', label: COPY.worktrees },
            ]}
            onValueChange={next => {
              setGroup(next)
              setQuery('')
            }}
          />
        )}
      </div>
      {switching.state === 'refused' && (
        <InlineNotice tone="warn" className="branch-list-notice">
          {switching.message}
        </InlineNotice>
      )}
      {switching.state === 'unknown' && (
        <InlineNotice
          tone="warn"
          className="branch-list-notice"
          action={
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                send(switching.branch, switching.requestId)
              }}>
              {COPY.retrySame}
            </Button>
          }>
          {COPY.unknown}
        </InlineNotice>
      )}
      {list.state === 'reading' ? (
        <p className="branch-list-state">
          <Spinner size={12} label={COPY.reading} />
        </p>
      ) : list.state === 'failed' ? (
        <p className="branch-list-state" title={list.message}>
          {COPY.unreadable}
          <Button size="xs" variant="ghost" onClick={read}>
            {COPY.retry}
          </Button>
        </p>
      ) : items.length === 0 ? (
        <p className="branch-list-state">{COPY.none}</p>
      ) : (
        <MenuPanel
          label={COPY.label}
          sections={[{ id: 'branches', items }]}
          selection
          panelRef={panel}
          footer={hidden > 0 ? <span className="branch-list-more">{COPY.more(hidden)}</span> : undefined}
          onChoose={item => {
            item.onSelect()
          }}
          onDismiss={reason => {
            if (reason === 'escape') close()
          }}
        />
      )}
      {!!ready?.more && !query.trim() && <p className="branch-list-state branch-list-more">{COPY.omitted(ready.more)}</p>}
    </div>
  )
}
