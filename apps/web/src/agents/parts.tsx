import { Button, Hint, ICON_STROKE, Popover, StatusWord, LockGlyph, ShieldGlyph, WarningGlyph, OfflineGlyph } from '@latch/ui'
import type { HarnessInfo, HostCatalog, TaskMode, TaskSummary } from '@latch/protocol'
import { routeService } from '../composer/ModelControl.tsx'
import { draftPermission } from '../composer/permission.ts'
import { MODE_COPY } from '../core/securityCopy.ts'
import type { AvatarState } from './avatarFace.ts'
import { isolationBrief } from './helpers.ts'
import { ACTIVITY_WORDS } from './model.ts'
import { DEVICE_OFFLINE } from '../core/hostState.ts'

/** The state word beside a face, for the states that have one; `live`: what a running one is doing, in a person's words. */
export function ActivityWord({ state, live }: { state: AvatarState; live?: { words: string } | undefined }) {
  const known = ACTIVITY_WORDS[state]
  const word = known && state === 'running' && live ? { ...known, words: live.words } : known
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
        <span>{DEVICE_OFFLINE}</span>
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
    <Hint className="agent-availability" label="不可用" lead={<WarningGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}>
      {reason}
    </Hint>
  )
}

/**
 * An Agent that cannot start a topic now (its Harness is missing or too old), where its conversation is open: 不可用, the
 * Host's reason behind ⓘ, and the way to repair it on a device that may change 设置. Its topics stay readable.
 */
export function Unavailable({ reason, onRepair }: { reason?: string | undefined; onRepair?: (() => void) | undefined }) {
  return (
    <span className="agent-unavailable">
      <Hint className="agent-availability" label="不可用" lead={<WarningGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}>
        {reason ?? '现在不能开始聊天。'}
        {!onRepair && ' 在这台 Mac 的 设置 里修复。'}
      </Hint>
      {onRepair && (
        <Button variant="outline" size="xs" onClick={onRepair}>
          去修复
        </Button>
      )}
    </span>
  )
}

/** A device whose data scope leaves Agents out: what is locked, and the fine print behind ⓘ. */
export function LockedAgents() {
  return (
    <div className="agents-locked" role="status">
      <Hint label="这台设备看不到 Agent" lead={<LockGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}>
        Agent 的指令、记忆和会话只对能读取全部数据的设备开放。在这台 Mac 的 设置 › 设备 里为这台设备打开「也能看私有内容」后可见。
      </Hint>
    </div>
  )
}

/**
 * 「不先问你」 or 「权限没确认」 beside a helper's name, amber, or a mode Latch has no word for, neutral; the reason behind
 * ⓘ (agents/personWords.ts). The words stay on every width: amber always comes with text.
 */
export function PermissionNote({ words, detail, tone }: { words: string; detail: string; tone: 'warn' | 'neutral' }) {
  return (
    <Popover
      label={`${words}：说明`}
      title={words}
      size="sm"
      trigger={props => (
        <Button
          {...props}
          variant="ghost"
          size="xs"
          icon={tone === 'warn' ? WarningGlyph : ShieldGlyph}
          className={`agent-permission-note agent-boundary-trigger is-${tone}`}
          // 不先问你 and 权限没确认 look the same under every customisation (tokens.css).
          data-lock={tone === 'warn' ? '' : undefined}
          aria-label={`${words}：说明`}
          // A warning keeps its words beside the name; the neutral boundary is its shield, its words behind it.
          data-icon-only={tone === 'warn' ? undefined : ''}
          title={tone === 'warn' ? undefined : words}>
          {tone === 'warn' && <span>{words}</span>}
        </Button>
      )}>
      <p className="agent-boundary-detail">{detail}</p>
    </Popover>
  )
}

/** The boundary stays reachable even when the chosen mode asks first and has no warning to show. */
export function IsolationNote({ name }: { name: string }) {
  const brief = MODE_COPY.firstStart(name)
  return <PermissionNote words={brief.label} detail={brief.detail ?? brief.label} tone="neutral" />
}

/**
 * 「做事前」 where a person picks or keeps a helper (creation's 更多, 资料 › 设置): the tier its Harness declares, amber
 * when it never asks, and behind ⓘ that Latch does not isolate an external Harness (`isolationBrief`), with the
 * tiers that cannot be set yet.
 */
export function BeforeActing({ harness, mode }: { harness: HarnessInfo; mode: TaskMode }) {
  const permission = draftPermission(harness, mode)
  const isolation = isolationBrief(harness)
  const amber = permission?.amber === true
  return (
    <Hint
      className={amber ? 'agent-permission-note is-warn' : undefined}
      locked={amber}
      label={permission?.label ?? MODE_COPY.askFirst}
      lead={
        amber ? (
          <WarningGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
        ) : (
          <ShieldGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
        )
      }>
      {isolation ? `${isolation.label}。${isolation.detail} ` : ''}其他档位在开始时设置尚未实现。
    </Hint>
  )
}

/**
 * Under a helper's input when its session's route to a model service needs saying: a turn that did not go through Latch,
 * or a service the next turn will fail on. Short words in amber, the full reason behind ⓘ; nothing while the route is fine.
 */
export function RouteWarning({ catalog, route }: { catalog: HostCatalog; route: NonNullable<TaskSummary['modelRoute']> }) {
  const service = routeService(catalog, route)
  const brief = service.unusable
    ? { label: `下一轮会失败：模型服务${service.unusable.words}`, detail: service.unusable.note }
    : route.bypassed
      ? { label: '有一轮没经过 Latch', detail: '那一轮可能用了它自己的登录或配置，内容可能发给了别的服务。' }
      : undefined
  if (!brief) return null
  return (
    <div className="composer-notice" data-tint="warn" role="note">
      <Hint
        inline
        className="agent-permission-note is-warn"
        label={brief.label}
        lead={<WarningGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}
        moreLabel="说明">
        {brief.detail}
      </Hint>
    </div>
  )
}
