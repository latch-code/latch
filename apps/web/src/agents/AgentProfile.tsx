import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { GENERAL_AGENT_ID, type AutomationSummary, type CustomAgentList } from '@latch/protocol'
import {
  Button,
  EmptyState,
  IconButton,
  InlineNotice,
  Loading,
  SegmentedControl,
  Sheet,
  Switch,
  ChevronLeftGlyph,
  CloseGlyph,
  EditGlyph,
  PlusGlyph,
} from '@latch/ui'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { AgentHome } from './AgentHome.tsx'
import { AgentExport } from './AgentTransfer.tsx'
import { AgentForm, GeneralForm, WriteNotice } from './AgentForm.tsx'
import { CurrentAgentOptions } from './AgentDefaults.tsx'
import { AvatarPicker } from './AvatarPicker.tsx'
import { type ProfileSection } from './chat.ts'
import { ActivityTab, LibraryTab } from './Activity.tsx'
import { activityVersion, type SchedulePrefill } from './activity.ts'
import { MemoryTab } from './Memory.tsx'
import { agentActivity, dutyLine, scheduleWords, worksIn } from './model.ts'
import { Availability, LockedAgents } from './parts.tsx'
import { SchedulesTab } from './Schedules.tsx'
import { scheduleBlock, whenWords } from './scheduleModel.ts'
import { useAgentComputer, useAgentDetail, useAgentHome, useAgentList, useProposals } from './useAgentData.ts'
import { ComputerSection, NotificationSection } from './Computer.tsx'
import { McpSection } from './McpSection.tsx'
import { builtinHarness } from '../composerChoice.ts'
import { effectWords } from './proposals.ts'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'
import { useAgentWrites, writeFor, type AgentWrites } from './useAgentWrites.ts'

const NO_PLUGINS: CustomAgentList['plugins'] = []
const COPY = defineCopy(
  {
    noSchedules: '没有定时任务',
    schedules: '定时任务',
    next: (time: string) => `下次 ${time}`,
    enabled: (name: string) => `${name} 开启`,
    edit: '编辑',
    newSchedule: '新建定时',
    profile: '资料',
    close: '关闭资料',
    missing: '找不到这个 Agent',
    missingDetail: '它可能已在别处删除。',
    readFailed: '读取失败',
    retry: '重试',
    confirmingDetail: '结果确认前不能读取或修改 Agent，Mac 会自己重试。',
    builtin: '内置',
    profileTabs: '动态、资料库与记忆',
    activity: '动态',
    library: '资料库',
    memory: '记忆',
    loading: '正在读取',
    upcoming: '即将进行',
    place: '工作位置',
    skills: '技能',
    allSkills: '全部已启用',
    skillCount: (count: number) => `${formatNumber(count)} 个`,
    tools: '工具',
    allTools: '不限',
    pluginCount: (count: number) => `${formatNumber(count)} 个插件`,
    settings: '设置',
  },
  {
    noSchedules: 'No scheduled tasks',
    schedules: 'Scheduled tasks',
    next: (time: string) => `Next ${time}`,
    enabled: (name: string) => `Enable ${name}`,
    edit: 'Edit',
    newSchedule: 'New schedule',
    profile: 'Profile',
    close: 'Close profile',
    missing: 'Agent not found',
    missingDetail: 'It may have been deleted elsewhere.',
    readFailed: 'Couldn’t load the Agent',
    retry: 'Retry',
    confirmingDetail: 'You can read or edit the Agent once your Mac confirms the result. Your Mac will retry automatically.',
    builtin: 'Built-in',
    profileTabs: 'Activity, library, and memory',
    activity: 'Activity',
    library: 'Library',
    memory: 'Memory',
    loading: 'Loading',
    upcoming: 'Upcoming',
    place: 'Workspace',
    skills: 'Skills',
    allSkills: 'All enabled',
    skillCount: (count: number) => formatNumber(count),
    tools: 'Tools',
    allTools: 'Unrestricted',
    pluginCount: (count: number) => plural(count, { one: '{n} plugin', other: '{n} plugins' }),
    settings: 'Settings',
  },
)

type View = 'main' | 'settings' | 'schedules'
type Segment = 'activity' | 'library' | 'memory'

/** 即将进行: each schedule with its plan and a switch; 编辑 opens the schedules' own editing. */
function Upcoming({
  automations,
  writes,
  block,
  canRun,
  onEdit,
}: {
  automations: AutomationSummary[] | undefined
  writes: AgentWrites
  block: string | undefined
  canRun: boolean
  onEdit: () => void
}) {
  if (!automations) return <Loading label={AGENT_SPACE_COPY.confirming} />
  const locked = writes.saving || writes.held
  return (
    <>
      {automations.length === 0 ? (
        <p className="agent-profile-quiet">{COPY.noSchedules}</p>
      ) : (
        <ul className="agent-upcoming" aria-label={COPY.schedules}>
          {automations.map(automation => {
            const state = writeFor(writes.state, `automation:${automation.id}`)
            return (
              <li key={automation.id}>
                <div className="agent-upcoming-row">
                  <span className="agent-recent-text">
                    <span className="agent-recent-title">{automation.name}</span>
                    <span className="agent-schedule-meta">
                      {scheduleWords(automation.schedule)}
                      {automation.nextRunAt && automation.enabled ? ` · ${COPY.next(whenWords(automation.nextRunAt))}` : ''}
                    </span>
                  </span>
                  <Switch
                    label={COPY.enabled(automation.name)}
                    checked={automation.enabled}
                    disabled={!canRun || locked || (!automation.enabled && block !== undefined)}
                    {...(!automation.enabled && block ? { title: block } : {})}
                    onCheckedChange={enabled => {
                      void writes.run(`automation:${automation.id}`, `automations/${encodeURIComponent(automation.id)}/enabled`, 'POST', {
                        enabled,
                        baseRevision: automation.revision,
                      })
                    }}
                  />
                </div>
                <WriteNotice state={state} onRetry={() => void writes.retry()} />
              </li>
            )
          })}
        </ul>
      )}
      {canRun && (
        <Button variant="ghost" size="sm" icon={automations.length ? EditGlyph : PlusGlyph} className="agent-profile-more" onClick={onEdit}>
          {automations.length ? COPY.edit : COPY.newSchedule}
        </Button>
      )}
    </>
  )
}

/**
 * An Agent's profile, opened from its face or name: a big face (the picker), name and duty; 动态 · 记忆 (its recent
 * topics, and its memories to add, change and delete); 即将进行 (its schedules with switches); the computer and where
 * it works; how it runs and how many skills and tools it has; and 设置, the edit form. 通用 has no schedules here, and its
 * 设置 is its instructions and skills. Writes keep their requestId and say when their result is unknown.
 */
export function AgentProfile({
  shell,
  owner,
  section,
  nonce,
  prefill,
  phone = false,
  onClose,
}: {
  shell: ShellState
  owner: string
  section?: ProfileSection | undefined
  /** Changes when a link asks for a section again. */
  nonce: number
  /** Opens the schedule editor filled in from a schedule proposal. */
  prefill?: SchedulePrefill | undefined
  phone?: boolean
  onClose: () => void
}) {
  const { snapshot, catalog, connection, access } = shell
  const offline = connection === 'offline'
  const general = owner === GENERAL_AGENT_ID
  const { read: listRead, reload: reloadList } = useAgentList(snapshot)
  const detail = useAgentDetail(snapshot, owner)
  const home = useAgentHome(snapshot, owner)
  const { read: proposalRead, reload: reloadProposals } = useProposals(snapshot, owner)
  const { read: computerRead, reload: reloadComputer } = useAgentComputer(snapshot, owner)
  const refreshShell = shell.refresh
  const settle = useCallback(() => {
    reloadList()
    detail.reload()
    reloadProposals()
    reloadComputer()
    home.reload()
    void refreshShell()
  }, [reloadList, detail.reload, reloadProposals, reloadComputer, home.reload, refreshShell])
  const writes = useAgentWrites(settle)
  const scheduleWrites = useAgentWrites(
    useCallback(() => {
      reloadComputer()
      void refreshShell()
    }, [reloadComputer, refreshShell]),
  )
  const viewOf = (wanted: ProfileSection | undefined): View =>
    wanted === 'settings' ? 'settings' : wanted === 'schedules' ? 'schedules' : 'main'
  const [view, setView] = useState<View>(() => viewOf(section))
  const [segment, setSegment] = useState<Segment>(section === 'memory' ? 'memory' : 'activity')
  const body = useRef<HTMLDivElement>(null)
  // A link to a section shows it, also when the profile is already open.
  useEffect(() => {
    setView(viewOf(section))
    if (section === 'memory') setSegment('memory')
    body.current?.scrollTo({ top: 0 })
  }, [section, nonce])
  useEffect(() => {
    writes.clear()
  }, [owner, writes.clear])
  const locked = detail.read.state === 'locked'
  const value = detail.value
  const summary = general
    ? undefined
    : value?.kind === 'custom'
      ? value.detail.agent
      : snapshot.customAgents?.find(agent => agent.id === owner)
  const name = general ? AGENT_SPACE_COPY.general : (summary?.name ?? '')
  const duty = general ? AGENT_SPACE_COPY.generalDuty : dutyLine(value?.kind === 'custom' ? value.detail.agent : (summary ?? {}))
  const activity = summary ? agentActivity(snapshot, summary) : 'idle'
  const held = offline || writes.held
  const schedulesOn = catalog?.features?.automations === true
  // 通用's schedules are the ones that name no Agent.
  const automations = snapshot.automations?.filter(item => (general ? item.customAgentId === undefined : item.customAgentId === owner))
  const canRun = access.scopes.has('run')
  const harness = catalog?.harnesses.find(item => item.id === (general ? 'standard' : summary?.harnessId))
  const plugins = 'value' in listRead && listRead.value ? listRead.value.plugins : NO_PLUGINS
  const skills = value?.kind === 'custom' ? value.detail.agent.skills : value?.kind === 'general' ? value.detail.general.skills : undefined
  const tools = value?.kind === 'custom' ? value.detail.agent.tools : undefined
  const back = (
    <Button
      variant="ghost"
      size="sm"
      icon={ChevronLeftGlyph}
      onClick={() => {
        writes.clear()
        setView('main')
      }}>
      {name}
    </Button>
  )
  return (
    <section
      className="agent-profile"
      aria-label={AGENT_SPACE_COPY.profileOf(name)}
      data-phone={phone ? '' : undefined}
      onKeyDown={event => {
        // Escape closes the panel, unless a menu, picker or dialog inside it takes it first.
        if (phone || event.key !== 'Escape' || event.defaultPrevented) return
        if (event.target instanceof Element && event.target.closest('dialog, [popover]')) return
        event.preventDefault()
        onClose()
      }}>
      {!phone && (
        <header className="agent-profile-head">
          {view === 'main' ? <h2>{COPY.profile}</h2> : back}
          <IconButton label={COPY.close} icon={CloseGlyph} size="sm" onClick={onClose} />
        </header>
      )}
      {phone && view !== 'main' && <div className="agent-profile-subhead">{back}</div>}
      <div ref={body} className="agent-profile-body">
        {locked && <LockedAgents />}
        {!locked && detail.read.state === 'missing' && <EmptyState title={COPY.missing} description={COPY.missingDetail} />}
        {!locked && detail.read.state === 'failed' && !value && (
          <InlineNotice tone="error" title={COPY.readFailed} action={<Button onClick={settle}>{COPY.retry}</Button>}>
            {detail.read.message}
          </InlineNotice>
        )}
        {!locked && detail.read.state === 'confirming' && (
          <InlineNotice tone="warn" title={AGENT_SPACE_COPY.confirming}>
            {COPY.confirmingDetail}
          </InlineNotice>
        )}
        {!locked && view === 'main' && detail.read.state !== 'missing' && (
          <>
            <div className="agent-profile-who">
              {summary && canRun ? (
                <AvatarPicker agent={summary} state={activity} writes={writes} disabled={held} onReload={settle} />
              ) : (
                <AgentAvatar avatar={summary?.avatar ?? 'general'} size={56} state={activity} />
              )}
              <div className="agent-head-text">
                <h3>
                  {name}
                  {general && <span className="agent-builtin">{COPY.builtin}</span>}
                </h3>
                {duty && <p>{duty}</p>}
                {summary && (!summary.available || offline) && (
                  <Availability available={summary.available} reason={summary.unavailableReason} offline={offline} />
                )}
              </div>
            </div>
            <div className="agent-profile-section">
              <SegmentedControl<Segment>
                label={COPY.profileTabs}
                value={segment}
                options={[
                  { value: 'activity', label: COPY.activity },
                  { value: 'library', label: COPY.library },
                  { value: 'memory', label: COPY.memory },
                ]}
                onValueChange={setSegment}
              />
              {segment === 'activity' && (
                <ActivityTab
                  owner={owner}
                  version={activityVersion(snapshot, owner)}
                  onOpenSession={shell.choose}
                  onMemory={() => {
                    setSegment('memory')
                  }}
                />
              )}
              {segment === 'library' && (
                <LibraryTab
                  owner={owner}
                  version={activityVersion(snapshot, owner)}
                  canOpen={catalog?.features?.filePreview === true && snapshot.device.dataScope === 'all'}
                  onOpenFile={target => {
                    // The file preview stands where the profile stands.
                    shell.closeProfile()
                    shell.openFile(target)
                  }}
                  onOpenSession={shell.choose}
                />
              )}
              {segment === 'memory'
                && (value ? (
                  <MemoryTab
                    key={owner}
                    owner={owner}
                    memories={value.detail.memories}
                    changes={value.detail.memoryChanges}
                    proposals={
                      'value' in proposalRead && proposalRead.value
                        ? proposalRead.value.proposals.filter(item => item.kind !== 'schedule')
                        : []
                    }
                    effect={general ? undefined : effectWords(harness)}
                    writes={writes}
                    disabled={held}
                    onReload={settle}
                    topicTitle={id => snapshot.tasks.find(task => task.id === id)?.title}
                    onOpenTopic={shell.choose}
                    knowsYou={summary && !general ? { agent: summary, canRun } : undefined}
                  />
                ) : (
                  <Loading label={COPY.loading} />
                ))}
            </div>
            {schedulesOn && (
              <div className="agent-profile-section" aria-label={COPY.upcoming} role="group">
                <h3>{COPY.upcoming}</h3>
                <Upcoming
                  automations={automations}
                  writes={scheduleWrites}
                  block={scheduleBlock({ offline, canRun, agent: summary })}
                  canRun={canRun}
                  onEdit={() => {
                    setView('schedules')
                  }}
                />
              </div>
            )}
            <ComputerSection
              hostName={snapshot.hostName}
              read={computerRead}
              reachable={connection === 'connected'}
              sleeping={shell.harness.hostNotice?.state === 'sleeping'}
              agent={summary}
              schedulesOn={schedulesOn}
              canRun={canRun}
              disabled={held}
              runBlock={scheduleBlock({ offline, canRun, agent: summary, trigger: 'manual' })}
              writes={writes}
              scheduleWrites={scheduleWrites}
            />
            {summary && <NotificationSection agent={summary} canRun={canRun} disabled={held} writes={writes} />}
            {(summary || general) && catalog?.features?.mcp === true && (
              <McpSection
                agentId={owner}
                assignable={!general}
                harness={harness}
                builtin={harness !== undefined && harness.id === builtinHarness(catalog ?? undefined)?.id}
                access={access}
                disabled={held}
              />
            )}
            <dl className="agent-facts agent-profile-section">
              <dt>{COPY.place}</dt>
              <dd>
                <span>{worksIn(catalog ?? undefined, summary?.defaultProjectId)}</span>
              </dd>
              {value && (
                <>
                  <dt>{COPY.skills}</dt>
                  <dd>
                    <span>{skills === undefined ? COPY.allSkills : COPY.skillCount(skills.length)}</span>
                  </dd>
                  {!general && (
                    <>
                      <dt>{COPY.tools}</dt>
                      <dd>
                        <span>{tools === undefined ? COPY.allTools : COPY.pluginCount(tools.length)}</span>
                      </dd>
                    </>
                  )}
                </>
              )}
            </dl>
            <Button
              className="agent-profile-settings"
              disabled={!value}
              onClick={() => {
                writes.clear()
                setView('settings')
              }}>
              {COPY.settings}
            </Button>
          </>
        )}
        {!locked && view === 'settings' && !value && detail.read.state === 'loading' && <Loading label={COPY.loading} />}
        {!locked && view === 'settings' && value && <AgentHome key={owner} home={home.value} local={access.local} admin={access.admin} />}
        {!locked && view === 'settings' && <CurrentAgentOptions shell={shell} owner={owner} />}
        {!locked && view === 'settings' && value?.kind === 'custom' && catalog && (
          <AgentForm
            catalog={catalog}
            access={access}
            agent={value.detail.agent}
            plugins={plugins}
            writes={writes}
            disabled={held}
            onSaved={settle}
            onOptionsRead={settle}
            onDeleted={notice => {
              onClose()
              shell.openMyAgent()
              if (notice) shell.setToast({ text: notice, tone: 'error' })
            }}
            onReload={() => {
              writes.clear()
              settle()
            }}
            {...(shell.owner ? { onManageProviders: shell.manageProviders } : {})}
          />
        )}
        {!locked && view === 'settings' && value?.kind === 'custom' && <AgentExport agent={value.detail.agent} offline={offline} />}
        {!locked && view === 'settings' && value?.kind === 'general' && catalog && (
          <GeneralForm catalog={catalog} detail={value.detail} writes={writes} disabled={held} onReload={settle} />
        )}
        {!locked && view === 'schedules' && schedulesOn && (
          <SchedulesTab
            catalog={catalog ?? undefined}
            access={access}
            agentId={general ? undefined : owner}
            agent={summary}
            automations={automations}
            writes={scheduleWrites}
            offline={offline}
            onOpenSession={shell.choose}
            onReload={settle}
            prefill={prefill}
            nonce={nonce}
          />
        )}
      </div>
    </section>
  )
}

/** The responsive layout supplies a place, not another profile or another write controller. */
export function ProfileSlot({ owner, phone = false }: { owner: string; phone?: boolean }) {
  return <div className="agent-profile-slot" data-agent-profile-slot={phone ? 'phone' : 'desktop'} data-agent-profile-owner={owner} />
}

/**
 * One profile for both desktop placements and the phone's existing Sheet. The portal target never changes: only its
 * container moves, so forms, pending writes, scroll and focused controls keep their React and DOM identities.
 */
export function ProfileLayer({ shell }: { shell: ShellState }) {
  const shown = shell.profileShown
  const [container] = useState(() => {
    if (typeof document === 'undefined') return null
    const element = document.createElement('div')
    element.className = 'agent-profile-mount'
    return element
  })
  const focused = useRef<HTMLElement | null>(null)
  const readable = shell.snapshot.device.dataScope === 'all' && shell.access.scopes.has('view')
  useLayoutEffect(() => {
    if (!container) return
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) focused.current = event.target
    }
    container.addEventListener('focusin', remember)
    return () => {
      container.removeEventListener('focusin', remember)
      container.remove()
    }
  }, [container])
  useLayoutEffect(() => {
    if (!container) return
    const slot =
      shown && readable
        ? document.querySelector(
            `[data-agent-profile-slot="${shell.phone ? 'phone' : 'desktop'}"][data-agent-profile-owner="${CSS.escape(shown.owner)}"]`,
          )
        : null
    if (!slot) {
      container.remove()
      focused.current = null
      return
    }
    if (container.parentElement === slot) return
    // Opening a modal first moves focus to its empty body. Restore the control after it joins that active dialog.
    const target = container.contains(document.activeElement) ? document.activeElement : focused.current
    slot.append(container)
    if (target instanceof HTMLElement && target.isConnected && !target.closest('[inert]') && target.checkVisibility())
      target.focus({ preventScroll: true })
  })
  const name = !shown
    ? ''
    : shown.owner === GENERAL_AGENT_ID
      ? AGENT_SPACE_COPY.general
      : (shell.snapshot.customAgents?.find(agent => agent.id === shown.owner)?.name ?? 'Agent')
  return (
    <>
      <Sheet
        open={shell.phone && shown !== null && readable}
        title={name}
        detent="large"
        className="agent-profile-sheet"
        onClose={() => {
          if (shell.phone) shell.closeProfile()
        }}>
        {shown && <ProfileSlot owner={shown.owner} phone />}
      </Sheet>
      {container
        && shown
        && readable
        && createPortal(
          <AgentProfile
            key={`${shell.snapshot.device.id}:${shown.owner}`}
            shell={shell}
            owner={shown.owner}
            section={shown.section}
            nonce={shown.nonce}
            prefill={shown.prefill}
            phone={shell.phone}
            onClose={shell.closeProfile}
          />,
          container,
        )}
    </>
  )
}
