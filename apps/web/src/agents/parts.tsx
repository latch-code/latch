import { Hint, ICON_STROKE, StatusWord, LockGlyph, WarningGlyph, OfflineGlyph } from '@latch/ui'
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
        <OfflineGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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
      lead={<WarningGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}
      moreLabel="为什么不可用">
      {reason}
    </Hint>
  )
}

/** A device whose data scope leaves Agents out: what is locked, and the fine print behind ⓘ. */
export function LockedAgents() {
  return (
    <div className="agents-locked" role="status">
      <Hint label="这台设备看不到 Agent" lead={<LockGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}>
        Agent 的指令、记忆和会话只对能读取全部数据的设备开放。在这台 Mac 的 设置 › 设备 里为这台设备打开「可以看项目文件」后可见。
      </Hint>
    </div>
  )
}
