import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, Plus, WifiOff } from 'lucide-react'
import { GENERAL_AGENT_ID, type CustomAgentList, type CustomAgentSummary } from '@latch/protocol'
import { Button, Hint, ICON_STROKE, IconButton, InlineNotice, Skeleton, EmptyState } from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { useBackLayer } from '../hooks/backStack.ts'
import type { MyAgentTab } from '../shell/routes.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { NavTop, shellSpaces, ShellDelegate, ShellNavFoot } from '../shell/SpaceNav.tsx'
import { AgentsSpaceList, Delegations } from './AgentsSpaceList.tsx'
import { useLastConfirmed } from '../components/SessionStatus.tsx'
import { askDelegateFocus, takeDelegateFocus } from './delegateFocus.ts'
import { AgentForm } from './AgentForm.tsx'
import { AgentPage } from './AgentPage.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { agentActivity, agentEntries, dutyLine, GENERAL_NAME, runsWith, worksIn, type AgentEntry } from './model.ts'
import { ActivityWord, Availability, LockedAgents } from './parts.tsx'
import { useAgentDetail, useAgentList, type AgentRead } from './useAgentData.ts'
import { useAgentWrites } from './useAgentWrites.ts'

const NO_PLUGINS: CustomAgentList['plugins'] = []

/** The second line of an Agent's row: how it runs, or for 通用 that sessions pick their own. */
function entryLine(shell: ShellState, entry: AgentEntry): string {
  return entry.kind === 'general' ? '内置 · 每个会话自己选 Harness' : runsWith(shell.catalog ?? undefined, entry.summary)
}

function EntryMark({ shell, entry }: { shell: ShellState; entry: AgentEntry }) {
  const harness = entry.kind === 'custom' ? shell.catalog?.harnesses.find(item => item.id === entry.summary.harnessId) : undefined
  return harness ? <HarnessTile harness={harness} size={14} /> : null
}

/** The face of an entry and what it shows now; 通用 rests in grey and has no state of its own. */
function EntryAvatar({ shell, entry, size }: { shell: ShellState; entry: AgentEntry; size: number }) {
  if (entry.kind === 'general') return <AgentAvatar avatar="general" size={size} />
  return <AgentAvatar avatar={entry.summary.avatar} size={size} state={agentActivity(shell.snapshot, entry.summary)} />
}

/** The word beside a face: 等你处理 or 运行中 first, then why it cannot start, then a failure. */
function EntryState({ shell, summary, offline }: { shell: ShellState; summary: CustomAgentSummary; offline: boolean }) {
  const state = agentActivity(shell.snapshot, summary)
  if (!offline && (state === 'waiting' || state === 'running')) return <ActivityWord state={state} />
  if (offline || !summary.available)
    return <Availability available={summary.available} reason={summary.unavailableReason} offline={offline} />
  return <ActivityWord state={state} />
}

/** The list's rows while it loads: the size of what they stand for. */
function ListSkeleton() {
  return (
    <ul className="agents-list" aria-busy="true" aria-label="正在读取 Agent">
      {[0, 1, 2].map(row => (
        <li key={row} className="agents-list-row" data-skeleton="">
          <Skeleton width={40} height={40} />
          <span className="agents-list-text">
            <Skeleton width="30%" />
            <Skeleton width="60%" height={12} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The work panel's list (a phone's root page): each Agent with its face, name, duty, how it runs, where it works and
 * whether it can start now; 通用 first, marked as built in. One primary: 委托 the selected Agent, or 新建 Agent when there
 * is none of your own yet.
 */
function AgentList({
  shell,
  read,
  selected,
  offline,
  onOpen,
  onDelegate,
  onNew,
  onRetry,
}: {
  shell: ShellState
  read: AgentRead<CustomAgentList>
  selected: string | undefined
  offline: boolean
  onOpen: (id: string) => void
  onDelegate: (id: string) => void
  onNew: () => void
  onRetry: () => void
}) {
  const list = 'value' in read ? read.value : undefined
  const entries = agentEntries(list)
  const own = entries.filter(entry => entry.kind === 'custom')
  const target = own.find(entry => entry.id === selected) ?? own.find(entry => entry.summary.available) ?? own[0]
  const canRun = shell.access.scopes.has('run')
  return (
    <div className="agents-list-page">
      <div className="agents-list-head">
        <div>
          <h1 className="settings-title">我的 Agent</h1>
          <Hint label="长期替你办事" lead={<span />} className="agents-intro">
            每个 Agent 有职责、执行方式和默认项目；委托它就是开始一个属于它的会话。
          </Hint>
        </div>
        {target && target.kind === 'custom' && canRun && (
          <Button
            variant="primary"
            disabled={offline || !target.summary.available}
            title={offline ? 'Mac 不在线' : target.summary.unavailableReason}
            onClick={() => {
              onDelegate(target.id)
            }}>
            委托{target.name}…
          </Button>
        )}
      </div>
      {read.state === 'locked' && <LockedAgents />}
      {read.state === 'loading' && <ListSkeleton />}
      {read.state === 'failed' && !list && (
        <InlineNotice tone="error" title="读取失败" action={<Button onClick={onRetry}>重试</Button>}>
          {read.message}
        </InlineNotice>
      )}
      {read.state === 'confirming' && (
        <InlineNotice tone="warn" title="正在确认上一项修改">
          结果确认前不能读取或修改 Agent，Mac 会自己重试。
        </InlineNotice>
      )}
      {entries.length > 0 && (
        <ul className="agents-list" aria-label="我的 Agent">
          {entries.map(entry => {
            const duty = entry.kind === 'general' ? '没选别的 Agent 的会话都带上它' : dutyLine(entry.summary)
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className="agents-list-row"
                  aria-current={entry.id === target?.id ? 'true' : undefined}
                  onClick={() => {
                    onOpen(entry.id)
                  }}>
                  <EntryAvatar shell={shell} entry={entry} size={40} />
                  <span className="agents-list-text">
                    <span className="agents-list-name">
                      {entry.name}
                      {entry.kind === 'general' && <span className="agent-builtin">内置</span>}
                    </span>
                    {duty && <span className="agents-list-duty">{duty}</span>}
                    <span className="agents-list-meta">
                      <EntryMark shell={shell} entry={entry} />
                      <span>
                        {entry.kind === 'custom'
                          ? `${entryLine(shell, entry)} · ${worksIn(shell.catalog ?? undefined, entry.summary.defaultProjectId)}`
                          : entryLine(shell, entry)}
                      </span>
                    </span>
                  </span>
                  {entry.kind === 'custom' && <EntryState shell={shell} summary={entry.summary} offline={offline} />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {list && own.length === 0 && (
        <EmptyState
          title="还没有自己的 Agent"
          action={
            canRun ? (
              <Button variant="primary" icon={Plus} disabled={offline} onClick={onNew}>
                新建 Agent
              </Button>
            ) : undefined
          }
        />
      )}
      {list && own.length > 0 && canRun && (
        <Button variant="ghost" icon={Plus} className="agents-new" disabled={offline} onClick={onNew}>
          新建 Agent
        </Button>
      )}
    </div>
  )
}

/** The sidebar's place on wide windows: the same top as the sidebar's in 我的 Agent, its list and the shared foot. */
function AgentsNav({ shell }: { shell: ShellState }) {
  return (
    <div className="sidebar-body agents-nav-body" data-space="agents">
      <NavTop
        snapshot={shell.snapshot}
        spaces={shellSpaces(shell)}
        primary={<ShellDelegate shell={shell} />}
        onSearch={shell.openSearch}
        drawer={false}
        onManageComputers={() => {
          shell.openSettings('computers')
        }}
      />
      <AgentsSpaceList shell={shell} />
      <ShellNavFoot shell={shell} />
    </div>
  )
}

/**
 * 我的 Agent: on wide windows its list stands where the sidebar stands, under 新会话, 搜索, Code and 我的 Agent, and the
 * work panel shows the list page or an Agent's page; on phones the list is the root page and an Agent's page is pushed
 * over it. Like 设置, it covers the session's columns without unmounting them.
 */
export function AgentsPage({ shell }: { shell: ShellState }) {
  const { snapshot, route, phone, connection, titleSlot } = shell
  const offline = connection === 'offline'
  const target = route.myAgent
  const id = target?.id
  const { read, reload } = useAgentList(snapshot)
  const frozen = useLastConfirmed(connection, snapshot)
  const detail = useAgentDetail(snapshot, id ?? null)
  const settle = useCallback(() => {
    reload()
    detail.reload()
    void shell.refresh()
  }, [reload, detail.reload, shell.refresh])
  const writes = useAgentWrites(settle)
  const refreshShell = shell.refresh
  const scheduleWrites = useAgentWrites(useCallback(() => void refreshShell(), [refreshShell]))
  // The Agent last opened is the list's selection, for its 委托 button.
  const [selected, setSelected] = useState<string | undefined>(id && id !== 'new' ? id : undefined)
  useEffect(() => {
    if (id && id !== 'new' && id !== GENERAL_AGENT_ID) setSelected(id)
  }, [id])
  const open = (next?: string, tab?: MyAgentTab) => {
    writes.clear()
    shell.setRoute({ entry: 'agents', ...(next ? { myAgent: { id: next, ...(tab ? { tab } : {}) } } : {}) })
  }
  const back = () => {
    open()
  }
  const pushed = phone && id !== undefined
  useBackLayer(pushed, back)
  const list = 'value' in read ? read.value : undefined
  const name =
    id === 'new'
      ? '新建 Agent'
      : id === GENERAL_AGENT_ID
        ? GENERAL_NAME
        : (list?.agents.find(agent => agent.id === id)?.name ?? snapshot.customAgents?.find(agent => agent.id === id)?.name ?? '')
  const escape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !phone || !pushed || event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest('dialog, [popover]')) return
    back()
  }
  // A list page or the sidebar asked to delegate: the Agent's page opens on 委托 with its input ready, once it is drawn.
  useEffect(() => {
    if (target?.tab !== 'delegate') return
    requestAnimationFrame(() => {
      takeDelegateFocus()
    })
  })
  const locked = read.state === 'locked'
  const panel = (
    <>
      {id === undefined && (
        <AgentList
          shell={shell}
          read={read}
          selected={selected}
          offline={offline}
          onOpen={next => {
            open(next)
          }}
          onDelegate={next => {
            askDelegateFocus()
            open(next, 'delegate')
          }}
          onNew={() => {
            open('new')
          }}
          onRetry={reload}
        />
      )}
      {id === 'new' && snapshot.catalog && (
        <div className="agent-page">
          {!phone && <h1 className="settings-title">新建 Agent</h1>}
          <AgentForm
            catalog={snapshot.catalog}
            access={shell.access}
            plugins={list?.plugins ?? NO_PLUGINS}
            writes={writes}
            disabled={offline || locked}
            onSaved={agent => {
              open(agent.id, 'delegate')
            }}
            onCancel={back}
            {...(shell.owner ? { onManageProviders: shell.manageProviders } : {})}
          />
        </div>
      )}
      {id !== undefined && id !== 'new' && locked && <LockedAgents />}
      {id !== undefined && id !== 'new' && !locked && detail.read.state === 'missing' && (
        <EmptyState title="找不到这个 Agent" description="它可能已在别处删除。" action={<Button onClick={back}>回到列表</Button>} />
      )}
      {id !== undefined && id !== 'new' && !locked && detail.read.state !== 'missing' && (
        <AgentPage
          shell={shell}
          id={id}
          tab={target?.tab}
          value={detail.value}
          loading={detail.read.state === 'loading' || (detail.read.state === 'ready' && !detail.value)}
          {...(detail.read.state === 'failed' ? { failed: detail.read.message } : {})}
          plugins={list?.plugins ?? NO_PLUGINS}
          writes={writes}
          scheduleWrites={scheduleWrites}
          offline={offline}
          onTab={tab => {
            open(id, tab)
          }}
          onReload={settle}
          onDeleted={() => {
            open()
          }}
        />
      )}
    </>
  )
  return (
    <section aria-label="我的 Agent" className="settings-page agents-page" data-entry="agents" onKeyDown={escape}>
      {!phone
        && titleSlot
        && createPortal(
          <div className="agents-crumb">
            {id === undefined ? (
              <span className="titlebar-page-title">我的 Agent</span>
            ) : (
              <>
                <button type="button" className="agents-crumb-link" onClick={back}>
                  我的 Agent
                </button>
                <span aria-hidden="true">/</span>
                <span className="titlebar-page-title">{name}</span>
              </>
            )}
            {offline && (
              <span className="agents-offline">
                <WifiOff size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                Mac 不在线
              </span>
            )}
          </div>,
          titleSlot,
        )}
      <div className="settings-layout" data-level={phone ? (pushed ? 'section' : 'root') : undefined}>
        <div className="settings-nav-pane" inert={pushed || undefined}>
          {phone ? (
            <>
              <header className="settings-bar">
                <span />
                <h2>我的 Agent</h2>
                {offline && (
                  <span className="agents-offline">
                    <WifiOff size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                    不在线
                  </span>
                )}
              </header>
              <div className="settings-scroll">
                <div className="settings-content">
                  {
                    <AgentList
                      shell={shell}
                      read={read}
                      selected={selected}
                      offline={offline}
                      onOpen={next => {
                        open(next)
                      }}
                      onDelegate={next => {
                        askDelegateFocus()
                        open(next, 'delegate')
                      }}
                      onNew={() => {
                        open('new')
                      }}
                      onRetry={reload}
                    />
                  }
                  {read.state !== 'locked' && (
                    <div className="space-list phone-delegations">
                      <Delegations shell={shell} frozen={frozen} />
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <AgentsNav shell={shell} />
          )}
        </div>
        <section
          className="settings-panel"
          aria-label={id === undefined ? '我的 Agent' : name}
          aria-hidden={(phone && !pushed) || undefined}
          inert={(phone && !pushed) || undefined}>
          {phone && (
            <header className="settings-bar">
              <IconButton label="返回" icon={ChevronLeft} onClick={back} />
              <h2>{name}</h2>
            </header>
          )}
          <div className="settings-scroll">
            {(!phone || pushed) && (
              <div key={id ?? 'list'} className="settings-content agents-content settings-enter">
                {panel}
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}
