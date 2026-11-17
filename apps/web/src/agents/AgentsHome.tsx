import { useState } from 'react'

import { GENERAL_AGENT_ID, type TaskSummary } from '@latch/protocol'
import { Button, Count, Icon, PlusGlyph, Skeleton, WaitingGlyph } from '@latch/ui'
import { ConnectionBanners } from '../shell/ConnectionBanners.tsx'
import { WorkbenchDecision } from '../shell/WorkbenchDecision.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentsSpaceList, shellRoster } from './AgentsSpaceList.tsx'
import { readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { addressable, agentsOverview, OVERVIEW_ROWS, rowFor, type RosterRow } from './roster.ts'
import { DEVICE_OFFLINE } from '../core/hostState.ts'

/** A topic's row is signed by its helper: the face and the name, never a project, Harness or model. */
const personOf = (rows: readonly RosterRow[], task: TaskSummary) => {
  const row = rowFor(rows, task)
  return { name: row?.name ?? 'Agent', avatar: row?.avatar ?? ('general' as const) }
}

/** 「还有 N 件」 under a group that holds more than it shows. */
function More({ total, open, onToggle }: { total: number; open: boolean; onToggle: () => void }) {
  if (total <= OVERVIEW_ROWS) return null
  return (
    <Button variant="ghost" className="work-overview-more" aria-expanded={open} onClick={onToggle}>
      {open ? '收起' : `还有 ${total - OVERVIEW_ROWS} 件`}
    </Button>
  )
}

/**
 * 我的 Agent's own 总览: what waits for you across Agents, as decision cards titled with the Agent's name, only while
 * something does; then the helpers, one row each with its face and state, what it is doing or last did, its next
 * scheduled run and its one action. Every row is the Host's summary; offline the last state stays, labelled, and
 * nothing can be decided or sent.
 */
export function AgentsHome({ shell }: { shell: ShellState }) {
  const { snapshot, connection } = shell
  const offline = connection === 'offline'
  const locked = !readsAgents(snapshot)
  const canRun = shell.access.scopes.has('run')
  const rows = locked ? [] : shellRoster(shell)
  const own = rows.filter(row => addressable(row) && row.id !== GENERAL_AGENT_ID)
  const work = agentsOverview(snapshot.tasks, shell.stopping)
  const [opened, setOpened] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  if (locked)
    return (
      <div className="workbench-home agents-home">
        <LockedAgents />
      </div>
    )
  const activeDecision = work.attention.some(task => task.id === opened) ? opened : work.attention[0]?.id
  const loading = snapshot.customAgents === undefined && work.attention.length === 0
  const shown = () => (expanded ? work.attention : work.attention.slice(0, OVERVIEW_ROWS))
  return (
    <div className="workbench-home agents-home">
      <ConnectionBanners shell={shell} />
      {/* What waits for you leads, only while something does; then the helpers themselves, each with its state. */}
      {work.attention.length > 0 && (
        <section className="work-overview agents-home-waiting" aria-label="等你处理">
          <header className="work-overview-group-heading">
            <Icon icon={WaitingGlyph} size={16} />
            <h3>等你处理</h3>
            <Count value={work.attention.length} />
          </header>
          <ul className="work-overview-list">
            {shown().map(task => (
              <li key={task.id}>
                <WorkbenchDecision
                  task={task}
                  shell={shell}
                  person={personOf(rows, task)}
                  emphasis={task.id === activeDecision}
                  expanded={task.id === activeDecision}
                  onExpand={() => {
                    setOpened(task.id)
                  }}
                />
              </li>
            ))}
          </ul>
          <More
            total={work.attention.length}
            open={expanded}
            onToggle={() => {
              setExpanded(value => !value)
            }}
          />
        </section>
      )}
      {loading ? (
        <ul className="work-overview-list agents-home-loading" aria-busy="true" aria-label="正在读取 Agent">
          {[0, 1, 2].map(row => (
            <li key={row}>
              <Skeleton width={36} height={36} />
              <Skeleton width="40%" height={16} />
            </li>
          ))}
        </ul>
      ) : (
        <section className="agents-home-people" aria-label="全部 Agent">
          <header className="work-overview-group-heading">
            <h3>全部 Agent</h3>
            <Count value={rows.filter(addressable).length} />
          </header>
          <AgentsSpaceList shell={shell} page label="全部 Agent" />
          {canRun && own.length === 0 && (
            <Button
              variant="primary"
              icon={PlusGlyph}
              className="agents-home-new"
              disabled={offline}
              tooltip={offline ? DEVICE_OFFLINE : undefined}
              onClick={() => {
                shell.openMyAgent({ id: 'new' })
              }}>
              新建 Agent
            </Button>
          )}
        </section>
      )}
    </div>
  )
}

/**
 * A phone's root page leads with what waits for you: the first card open, the rest as rows that open their topic, and past
 * the first few 「还有 N 件」 as on the wide 总览. Nothing while nothing waits.
 */
export function WaitingCards({ shell }: { shell: ShellState }) {
  const rows = shellRoster(shell)
  const { attention } = agentsOverview(shell.snapshot.tasks, shell.stopping)
  const [all, setAll] = useState(false)
  if (attention.length === 0) return null
  return (
    <section className="work-overview agents-phone-waiting" aria-label="等你处理">
      <ul className="work-overview-list">
        {(all ? attention : attention.slice(0, OVERVIEW_ROWS)).map((task, index) => (
          <li key={task.id}>
            <WorkbenchDecision
              task={task}
              shell={shell}
              person={personOf(rows, task)}
              emphasis={index === 0}
              expanded={index === 0}
              onExpand={() => {
                shell.choose(task.id)
                shell.setRoute({ entry: 'sessions' })
              }}
            />
          </li>
        ))}
      </ul>
      <More
        total={attention.length}
        open={all}
        onToggle={() => {
          setAll(value => !value)
        }}
      />
    </section>
  )
}
