import { useCallback, useEffect, useRef, useState } from 'react'

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
import { HarnessTile } from '../components/BrandTile.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { AgentForm, GeneralForm, WriteNotice } from './AgentForm.tsx'
import { AvatarPicker } from './AvatarPicker.tsx'
import { type ProfileSection } from './chat.ts'
import { ActivityTab, LibraryTab } from './Activity.tsx'
import { activityVersion, type SchedulePrefill } from './activity.ts'
import { MemoryTab } from './Memory.tsx'
import { agentActivity, dutyLine, GENERAL_NAME, runsWith, scheduleWords, worksIn } from './model.ts'
import { Availability, LockedAgents } from './parts.tsx'
import { SchedulesTab } from './Schedules.tsx'
import { scheduleBlock, whenWords } from './scheduleModel.ts'
import { useAgentComputer, useAgentDetail, useAgentList, useProposals } from './useAgentData.ts'
import { ComputerSection, NotificationSection } from './Computer.tsx'
import { effectWords } from './proposals.ts'
import { useAgentWrites, writeFor, type AgentWrites } from './useAgentWrites.ts'

const NO_PLUGINS: CustomAgentList['plugins'] = []

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
  if (!automations) return <Loading label="正在确认上一项修改" />
  const locked = writes.saving || writes.held
  return (
    <>
      {automations.length === 0 ? (
        <p className="agent-profile-quiet">没有定时任务</p>
      ) : (
        <ul className="agent-upcoming" aria-label="定时任务">
          {automations.map(automation => {
            const state = writeFor(writes.state, `automation:${automation.id}`)
            return (
              <li key={automation.id}>
                <div className="agent-upcoming-row">
                  <span className="agent-recent-text">
                    <span className="agent-recent-title">{automation.name}</span>
                    <span className="agent-schedule-meta">
                      {scheduleWords(automation.schedule)}
                      {automation.nextRunAt && automation.enabled ? ` · 下次 ${whenWords(automation.nextRunAt)}` : ''}
                    </span>
                  </span>
                  <Switch
                    label={`${automation.name} 开启`}
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
          {automations.length ? '编辑' : '新建定时'}
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
  const { read: proposalRead, reload: reloadProposals } = useProposals(snapshot, owner)
  const { read: computerRead, reload: reloadComputer } = useAgentComputer(snapshot, owner)
  const refreshShell = shell.refresh
  const settle = useCallback(() => {
    reloadList()
    detail.reload()
    reloadProposals()
    reloadComputer()
    void refreshShell()
  }, [reloadList, detail.reload, reloadProposals, reloadComputer, refreshShell])
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
  const name = general ? GENERAL_NAME : (summary?.name ?? '')
  const duty = general ? '没选别的 Agent 的会话都带上它' : dutyLine(value?.kind === 'custom' ? value.detail.agent : (summary ?? {}))
  const activity = summary ? agentActivity(snapshot, summary) : 'idle'
  const held = offline || writes.held
  const schedulesOn = catalog?.features?.automations === true
  // 通用's schedules are the ones that name no Agent.
  const automations = snapshot.automations?.filter(item => (general ? item.customAgentId === undefined : item.customAgentId === owner))
  const canRun = access.scopes.has('run')
  const harness = summary && catalog?.harnesses.find(item => item.id === summary.harnessId)
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
      aria-label={`${name} 的资料`}
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
          {view === 'main' ? <h2>资料</h2> : back}
          <IconButton label="关闭资料" icon={CloseGlyph} size="sm" onClick={onClose} />
        </header>
      )}
      {phone && view !== 'main' && <div className="agent-profile-subhead">{back}</div>}
      <div ref={body} className="agent-profile-body">
        {locked && <LockedAgents />}
        {!locked && detail.read.state === 'missing' && <EmptyState title="找不到这个 Agent" description="它可能已在别处删除。" />}
        {!locked && detail.read.state === 'failed' && !value && (
          <InlineNotice tone="error" title="读取失败" action={<Button onClick={settle}>重试</Button>}>
            {detail.read.message}
          </InlineNotice>
        )}
        {!locked && detail.read.state === 'confirming' && (
          <InlineNotice tone="warn" title="正在确认上一项修改">
            结果确认前不能读取或修改 Agent，Mac 会自己重试。
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
                  {general && <span className="agent-builtin">内置</span>}
                </h3>
                {duty && <p>{duty}</p>}
                {summary && (!summary.available || offline) && (
                  <Availability available={summary.available} reason={summary.unavailableReason} offline={offline} />
                )}
              </div>
            </div>
            <div className="agent-profile-section">
              <SegmentedControl<Segment>
                label="动态、资料库与记忆"
                value={segment}
                options={[
                  { value: 'activity', label: '动态' },
                  { value: 'library', label: '资料库' },
                  { value: 'memory', label: '记忆' },
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
                  />
                ) : (
                  <Loading label="正在读取" />
                ))}
            </div>
            {schedulesOn && (
              <div className="agent-profile-section" aria-label="即将进行" role="group">
                <h3>即将进行</h3>
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
              runBlock={scheduleBlock({ offline, canRun, agent: summary })}
              writes={writes}
              scheduleWrites={scheduleWrites}
            />
            {summary && <NotificationSection agent={summary} canRun={canRun} disabled={held} writes={writes} />}
            <dl className="agent-facts agent-profile-section">
              <dt>工作位置</dt>
              <dd>
                <span>{summary ? worksIn(catalog ?? undefined, summary.defaultProjectId) : '不带项目'}</span>
              </dd>
              <dt>Harness · 模型</dt>
              <dd>
                {harness && <HarnessTile harness={harness} size={14} />}
                <span>{summary ? runsWith(catalog ?? undefined, summary) : '每个会话自己选'}</span>
              </dd>
              {value && (
                <>
                  <dt>技能</dt>
                  <dd>
                    <span>{skills === undefined ? '全部已启用' : `${skills.length} 个`}</span>
                  </dd>
                  {!general && (
                    <>
                      <dt>工具</dt>
                      <dd>
                        <span>{tools === undefined ? '不限' : `${tools.length} 个插件`}</span>
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
              设置
            </Button>
          </>
        )}
        {!locked && view === 'settings' && !value && detail.read.state === 'loading' && <Loading label="正在读取" />}
        {!locked && view === 'settings' && value?.kind === 'custom' && catalog && (
          <AgentForm
            catalog={catalog}
            access={access}
            agent={value.detail.agent}
            plugins={plugins}
            writes={writes}
            disabled={held}
            onSaved={settle}
            onDeleted={() => {
              onClose()
              shell.openMyAgent()
            }}
            onReload={() => {
              writes.clear()
              settle()
            }}
            {...(shell.owner ? { onManageProviders: shell.manageProviders } : {})}
          />
        )}
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

/** A phone's profile: the same content in a bottom sheet over the conversation, closed by 完成 or a drag down. */
export function ProfileSheet({ shell }: { shell: ShellState }) {
  const shown = shell.profileShown
  const name = !shown
    ? ''
    : shown.owner === GENERAL_AGENT_ID
      ? GENERAL_NAME
      : (shell.snapshot.customAgents?.find(agent => agent.id === shown.owner)?.name ?? 'Agent')
  return (
    <Sheet
      open={shown !== null}
      title={name}
      detent="large"
      cancelLabel={null}
      action={
        <Button variant="ghost" onClick={shell.closeProfile}>
          完成
        </Button>
      }
      className="agent-profile-sheet"
      onClose={shell.closeProfile}>
      {shown && (
        <AgentProfile
          shell={shell}
          owner={shown.owner}
          section={shown.section}
          nonce={shown.nonce}
          prefill={shown.prefill}
          phone
          onClose={shell.closeProfile}
        />
      )}
    </Sheet>
  )
}
