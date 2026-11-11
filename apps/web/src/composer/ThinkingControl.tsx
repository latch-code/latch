import type { ReactNode } from 'react'
import type { HarnessInfo, HostCatalog, ModelRef, SessionConfigOption } from '@latch/protocol'
import { Button, InlineNotice, MenuFooterLink, ValuePicker, useLayerClose, type PickerOption } from '@latch/ui'
import type { DeviceAccess } from '../core/permissions.ts'
import { draftConfig, engineEntries, harnessName, servicePick, thinkingLevels, type ComposerChoice } from '../composerChoice.ts'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { readOnSelect, readsOnSelect, useReading } from './harnessCatalogue.tsx'
import {
  agentConfigBlocked,
  agentConfigChoice,
  agentConfigLabel,
  agentConfigValues,
  BUILTIN_THINKING_NOTE,
  DEFAULT_LEVEL,
  resetModelLabel,
  THINKING_AFTER_START,
  thinkingWord,
  unreportedThinkingNote,
  type AgentConfigState,
  type SessionConfigFeedback,
} from './modelReasoning.ts'

type Access = Pick<DeviceAccess, 'scopes'>
/** The built-in row's first value: no level sent, the model's own default. Not a valid wire level, so it never collides. */
const MODEL_DEFAULT_LEVEL = '~default'

/**
 * 思考, its own control beside 权限: the small word 思考 and the value. It always opens, so touch reads what a hover
 * would: with nothing to choose it lists the one row 默认 and at most one line on why, and draws no arrow.
 */
function ThinkingPicker({
  value,
  options,
  valueText,
  note,
  footer,
  pending = false,
  pendingLabel,
  disabled = false,
  disabledReason,
  onChoose,
  onOpenChange,
}: {
  value: string | undefined
  options: Array<PickerOption<string>>
  /** The trigger's words when they are not the chosen row's: a switch for the next message, an unknown outcome. */
  valueText?: string | undefined
  note?: string | undefined
  /** Rows after the note: undoing a switch, refreshing after an unknown outcome. */
  footer?: ReactNode
  pending?: boolean
  pendingLabel?: string
  disabled?: boolean
  disabledReason?: string | undefined
  onChoose: (value: string) => void | Promise<void>
  onOpenChange?: ((open: boolean) => void) | undefined
}) {
  const fixed = options.length <= 1
  const content =
    note || footer ? (
      <div className="model-footer">
        {note && <p className="model-note">{note}</p>}
        {footer}
      </div>
    ) : null
  return (
    <ValuePicker
      label="思考"
      value={value}
      options={options}
      {...(valueText !== undefined ? { valueText } : {})}
      leading={
        <span className="thinking-label" aria-hidden="true">
          思考
        </span>
      }
      className={fixed ? 'thinking-picker is-fixed' : 'thinking-picker'}
      menuChevron
      align="end"
      // A Harness's own line under each of its levels needs the room; Latch's words do not.
      width={options.some(option => option.description) ? 340 : 240}
      // Never undefined: the picker would draw a single value as plain text that does not open.
      footer={content}
      pending={pending}
      {...(pendingLabel ? { pendingLabel } : {})}
      disabled={disabled}
      disabledReason={disabledReason}
      {...(onOpenChange ? { onOpenChange } : {})}
      onValueChange={onChoose}
    />
  )
}

/** 思考 on the built-in Harness: 默认, then the levels declared for this model in settings. A pick goes with the model. */
function BuiltinThinking({
  catalog,
  model,
  current,
  disabled,
  disabledReason,
  onModel,
  onReset,
}: {
  catalog: HostCatalog
  model: ModelRef | undefined
  /** In a session, what the last turn ran on: a level that differs applies from the next message. */
  current?: ModelRef | undefined
  disabled: boolean
  disabledReason?: string | undefined
  onModel: (model: ModelRef) => void
  onReset?: (() => void) | undefined
}) {
  const levels = thinkingLevels(catalog, model)
  // A level taken away in settings since it was chosen: shown as it is, so 默认 is one press away.
  const withdrawn = model?.effort !== undefined && !levels.includes(model.effort)
  const options = [
    { value: MODEL_DEFAULT_LEVEL, label: DEFAULT_LEVEL },
    ...(model ? levels.map(level => ({ value: level, label: thinkingWord(level) })) : []),
  ]
  const word = model?.effort ? thinkingWord(model.effort) : DEFAULT_LEVEL
  const switching = current !== undefined && model !== undefined && model.effort !== current.effort
  const note = withdrawn
    ? `这个模型不再设置「${thinkingWord(model.effort!)}」，重新选一个后再发送。`
    : model && levels.length === 0
      ? BUILTIN_THINKING_NOTE
      : undefined
  return (
    <ThinkingPicker
      value={model?.effort ?? MODEL_DEFAULT_LEVEL}
      options={options}
      valueText={switching ? `下一条：${word}` : word}
      note={note}
      footer={
        switching && onReset ? (
          <MenuFooterLink chevron={false} closes onClick={onReset}>
            {resetModelLabel(current)}
          </MenuFooterLink>
        ) : undefined
      }
      disabled={disabled}
      disabledReason={disabledReason}
      onChoose={value => {
        if (!model) return
        onModel({ providerId: model.providerId, model: model.model, ...(value === MODEL_DEFAULT_LEVEL ? {} : { effort: value }) })
      }}
    />
  )
}

/**
 * 思考 on a Harness with its own models: the levels it reported, in its own names (Low, High) with its own line under
 * each where it gives one. With none reported it is 默认 and says why.
 */
function HarnessThinking({
  option,
  note,
  state,
  onRefresh,
  onChoose,
  reading = false,
  disabled = false,
  disabledReason,
  onOpenChange,
}: {
  option: SessionConfigOption | undefined
  note: string | undefined
  state: AgentConfigState
  onRefresh?: (() => void | Promise<void>) | undefined
  onChoose: (configId: string, value: string) => void | Promise<void>
  reading?: boolean
  disabled?: boolean
  disabledReason?: string | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
}) {
  const { feedback } = state
  const blocked = agentConfigBlocked(state)
  const notice = feedback && <ConfigFeedback feedback={feedback} onRefresh={onRefresh} />
  if (!option)
    return (
      <ThinkingPicker
        value={MODEL_DEFAULT_LEVEL}
        options={[{ value: MODEL_DEFAULT_LEVEL, label: DEFAULT_LEVEL }]}
        note={note}
        footer={notice}
        pending={reading}
        pendingLabel="正在读取…"
        disabled={disabled}
        disabledReason={disabledReason}
        onOpenChange={onOpenChange}
        onChoose={() => {}}
      />
    )
  const label = agentConfigLabel(option)
  return (
    <ThinkingPicker
      value={option.currentValue}
      options={agentConfigValues(option).map(item => ({
        value: item.value,
        label: escapeHiddenCharacters(item.name),
        // Some Harnesses repeat the level's name as its description, which says nothing more.
        ...(item.description && item.description.trim().toLowerCase() !== item.name.trim().toLowerCase()
          ? { description: escapeHiddenCharacters(item.description) }
          : {}),
        ...(blocked
          ? { disabledReason: feedback?.kind === 'unknown' ? '上次切换的结果未知，请先刷新当前设置。' : '正在切换，请稍后。' }
          : {}),
      }))}
      valueText={escapeHiddenCharacters(feedback?.kind === 'unknown' ? `${label} · 结果未知` : label)}
      note={note}
      footer={notice}
      pending={reading || state.busy === option.id}
      pendingLabel={reading ? '正在读取…' : '正在切换…'}
      disabled={disabled}
      disabledReason={disabledReason}
      onOpenChange={onOpenChange}
      onChoose={value => {
        const intent = agentConfigChoice([option], option.id, value, state)
        if (intent) return onChoose(intent.configId, intent.value)
        return undefined
      }}
    />
  )
}

/** The thinking of a new session: on the built-in Harness with the model it goes with, otherwise as the Harness's list says. */
export function DraftThinkingControl({
  catalog,
  choice,
  onChoice,
  access,
  disabled,
  onRead,
}: {
  catalog: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  access: Access
  disabled: boolean
  onRead?: (() => void | Promise<void>) | undefined
}) {
  const harness = engineEntries(catalog, choice.workspaceId).find(entry => entry.harness.id === choice.harnessId)?.harness
  const reading = useReading(harness)
  if (!harness)
    return (
      <ThinkingPicker
        value={MODEL_DEFAULT_LEVEL}
        options={[{ value: MODEL_DEFAULT_LEVEL, label: DEFAULT_LEVEL }]}
        disabled
        disabledReason="先选一个 Harness，才知道有哪些思考。"
        onChoose={() => {}}
      />
    )
  if (harness.capabilities.models.owner === 'latch')
    return (
      <BuiltinThinking
        catalog={catalog}
        model={choice.model}
        disabled={disabled}
        onModel={model => {
          onChoice({ model })
        }}
      />
    )
  const name = harnessName(harness)
  const known = draftConfig(harness, choice.config)
  // A service's model reports its levels only once a session runs on it.
  const service = servicePick(catalog, harness, choice.config)
  const option = service ? undefined : known?.config.find(item => item.category === 'thought_level')
  const note = service
    ? THINKING_AFTER_START(name)
    : known
      ? known.thinkingUnknown
        ? THINKING_AFTER_START(name)
        : unreportedThinkingNote(name, true, known.config)
      : harness.catalogueRead
        ? undefined
        : unreportedThinkingNote(name, false, [])
  return (
    <HarnessThinking
      option={option}
      note={note}
      state={{ busy: null }}
      reading={reading}
      disabled={disabled}
      // Opening the thinking of a Harness nothing is known of asks what it offers, as its model menu does.
      onOpenChange={open => {
        if (open && readsOnSelect(harness, access)) readOnSelect(harness, onRead)
      }}
      onChoose={(configId, value) => {
        onChoice({ config: { ...choice.config, [configId]: value } })
      }}
    />
  )
}

/**
 * The same control in a session. On the built-in Harness a level goes with the next message, like a model switch; a
 * Harness with its own models takes the change at once, and a busy or unknown write holds the next one back.
 */
export function SessionThinkingControl({
  catalog,
  harness,
  model,
  current,
  onModel,
  config,
  busy,
  feedback,
  onRefresh,
  onConfig,
  locked,
}: AgentConfigState & {
  catalog: HostCatalog
  harness: HarnessInfo | undefined
  model: ModelRef | undefined
  current: ModelRef | undefined
  onModel: (model: ModelRef | undefined) => void
  config: readonly SessionConfigOption[]
  onRefresh?: (() => void | Promise<void>) | undefined
  onConfig: (configId: string, value: string) => void | Promise<void>
  /** This device may read the session but not change it: why, as the tooltip. */
  locked?: string | undefined
}) {
  if (harness?.capabilities.models.owner === 'latch' && catalog.providers.length > 0)
    return (
      <BuiltinThinking
        catalog={catalog}
        model={model}
        current={current}
        disabled={locked !== undefined}
        disabledReason={locked}
        onModel={onModel}
        onReset={() => {
          onModel(undefined)
        }}
      />
    )
  const option = config.find(item => item.category === 'thought_level')
  return (
    <HarnessThinking
      option={option}
      note={unreportedThinkingNote(harness ? harnessName(harness) : 'Harness', true, config)}
      state={{ busy, ...(feedback ? { feedback } : {}) }}
      onRefresh={onRefresh}
      onChoose={onConfig}
      disabled={locked !== undefined}
      disabledReason={locked}
    />
  )
}

/** A config write that failed or whose outcome is unknown, in the menu of the control it blocks; the latter offers a refresh. */
export function ConfigFeedback({
  feedback,
  onRefresh,
}: {
  feedback: SessionConfigFeedback
  onRefresh?: (() => void | Promise<void>) | undefined
}) {
  return (
    <InlineNotice
      tone={feedback.kind === 'unknown' ? 'warn' : 'error'}
      action={feedback.kind === 'unknown' && onRefresh ? <RefreshConfig refresh={onRefresh} /> : undefined}>
      <VisibleText text={feedback.message} />
    </InlineNotice>
  )
}

function RefreshConfig({ refresh }: { refresh: () => void | Promise<void> }) {
  const close = useLayerClose()
  return (
    <Button
      size="xs"
      onClick={() => {
        void Promise.resolve(refresh())
          .then(close)
          .catch(() => {})
      }}>
      刷新当前设置
    </Button>
  )
}
