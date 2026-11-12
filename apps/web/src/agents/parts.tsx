import { Code2, LockKeyhole, TriangleAlert, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint, ICON_STROKE, StatusWord } from '@latch/ui'
import type { ShellEntry } from '../shell/routes.ts'
import { AgentsMark } from './AgentAvatar.tsx'
import type { AvatarState } from './avatarFace.ts'
import { ACTIVITY_WORDS } from './model.ts'

/** The state word beside a face, for the states that have one. */
export function ActivityWord({ state }: { state: AvatarState }) {
  const word = ACTIVITY_WORDS[state]
  return word ? (
    <StatusWord tone={word.tone} className="agent-activity">
      {word.words}
    </StatusWord>
  ) : null
}

/** Whether a session can start on the Agent now, in a few words; the Host's reason behind ⓘ. */
export function Availability({ available, reason, offline }: { available: boolean; reason?: string | undefined; offline: boolean }) {
  if (offline)
    return (
      <span className="agent-availability" data-tone="warn">
        <WifiOff size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        <span>Mac 不在线</span>
      </span>
    )
  if (available) return <span className="agent-availability">可用</span>
  if (!reason)
    return (
      <span className="agent-availability" data-tone="warn">
        <StatusWord tone="warn">不可用</StatusWord>
      </span>
    )
  return (
    <Hint
      className="agent-availability"
      label="不可用"
      lead={<TriangleAlert size={12} strokeWidth={ICON_STROKE[12]} />}
      moreLabel="为什么不可用">
      {reason}
    </Hint>
  )
}

/** A device whose data scope leaves Agents out: what is locked, and the fine print behind ⓘ. */
export function LockedAgents() {
  return (
    <div className="agents-locked" role="status">
      <Hint label="这台设备看不到 Agent" lead={<LockKeyhole size={12} strokeWidth={ICON_STROKE[12]} />}>
        Agent 的指令、记忆和会话只对能读取全部数据的设备开放。在这台 Mac 的 设置 › 设备 里为这台设备打开「可以看项目文件」后可见。
      </Hint>
    </div>
  )
}

/** Code and 我的 Agent, the two places of the navigation, under 新会话 and 搜索. */
export function EntryRows({
  current,
  onEntry,
  agents = true,
}: {
  current: ShellEntry
  onEntry: (entry: ShellEntry) => void
  /** 我的 Agent is one of this device's entries. */
  agents?: boolean
}) {
  const rows: Array<{ entry: ShellEntry; label: string; icon: ReactNode }> = [
    { entry: 'sessions', label: 'Code', icon: <Code2 size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" /> },
    ...(agents ? [{ entry: 'agents' as const, label: '我的 Agent', icon: <AgentsMark size={16} /> }] : []),
  ]
  return (
    <div className="sidebar-entries" role="group" aria-label="入口">
      {rows.map(row => (
        <button
          key={row.entry}
          type="button"
          className="sidebar-nav-row sidebar-entry"
          aria-current={current === row.entry ? 'page' : undefined}
          onClick={() => {
            onEntry(row.entry)
          }}>
          {row.icon}
          <span>{row.label}</span>
        </button>
      ))}
    </div>
  )
}
