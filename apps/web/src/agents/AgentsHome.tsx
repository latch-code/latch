import { useEffect, useRef, useState } from 'react'

import { GENERAL_AGENT_ID, type TaskSummary } from '@latch/protocol'
import {
  Button,
  CheckGlyph,
  ChevronDownGlyph,
  Count,
  FilterPills,
  ICON_STROKE,
  Icon,
  LockGlyph,
  PlusGlyph,
  RunningGlyph,
  Skeleton,
  StatusGlyph,
  WaitingGlyph,
} from '@latch/ui'
import { Menu } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { runClock, runElapsed } from '../conversation.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { relativeTime } from '../format.ts'
import { ConnectionBanners } from '../shell/ConnectionBanners.tsx'
import { WorkbenchDecision } from '../shell/WorkbenchDecision.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { shellRoster } from './AgentsSpaceList.tsx'
import { takeDelegateFocus } from './delegateFocus.ts'
import { NewTopic } from './NewTopic.tsx'
import { readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { personActivity } from './personWords.ts'
import { addressable, addressee, agentsOverview, defaultAddressee, OVERVIEW_ROWS, rowFor, type RosterRow } from './roster.ts'

/** A topic's row is signed by its helper: the face and the name, never a project, Harness or model. */
const personOf = (rows: readonly RosterRow[], task: TaskSummary) => {
  const row = rowFor(rows, task)
  return { name: row?.name ?? 'Agent', avatar: row?.avatar ?? ('general' as const) }
}

/** Who is working: the face and the name with the run's time, then what it is doing (only what the Host reports) and the topic. */
function WorkingRow({ shell, task, rows }: { shell: ShellState; task: TaskSummary; rows: readonly RosterRow[] }) {
  const connected = shell.connection === 'connected'
  useTicker(connected ? 'second' : false)
  const lastNow = useRef(hostNow())
  if (connected) lastNow.current = hostNow()
  const person = personOf(rows, task)
  const stopping = shell.stopping.has(task.id) || task.live?.activity === 'cancelling'
  const word = stopping ? '在停下' : personActivity(task.live)?.words
  const elapsed = task.live ? runElapsed(task.live, lastNow.current) : undefined
  return (
    <Button
      variant="ghost"
      className="work-overview-row agents-home-row"
      data-work-session={task.id}
      onClick={() => {
        shell.choose(task.id)
        shell.setRoute({ entry: 'sessions' })
      }}>
      <span className="work-overview-row-head">
        <span className="agents-home-who">
          <AgentAvatar avatar={person.avatar} size={22} state={connected ? 'running' : 'idle'} />
          <span className="work-overview-row-title">
            <VisibleText text={person.name} />
          </span>
        </span>
        {elapsed !== undefined && <span className="work-running-time">{runClock(elapsed)}</span>}
      </span>
      <span className="work-running-line">
        {word && (
          <span className="work-running-action">
            <StatusGlyph running={connected} state={stopping ? 'stopping' : 'running'}>
              <Icon icon={RunningGlyph} size={12} />
            </StatusGlyph>
            <span>{connected ? word : `上次状态：${word}`}</span>
          </span>
        )}
        <span className="work-running-project">
          <VisibleText text={task.title || '未命名会话'} />
        </span>
      </span>
    </Button>
  )
}

/** A result: whose it is, the topic it came from, and when the run completed. */
function ResultRow({ shell, task, rows }: { shell: ShellState; task: TaskSummary; rows: readonly RosterRow[] }) {
  const person = personOf(rows, task)
  return (
    <Button
      variant="ghost"
      className="work-overview-row agents-home-row"
      data-work-session={task.id}
      onClick={() => {
        shell.choose(task.id)
        shell.setRoute({ entry: 'sessions' })
      }}>
      <span className="work-overview-row-head">
        <span className="agents-home-who">
          <AgentAvatar avatar={person.avatar} size={22} />
          <span className="work-overview-row-title">
            <VisibleText text={person.name} />
          </span>
        </span>
        <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt, new Date(shell.now))}</time>
      </span>
      <span className="work-overview-row-context">
        <span>
          <VisibleText text={task.title || '未命名会话'} />
        </span>
      </span>
    </Button>
  )
}

/** The 总览 is still what is shown: a start answered now opens its topic; a person who went elsewhere stays there. */
const onHome = (route: ShellState['route']) => route.entry === 'agents' && route.myAgent === undefined && !route.topics

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
 * The chip over the 总览's input: who the next message goes to. The Agent last spoken with by default (else 通用); one
 * that cannot start now is listed with its reason and cannot be picked.
 */
function Addressee({
  rows,
  value,
  disabled,
  onChange,
}: {
  rows: readonly RosterRow[]
  value: RosterRow | undefined
  disabled: boolean
  onChange: (id: string) => void
}) {
  const choices = rows.filter(addressable)
  return (
    <div className="agents-home-to">
      <Menu
        label="发给谁"
        placement="bottom-start"
        selection
        sections={[
          {
            id: 'agents',
            items: choices.map(row => ({
              id: row.id,
              label: row.name,
              leading: <AgentAvatar avatar={row.avatar} size={16} />,
              checked: row.id === value?.id,
              ...(row.unavailable ? { disabled: true, disabledReason: row.unavailable } : {}),
              onSelect: () => {
                onChange(row.id)
              },
            })),
          },
        ]}
        trigger={props => (
          <Button {...props} variant="ghost" size="sm" className="agents-home-chip" aria-label="发给谁" disabled={disabled}>
            {value && <AgentAvatar avatar={value.avatar} size={16} />}
            <span>{value ? <VisibleText text={value.name} /> : '选择 Agent'}</span>
            <ChevronDownGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          </Button>
        )}
      />
    </div>
  )
}

/**
 * 我的 Agent's own 总览, the same in both layouts as Code's is: the input, which starts a new topic with the Agent in its
 * chip; what waits for you across Agents, as the decision cards Code's 总览 uses, titled with the Agent's name; who is
 * working; and the latest results. Every row is a topic's summary as the Host gives it. With no topic yet only the input
 * and one quiet line show; offline the last rows stay, still and labelled, and nothing can be decided or sent.
 */
export function AgentsHome({ shell }: { shell: ShellState }) {
  const { snapshot, connection } = shell
  const offline = connection === 'offline'
  const locked = !readsAgents(snapshot)
  const canRun = shell.access.scopes.has('run')
  const layout = shell.preferences.workbenchLayout
  const rows = locked ? [] : shellRoster(shell)
  const own = rows.filter(row => addressable(row) && row.id !== GENERAL_AGENT_ID)
  const work = agentsOverview(snapshot.tasks, shell.stopping)
  // Who the input addresses is picked once, when the 总览 opens (the Agent last spoken with, else 通用). After that only
  // the person moves the chip: a topic that stirs elsewhere must not remount the input under the typist, drop its focus
  // or attachments, or send what is being written to somebody else.
  const [picked, setPicked] = useState(() => defaultAddressee(rows))
  const draftState = useState('')
  const [opened, setOpened] = useState<string>()
  // Narrow, the 顶栏 layout's three lanes are one at a time, picked by these pills, as on Code's 总览.
  const [lane, setLane] = useState<'attention' | 'running' | 'results'>('attention')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  // The key of 新会话 asked for the input: it takes the keys once it is drawn.
  useEffect(() => {
    requestAnimationFrame(() => {
      takeDelegateFocus()
    })
  })
  if (locked)
    return (
      <div className="workbench-home agents-home">
        <LockedAgents />
      </div>
    )
  const to = addressee(rows, picked)
  const agent = to ? snapshot.customAgents?.find(item => item.id === to.id) : undefined
  const activeDecision = work.attention.some(task => task.id === opened) ? opened : work.attention[0]?.id
  const loading = snapshot.customAgents === undefined
  const empty = work.attention.length + work.running.length + work.results.length === 0
  const shown = (id: 'attention' | 'running' | 'results') => (expanded.has(id) ? work[id] : work[id].slice(0, OVERVIEW_ROWS))
  return (
    <div className="workbench-home agents-home" data-layout={layout}>
      <ConnectionBanners shell={shell} />
      <div className="workbench-home-composer">
        {!canRun ? (
          <p className="agents-home-readonly">
            <LockGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            这台设备只能看
          </p>
        ) : (
          to && (
            <NewTopic
              key={to.id}
              shell={shell}
              owner={to.id}
              agent={agent}
              name={to.name}
              offline={offline}
              draftState={draftState}
              showing={onHome}
              lead={<Addressee rows={rows} value={to} disabled={shell.delegation.sending} onChange={setPicked} />}
            />
          )
        )}
      </div>
      {/* While the Host withholds the list of Agents the topics are still its own: what waits for you stays drawn. */}
      {loading && empty ? (
        <ul className="work-overview-list agents-home-loading" aria-busy="true" aria-label="正在读取 Agent">
          {[0, 1, 2].map(row => (
            <li key={row}>
              <Skeleton width={22} height={22} />
              <Skeleton width="40%" height={16} />
            </li>
          ))}
        </ul>
      ) : !loading && own.length === 0 ? (
        <section className="workbench-empty" aria-label="我的 Agent 总览">
          <h2>还没有自己的 Agent</h2>
          {canRun && (
            <div className="workbench-empty-actions">
              <Button
                variant="primary"
                icon={PlusGlyph}
                disabled={offline}
                tooltip={offline ? 'Mac 不在线' : undefined}
                onClick={() => {
                  shell.openMyAgent({ id: 'new' })
                }}>
                新建 Agent
              </Button>
            </div>
          )}
        </section>
      ) : null}
      {(!empty || (!loading && own.length > 0)) && (
        <section className="work-overview" data-layout={layout} aria-label="我的 Agent 总览">
          {empty ? (
            <p className="work-overview-empty">没有要你处理的</p>
          ) : (
            <FilterPills
              className="work-overview-lanes"
              label="分拣话题"
              value={lane}
              options={[
                { value: 'attention', label: `等你处理 ${work.attention.length}` },
                { value: 'running', label: `在工作 ${work.running.length}` },
                { value: 'results', label: `最近结果 ${work.results.length}` },
              ]}
              onValueChange={setLane}
            />
          )}
          {!empty && (
            <div className="work-overview-groups">
              <section
                className="work-overview-group"
                data-group="attention"
                data-active={lane === 'attention' ? '' : undefined}
                aria-label="等你处理">
                <header className="work-overview-group-heading">
                  <Icon icon={WaitingGlyph} size={16} />
                  <h3>等你处理</h3>
                  <Count value={work.attention.length} />
                </header>
                {work.attention.length === 0 ? (
                  <p className="work-overview-empty">没有要你处理的</p>
                ) : (
                  <ul className="work-overview-list">
                    {shown('attention').map((task, index) => (
                      <li key={task.id}>
                        <WorkbenchDecision
                          task={task}
                          shell={shell}
                          person={personOf(rows, task)}
                          emphasis={layout === 'overview' ? task.id === activeDecision : index === 0}
                          expanded={layout === 'triage' || task.id === activeDecision}
                          onExpand={() => {
                            setOpened(task.id)
                          }}
                          firstKeys={layout === 'triage' && index === 0}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                <More
                  total={work.attention.length}
                  open={expanded.has('attention')}
                  onToggle={() => {
                    toggle('attention')
                  }}
                />
              </section>
              <section
                className="work-overview-group"
                data-group="running"
                data-active={lane === 'running' ? '' : undefined}
                aria-label="在工作">
                <header className="work-overview-group-heading">
                  <Icon icon={RunningGlyph} size={16} />
                  <h3>在工作</h3>
                  <Count value={work.running.length} />
                </header>
                {work.running.length === 0 ? (
                  <p className="work-overview-empty">没有在工作的</p>
                ) : (
                  <ul className="work-overview-list">
                    {shown('running').map(task => (
                      <li key={task.id}>
                        <WorkingRow shell={shell} task={task} rows={rows} />
                      </li>
                    ))}
                  </ul>
                )}
                <More
                  total={work.running.length}
                  open={expanded.has('running')}
                  onToggle={() => {
                    toggle('running')
                  }}
                />
              </section>
              <section
                className="work-overview-group"
                data-group="delivery"
                data-kind="results"
                data-active={lane === 'results' ? '' : undefined}
                aria-label="最近结果">
                <header className="work-overview-group-heading">
                  <Icon icon={CheckGlyph} size={16} />
                  <h3>最近结果</h3>
                  <Count value={work.results.length} />
                </header>
                {work.results.length === 0 ? (
                  <p className="work-overview-empty">还没有结果</p>
                ) : (
                  <ul className="work-overview-list">
                    {shown('results').map(task => (
                      <li key={task.id}>
                        <ResultRow shell={shell} task={task} rows={rows} />
                      </li>
                    ))}
                  </ul>
                )}
                <More
                  total={work.results.length}
                  open={expanded.has('results')}
                  onToggle={() => {
                    toggle('results')
                  }}
                />
              </section>
            </div>
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
    <section className="work-overview agents-phone-waiting" data-layout="triage" aria-label="等你处理">
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
