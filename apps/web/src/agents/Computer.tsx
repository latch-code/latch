import { Laptop, Play } from 'lucide-react'

import type { AgentComputer, AgentNotifications, CustomAgentSummary } from '@latch/protocol'
import { AlertGlyph, Button, Hint, Icon, Loading, StatusWord, SwitchRow } from '@latch/ui'
import { WriteNotice } from './AgentForm.tsx'
import { ALL_NOTIFICATIONS, computerView, NOTIFICATION_KINDS, notificationsPatch } from './computer.ts'
import type { AgentRead } from './useAgentData.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'

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
  const keepAwakeState = agent ? writeFor(writes.state, `keep-awake:${agent.id}`) : null
  return (
    <div className="agent-profile-section agent-computer" aria-label="电脑" role="group">
      <h3>电脑</h3>
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
        {view.woke && <p className="agent-computer-meta">上次唤醒 {view.woke}</p>}
        {!value && read.state === 'loading' && <Loading label="正在读取" />}
        {read.state === 'failed' && <p className="agent-computer-meta">{read.message}</p>}
        {view.missedTotal > 0 && (
          <div className="agent-computer-missed">
            <Hint className="agent-schedule-missed" label={`错过 ${view.missedTotal} 次`} lead={<Icon icon={AlertGlyph} size={12} />}>
              Mac 睡眠、关机或 Latch 没有运行时，定时任务不会运行，醒来后也不补跑。
            </Hint>
            <ul className="agent-computer-misses" aria-label="错过的定时">
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
                          立即运行
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
            title="到点前后保持唤醒"
            description={
              <Hint className={view.keepAwakeNote ? 'agent-computer-note' : undefined} label={view.keepAwakeNote ?? 'Latch 应用运行时有效'}>
                从这个 Agent 的定时任务前 2 分钟起不让这台 Mac 闲置睡眠，直到这次运行结束，最长 32 分钟。已经睡眠或合上盖子的 Mac
                不会被唤醒，也不改系统的唤醒计划。
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
    <div className="agent-profile-section" aria-label="通知" role="group">
      <header className="agent-profile-heading">
        <h3>通知</h3>
        <Hint label="Mac 上的 Latch 应用">
          这个 Agent 的话题和定时运行完成、失败或等你处理时，Mac 上的 Latch 应用按这里发通知；iPhone 与 iPad 尚未按 Agent 区分。
        </Hint>
      </header>
      <div className="agent-notification-switches">
        {NOTIFICATION_KINDS.map(kind => (
          <SwitchRow
            key={kind.key}
            title={kind.label}
            checked={current[kind.key]}
            disabled={!canRun || locked}
            onCheckedChange={on => {
              void writes.run(`notifications:${agent.id}`, `custom-agents/${encodeURIComponent(agent.id)}`, 'PATCH', {
                notifications: notificationsPatch(agent.notifications, kind.key, on),
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
