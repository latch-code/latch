import { Laptop, Play } from 'lucide-react'

import type { AgentComputer, AgentNotifications, CustomAgentSummary } from '@latch/protocol'
import { AlertGlyph, Button, Hint, Icon, Loading, StatusWord, SwitchRow } from '@latch/ui'
import { WriteNotice } from './AgentForm.tsx'
import { ALL_NOTIFICATIONS, computerView, NOTIFICATION_KINDS, notificationLabel, notificationsPatch } from './computer.ts'
import type { AgentRead } from './useAgentData.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    computer: '电脑',
    original: '原电脑',
    loading: '正在读取',
    missedNote: 'Mac 睡眠、关机或 Latch 没有运行时，定时任务不会运行，醒来后也不补跑。',
    missedSchedules: '错过的定时',
    runNow: '立即运行',
    keepAwake: '到点前后保持唤醒',
    whenRunning: 'Latch 应用运行时有效',
    wakeScope:
      '从这个 Agent 的定时任务前 2 分钟起不让这台 Mac 闲置睡眠，直到这次运行结束，最长 32 分钟。已经睡眠或合上盖子的 Mac 不会被唤醒，也不改系统的唤醒计划。',
    notifications: '通知',
    macApp: 'Mac 上的 Latch 应用',
    notificationScope:
      '这个 Agent 的话题和定时运行完成、失败或等你处理时，Mac 上的 Latch 应用按这里发通知；iPhone 与 iPad 尚未按 Agent 区分。',
    woke: (when: string) => `上次唤醒 ${when}`,
    missed: (count: number) => `错过 ${formatNumber(count)} 次`,
  },
  {
    computer: 'Computer',
    original: 'Original computer',
    loading: 'Loading',
    missedNote:
      'Schedules skip runs while the Mac is asleep or shut down, or while Latch is closed. Missed runs aren’t started after wake.',
    missedSchedules: 'Missed runs',
    runNow: 'Run now',
    keepAwake: 'Keep the Mac awake for schedules',
    whenRunning: 'Works while the Latch app is running',
    wakeScope:
      'Keeps this Mac from idle sleep for up to 32 minutes, from two minutes before the Agent’s scheduled run until it finishes. It cannot wake a Mac that is already asleep or has its lid closed. It leaves the system’s wake schedule unchanged.',
    notifications: 'Notifications',
    macApp: 'Latch app on the Mac',
    notificationScope:
      'The Mac app uses these settings when this Agent’s topics or scheduled runs finish, fail or need you. Per-Agent notifications are unavailable on iPhone and iPad.',
    woke: (when: string) => `Last wake ${when}`,
    missed: (count: number) => plural(count, { one: '{n} missed run', other: '{n} missed runs' }),
  },
)

/**
 * 「电脑」: the computer this Agent lives on, as the Host recorded it. Online, asleep or kept awake; when it last woke;
 * the scheduled times its schedules missed since each last ran, with 立即运行; and, for one of 我的 Agent with
 * schedules, 「到点前后保持唤醒」.
 */
export function ComputerSection({
  hostName,
  read,
  reachable,
  sleeping,
  agent,
  schedulesOn,
  canRun,
  disabled,
  runBlock,
  writes,
  scheduleWrites,
}: {
  hostName: string
  read: AgentRead<AgentComputer>
  reachable: boolean
  sleeping: boolean
  /** Absent for 通用, which has no keep-awake switch of its own. */
  agent: CustomAgentSummary | undefined
  schedulesOn: boolean
  canRun: boolean
  disabled: boolean
  /** Why 立即运行 cannot be pressed now. */
  runBlock: string | undefined
  writes: AgentWrites
  scheduleWrites: AgentWrites
}) {
  const value = 'value' in read ? read.value : undefined
  const keepAwakeOn = agent?.keepAwakeForSchedules === true
  const view = computerView({
    reachable,
    sleeping,
    computer: value?.computer,
    missed: value?.missed ?? [],
    keepAwakeOn,
  })
  const locked = disabled || writes.saving || writes.held
  const runLocked = disabled || scheduleWrites.saving || scheduleWrites.held
  const heading = agent?.workComputer ? COPY.original : COPY.computer
  const keepAwakeState = agent ? writeFor(writes.state, `keep-awake:${agent.id}`) : null
  return (
    <div className="agent-profile-section agent-computer" aria-label={heading} role="group">
      <h3>{heading}</h3>
      <div className="agent-computer-card">
        <div className="agent-computer-row">
          <Icon icon={Laptop} size={16} className="agent-computer-icon" />
          <span className="agent-computer-name">{hostName}</span>
          {view.awakeFor ? (
            <Hint className="agent-computer-awake" label={view.status.label}>
              {view.awakeFor}
            </Hint>
          ) : (
            <StatusWord tone={view.status.tone}>{view.status.label}</StatusWord>
          )}
        </div>
        {view.woke && <p className="agent-computer-meta">{COPY.woke(view.woke)}</p>}
        {!value && read.state === 'loading' && <Loading label={COPY.loading} />}
        {read.state === 'failed' && <p className="agent-computer-meta">{read.message}</p>}
        {view.missedTotal > 0 && (
          <div className="agent-computer-missed">
            <Hint className="agent-schedule-missed" label={COPY.missed(view.missedTotal)} lead={<Icon icon={AlertGlyph} size={12} />}>
              {COPY.missedNote}
            </Hint>
            <ul className="agent-computer-misses" aria-label={COPY.missedSchedules}>
              {view.missed.map(group => {
                const state = writeFor(scheduleWrites.state, `automation:${group.automationId}`)
                return (
                  <li key={group.automationId}>
                    <div className="agent-computer-miss">
                      <span className="agent-recent-text">
                        <span className="agent-recent-title">{group.name}</span>
                        {group.times.map(time => (
                          <span key={time.at} className="agent-schedule-meta">
                            {time.words}
                          </span>
                        ))}
                      </span>
                      {canRun && (
                        <Button
                          size="sm"
                          icon={Play}
                          disabled={runLocked || runBlock !== undefined}
                          {...(runBlock ? { title: runBlock } : {})}
                          onClick={() => {
                            void scheduleWrites.run(
                              `automation:${group.automationId}`,
                              `automations/${encodeURIComponent(group.automationId)}/run`,
                              'POST',
                              {},
                            )
                          }}>
                          {COPY.runNow}
                        </Button>
                      )}
                    </div>
                    <WriteNotice state={state} onRetry={() => void scheduleWrites.retry()} />
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
      {agent && schedulesOn && (
        <>
          <SwitchRow
            className="agent-computer-switch"
            title={COPY.keepAwake}
            description={
              <Hint className={view.keepAwakeNote ? 'agent-computer-note' : undefined} label={view.keepAwakeNote ?? COPY.whenRunning}>
                {COPY.wakeScope}
              </Hint>
            }
            checked={keepAwakeOn}
            disabled={!canRun || locked}
            onCheckedChange={on => {
              void writes.run(`keep-awake:${agent.id}`, `custom-agents/${encodeURIComponent(agent.id)}`, 'PATCH', {
                keepAwakeForSchedules: on,
                baseRevision: agent.revision,
              })
            }}
          />
          <WriteNotice state={keepAwakeState} onRetry={() => void writes.retry()} />
        </>
      )}
    </div>
  )
}

/** 「通知」: which of this Agent's notifications the Latch app on this Mac sends, for its topics and its scheduled runs. */
export function NotificationSection({
  agent,
  canRun,
  disabled,
  writes,
}: {
  agent: CustomAgentSummary
  canRun: boolean
  disabled: boolean
  writes: AgentWrites
}) {
  const current: AgentNotifications = agent.notifications ?? ALL_NOTIFICATIONS
  const locked = disabled || writes.saving || writes.held
  const state = writeFor(writes.state, `notifications:${agent.id}`)
  return (
    <div className="agent-profile-section" aria-label={COPY.notifications} role="group">
      <header className="agent-profile-heading">
        <h3>{COPY.notifications}</h3>
        <Hint label={COPY.macApp}>{COPY.notificationScope}</Hint>
      </header>
      <div className="agent-notification-switches">
        {NOTIFICATION_KINDS.map(kind => (
          <SwitchRow
            key={kind}
            title={notificationLabel(kind)}
            checked={current[kind]}
            disabled={!canRun || locked}
            onCheckedChange={on => {
              void writes.run(`notifications:${agent.id}`, `custom-agents/${encodeURIComponent(agent.id)}`, 'PATCH', {
                notifications: notificationsPatch(agent.notifications, kind, on),
                baseRevision: agent.revision,
              })
            }}
          />
        ))}
      </div>
      <WriteNotice state={state} onRetry={() => void writes.retry()} />
    </div>
  )
}
