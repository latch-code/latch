import { useState, type ReactNode } from 'react'

import { GENERAL_AGENT_ID, type TaskSummary } from '@latch/protocol'
import {
  Button,
  Count,
  ChevronRightGlyph,
  Icon,
  MessageGlyph,
  OverviewGlyph,
  RunningGlyph,
  ScheduleGlyph,
  Skeleton,
  StatusWord,
  WaitingGlyph,
} from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { startBlock } from '../composerChoice.ts'
import { useLastConfirmed } from '../components/SessionStatus.tsx'
import { ConnectionBanners } from '../shell/ConnectionBanners.tsx'
import { WorkbenchDecision } from '../shell/WorkbenchDecision.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { AgentsSpaceList, shellRoster } from './AgentsSpaceList.tsx'
import { generalChoice, readsAgents, RUN_WORDS } from './model.ts'
import { isPersonalChat, personalChat } from './chat.ts'
import { askDelegateFocus } from './delegateFocus.ts'
import { LockedAgents } from './parts.tsx'
import { addressable, agentsOverview, OVERVIEW_ROWS, rowFor, type RosterRow } from './roster.ts'
import { scheduleOverview, whenWords } from './scheduleModel.ts'
import { AGENT_SPACE_COPY as COPY } from './spaceCopy.ts'

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
      {open ? COPY.collapse : COPY.more(total - OVERVIEW_ROWS)}
    </Button>
  )
}

function WorkRow({
  title,
  agent,
  at,
  now,
  action,
  status,
  link,
}: {
  title: string
  agent: RosterRow | undefined
  at: string
  now: number
  action?: () => void
  status?: ReactNode
  link?: string
}) {
  const content = (
    <>
      <AgentAvatar avatar={agent?.avatar ?? 'general'} size={22} />
      <span className="agents-home-schedule-text">
        <span className="work-overview-row-title">
          <VisibleText text={title} />
        </span>
        <span className="work-overview-row-context">
          {agent && (
            <span>
              <VisibleText text={agent.name} />
            </span>
          )}
          {agent?.workComputer && <span>{COPY.workComputer}</span>}
          <time dateTime={at}>{whenWords(at, now)}</time>
        </span>
      </span>
      {status}
      {link && (
        <span className="agents-home-link">
          {link}
          <Icon icon={ChevronRightGlyph} size={14} />
        </span>
      )}
    </>
  )
  return action ? (
    <Button variant="ghost" className="agents-home-schedule-row" onClick={action}>
      {content}
    </Button>
  ) : (
    <div className="agents-home-schedule-row">{content}</div>
  )
}

/** Only the Host's current chat can be resumed. A recent scheduled run or retired chat has its own destination. */
export function agentsHomeData({ snapshot, stopping }: Pick<ShellState, 'snapshot' | 'stopping'>) {
  const { attention, running } = agentsOverview(snapshot.tasks, stopping)
  const { results, upcoming } = scheduleOverview(snapshot.automations, attention)
  const recent = snapshot.tasks
    .filter(task => !task.archived && !task.automationId && isPersonalChat(snapshot, task))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0]
  return { attention, running, results, upcoming, recent }
}

function FirstTask({ shell }: { shell: ShellState }) {
  const { snapshot, access, connection, catalog } = shell
  const chat = personalChat(snapshot, GENERAL_AGENT_ID)
  const block = startBlock(snapshot, generalChoice(catalog ?? undefined))
  const canRun = access.scopes.has('run')
  const online = connection === 'connected'
  const model = block?.kind === 'model-required'
  const setup = model ? shell.manageProviders : shell.owner ? () => shell.openSettings('engines') : undefined
  const pending = shell.delegation.pending?.customAgentId === GENERAL_AGENT_ID
  const canAddress = chat?.state === 'ready' || pending || (online && canRun && chat?.state === 'empty' && !block)
  const blocked = !pending && chat?.state === 'empty' && block
  let detail = COPY.firstTaskDetail
  if (!canRun) detail = COPY.viewOnly
  else if (blocked) detail = setup ? blocked.message : model ? COPY.needsModel : COPY.needsHarness
  else if (catalog && !catalog.features?.singleAgentChat) detail = COPY.updateChat
  else if (!chat || chat.state === 'starting') detail = COPY.confirming
  return (
    <section className="agents-first-task" aria-labelledby="agents-first-title">
      <AgentAvatar avatar="general" size={40} />
      <h2 id="agents-first-title">{canAddress && canRun ? COPY.firstTask : COPY.general}</h2>
      <p>{detail}</p>
      {canAddress && (
        <Button
          variant="primary"
          icon={MessageGlyph}
          onClick={() => {
            if (chat?.state === 'empty' && !pending) askDelegateFocus()
            shell.openMyAgent({ id: GENERAL_AGENT_ID })
          }}>
          {COPY.talkToGeneral}
        </Button>
      )}
      {blocked && canRun && setup && online && <Button onClick={setup}>{model ? COPY.configureModel : COPY.configureHarness}</Button>}
    </section>
  )
}

/** Decisions come first, then a way back to the work represented by the snapshot. */
export function AgentsHome({ shell, compact = false }: { shell: ShellState; compact?: boolean }) {
  const { snapshot, now } = shell
  const { attention, running, results, upcoming, recent } = agentsHomeData(shell)
  const frozen = useLastConfirmed(shell.connection, snapshot)
  const locked = !readsAgents(snapshot)
  const rows = locked ? [] : shellRoster(shell)
  const [opened, setOpened] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const [allRunning, setAllRunning] = useState(false)
  if (locked)
    return (
      <div className="workbench-home agents-home">
        <LockedAgents />
      </div>
    )
  const activeDecision = attention.some(task => task.id === opened) ? opened : attention[0]?.id
  const agentOf = (automation: { customAgentId?: string }) => rows.find(row => row.id === (automation.customAgentId ?? GENERAL_AGENT_ID))
  return (
    <div className={compact ? 'agents-home agents-home-compact' : 'workbench-home agents-home'}>
      <div className="agents-home-content">
        {!compact && <ConnectionBanners shell={shell} />}
        {attention.length > 0 && (
          <section className="work-overview work-overview-group agents-home-waiting" data-group="attention" aria-label={COPY.needsYou}>
            <header className="work-overview-group-heading">
              <Icon icon={WaitingGlyph} size={16} />
              <h3>{COPY.needsYou}</h3>
              <Count value={attention.length} />
            </header>
            <ul className="work-overview-list">
              {(expanded ? attention : attention.slice(0, OVERVIEW_ROWS)).map(task => (
                <li key={task.id}>
                  <WorkbenchDecision
                    task={task}
                    shell={shell}
                    person={personOf(rows, task)}
                    emphasis={task.id === activeDecision}
                    expanded={task.id === activeDecision}
                    onExpand={() => (compact ? shell.choose(task.id) : setOpened(task.id))}
                  />
                </li>
              ))}
            </ul>
            <More total={attention.length} open={expanded} onToggle={() => setExpanded(value => !value)} />
          </section>
        )}
        {running.length > 0 && (
          <section aria-label={COPY.working} className="agents-home-working">
            <header className="work-overview-group-heading">
              <Icon icon={RunningGlyph} size={16} />
              <h3>{COPY.working}</h3>
              <Count value={running.length} />
            </header>
            <ul className="work-overview-list">
              {(allRunning ? running : running.slice(0, OVERVIEW_ROWS)).map(task => (
                <li key={task.id}>
                  <WorkRow
                    title={task.title || COPY.untitled}
                    agent={rowFor(rows, task)}
                    at={task.updatedAt}
                    now={now}
                    action={() => shell.choose(task.id)}
                    status={frozen && <span>{frozen}</span>}
                  />
                </li>
              ))}
            </ul>
            <More total={running.length} open={allRunning} onToggle={() => setAllRunning(value => !value)} />
          </section>
        )}
        {results.length > 0 && (
          <section aria-label={COPY.scheduledResults}>
            <header className="work-overview-group-heading">
              <Icon icon={OverviewGlyph} size={16} />
              <h3>{COPY.scheduledResults}</h3>
            </header>
            <ul className="work-overview-list">
              {results.slice(0, OVERVIEW_ROWS).map(({ automation, run }) => {
                const session = snapshot.tasks.find(task => task.id === run.sessionId && task.automationId === automation.id)
                const tone =
                  run.state === 'failed' ? 'failed' : run.state === 'unknown' ? 'warn' : run.state === 'completed' ? 'done' : 'neutral'
                return (
                  <li key={automation.id}>
                    <WorkRow
                      title={automation.name}
                      agent={session ? (rowFor(rows, session) ?? agentOf(automation)) : agentOf(automation)}
                      at={run.at}
                      now={now}
                      {...(session ? { action: () => shell.choose(session.id), link: COPY.openResult } : {})}
                      status={<StatusWord tone={tone}>{RUN_WORDS[run.state]}</StatusWord>}
                    />
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {attention.length === 0
          && running.length === 0
          && (recent
            ? !compact && (
                <section aria-label={COPY.recentChat} className="agents-home-resume">
                  <header className="work-overview-group-heading">
                    <Icon icon={MessageGlyph} size={16} />
                    <h3>{COPY.recentChat}</h3>
                  </header>
                  <WorkRow
                    title={recent.title || COPY.untitled}
                    agent={rowFor(rows, recent)}
                    at={recent.updatedAt}
                    now={now}
                    action={() => {
                      const owner = recent.agent?.customAgentId ?? GENERAL_AGENT_ID
                      if (shell.delegation.pending?.customAgentId === owner) shell.openMyAgent({ id: owner })
                      else shell.choose(recent.id)
                    }}
                    link={COPY.continueChat}
                  />
                </section>
              )
            : snapshot.customAgents === undefined
              ? !results.length
                && !upcoming.length && (
                  <ul className="work-overview-list agents-home-loading" aria-busy="true" aria-label={COPY.reading}>
                    {[0, 1, 2].map(row => (
                      <li key={row}>
                        <Skeleton width={36} height={36} />
                        <Skeleton width="40%" height={16} />
                      </li>
                    ))}
                  </ul>
                )
              : !results.length && !upcoming.length && <FirstTask shell={shell} />)}
        {upcoming.length > 0 && (
          <section aria-label={COPY.nextRun}>
            <header className="work-overview-group-heading">
              <Icon icon={ScheduleGlyph} size={16} />
              <h3>{COPY.nextRun}</h3>
            </header>
            <ul className="work-overview-list">
              {upcoming.slice(0, OVERVIEW_ROWS).map(({ automation, at }) => {
                const agent = agentOf(automation)
                return (
                  <li key={automation.id}>
                    <WorkRow
                      title={automation.name}
                      agent={agent}
                      at={at}
                      now={now}
                      {...(agent && addressable(agent) ? { action: () => shell.openMyAgent({ id: agent.id, tab: 'schedules' }) } : {})}
                    />
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {compact && <AgentsSpaceList shell={shell} page resume={!attention.length && !running.length ? recent : undefined} />}
      </div>
    </div>
  )
}
