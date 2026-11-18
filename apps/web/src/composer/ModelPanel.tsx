import { useState, type ReactNode } from 'react'
import { Route } from 'lucide-react'
import {
  parseModelChoice,
  type HarnessInfo,
  type HostCatalog,
  type ModelRef,
  type SessionConfigOption,
  type TaskSummary,
} from '@latch/protocol'
import {
  MenuFooterLink,
  MenuFooterNote,
  PickerBoard,
  SegmentedControl,
  ValuePicker,
  HistoryGlyph,
  Icon,
  ModelGlyph,
  PlusGlyph,
  Badge,
  type BoardItem,
  type BoardLevels,
  type BoardSource,
  type PickerGroup,
} from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { MODE_COPY, SETUP_COPY, type Brief } from '../core/securityCopy.ts'
import {
  draftConfig,
  engineEntries,
  findProvider,
  harnessName,
  sameModel,
  servicePick,
  switchModel,
  thinkingLevels,
  withOwnDefault,
  withServicePick,
  withTypedModels,
  type ComposerChoice,
} from '../composerChoice.ts'
import { fuzzyModelMatch, modelKey, rememberModel, useModelPreferences } from '../modelPreferences.ts'
import { ProviderTile } from '../components/BrandTile.tsx'
import { ModelAddPanel, modelGroups } from '../components/Pickers.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { capsText, shortcutCaps, shortcutKeys, workbenchShortcut } from '../workbenchShortcuts.ts'
import { BriefHint } from './BriefHint.tsx'
import { useSearchRequest } from './ComposerControl.tsx'
import {
  CatalogueRows,
  readHarnessCatalogue,
  readOnSelect,
  readsModel,
  readsOnSelect,
  TypedModelsPanel,
  useReading,
} from './harnessCatalogue.tsx'
import {
  defaultModelOf,
  defaultTag,
  ROUTING_COPY,
  OWN_MODEL,
  type ModelGroup,
  ownModelGroups,
  routeService,
  serviceRef,
  serviceValue,
  unusableServices,
  UnusableServices,
} from './ModelControl.tsx'
import {
  agentConfigBlocked,
  agentConfigChoice,
  agentConfigLabel,
  agentConfigValues,
  REASONING_COPY,
  feedbackFor,
  resetModelLabel,
  sameModelId,
  thinkingWord,
  unreportedModelNote,
  unreportedThinkingNote,
  type AgentConfigState,
} from './modelReasoning.ts'
import { ConfigFeedback, ReadPickedModel, useSlowWrite } from './ThinkingControl.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    thinking: '思考',
    model: '模型',
    levelUnavailable: '这个模型不再设置这一档',
    chooseAnotherLevel: (value1: string) => `这个模型不再设置「${value1}」，重新选一个后再发送。`,
    switchBusy: '正在切换，请稍后。',
    outcomeUnknown: (value1: string) => `${value1} · 结果未知`,
    reading: '正在读取…',
    waitingFor: (value1: string) => `等 ${value1} 回应…`,
    switching: '正在切换…',
    bypassedPrefix: '有一轮没经过 Latch，可能用了 ',
    bypassedSuffix: ' 自己的登录或配置',
    manageModels: '管理模型…',
    chooseHarness: '先选 Harness',
    levelsNeedHarness: '先选一个 Harness，才知道有哪些思考。',
    useModelList: '在模型列表里选',
    readLevels: '读取思考档位',
    chooseModel: '选择模型',
    addService: '添加模型服务…',
    nextMessage: (value1: string) => `下一条：${value1}`,
  },
  {
    thinking: 'Thinking',
    model: 'Model',
    levelUnavailable: 'This model no longer offers that level',
    chooseAnotherLevel: (value1: string) => `This model no longer offers “${value1}”. Choose another level before sending.`,
    switchBusy: 'Switching. Try again in a moment.',
    outcomeUnknown: (value1: string) => `${value1} · Outcome unknown`,
    reading: 'Reading…',
    waitingFor: (value1: string) => `Waiting for ${value1}…`,
    switching: 'Switching…',
    bypassedPrefix: 'A turn bypassed Latch and may have used ',
    bypassedSuffix: '’s own login or configuration',
    manageModels: 'Manage models…',
    chooseHarness: 'Choose a Harness first',
    levelsNeedHarness: 'Choose a Harness to see its thinking levels.',
    useModelList: 'Choose in the model list',
    readLevels: 'Read thinking levels',
    chooseModel: 'Choose model',
    addService: 'Add model service…',
    nextMessage: (value1: string) => `Next message: ${value1}`,
  },
)

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin' | 'scopes'>

/** No level sent: the model's own default. Not a valid wire level, so it never collides. */
const MODEL_DEFAULT_LEVEL = '~default'
const defaultOnly = (): BoardLevels<string>['options'] => [{ value: MODEL_DEFAULT_LEVEL, label: REASONING_COPY.defaultLevel }]

/** What a chip shows: the model's or the thinking's. */
interface ChipFace {
  /** Undefined: the placeholder, in muted ink. */
  valueText: string | undefined
  placeholder?: string
  leading?: ReactNode
  className: string
  pending?: boolean
  pendingLabel?: string
  disabled?: boolean
  disabledReason?: string | undefined
  /** The tooltip of an enabled chip: a fact about its value the panel does not spell out. */
  hint?: string | undefined
}

/**
 * The one panel the 模型 and 思考 chips both open: the sources of the session's models, the models, and the thinking of
 * the highlighted one. Built from the same data hooks the menus used, so a list that changes flows in unchanged.
 */
export interface Board {
  model: ChipFace
  thinking: ChipFace
  groups: ModelGroup[]
  value: string | undefined
  levels: (value: string | undefined) => BoardLevels<string>
  onModel: (value: string) => void
  onLevel: (model: string | undefined, level: string) => void
  staysOn?: (value: string) => boolean
  settings?: ReactNode
  footer?: ReactNode
  /** Shown in the board's place: adding a service, typing a model ID. */
  panel?: ReactNode
  onOpenChange?: (open: boolean) => void
  /** Draws nothing; runs with the chip (a read the pick starts). */
  effects?: ReactNode
}

/** The rail's mark for a source: its tile, or the glyph of what it is when it has none. */
function sourceIcon(group: PickerGroup<string>): ReactNode {
  if (group.media) return group.media
  return <Icon icon={group.id === '~recent' ? HistoryGlyph : ModelGlyph} size={16} />
}

const boardItems = (group: PickerGroup<string>): Array<BoardItem<string>> =>
  group.options.map(option => ({
    value: option.value,
    label: option.label,
    ...(option.media ? { media: option.media } : {}),
    ...(option.tag ? { tag: option.tag } : {}),
    ...(option.disabledReason ? { disabledReason: option.disabledReason } : {}),
  }))

/**
 * The panel's sources: each group its own, except the services whose requests go through Latch's gateway, which are one
 * source, 「Latch 网关」, in the place of the first of them, each service a group headed by its name. Where its requests
 * go and what a translation leaves out stay on the hover of that heading; the rail says only the name.
 */
export function boardSources(groups: ReadonlyArray<ModelGroup>): Array<BoardSource<string>> {
  const gateway = groups.filter(group => group.gateway)
  const sources: Array<BoardSource<string>> = []
  for (const group of groups) {
    if (!group.gateway) {
      sources.push({
        id: group.id,
        label: group.label ?? '',
        icon: sourceIcon(group),
        ...(group.hint ? { hint: group.hint } : {}),
        items: boardItems(group),
      })
      continue
    }
    if (group !== gateway[0]) continue
    const experimental = gateway.every(item => item.gateway?.experimental)
    sources.push({
      id: '~gateway',
      label: ROUTING_COPY.gateway,
      ...(experimental ? { tip: `${ROUTING_COPY.gateway} · ${ROUTING_COPY.experimental}` } : {}),
      // A route, not a chip: the model glyph's pins read as a gear at this size.
      icon: <Icon icon={Route} size={16} />,
      groups: gateway.map(item => ({
        id: item.id,
        label: item.label ?? '',
        ...(item.media ? { media: item.media } : {}),
        ...(item.gateway?.experimental ? { tag: <Badge>{ROUTING_COPY.experimental}</Badge> } : {}),
        ...(item.hint ? { hint: item.hint } : {}),
        ...(item.note ? { note: item.note } : {}),
        items: boardItems(item),
      })),
    })
  }
  return sources
}

/**
 * The keys of the Nth model in the panel, as the registry writes the session keys it shares: drawn only in the desktop app,
 * whose keys are settled; in a browser they work and are listed under 快捷键, but are not drawn.
 */
export function pickCaps(index: number, desktop: boolean = currentShell() !== null): string | undefined {
  if (!desktop || index > 8) return undefined
  const keys = shortcutKeys('session', true)
  const first = keys === null ? undefined : shortcutCaps(keys)[0]
  if (!first?.caps.length) return undefined
  return capsText([...first.caps.slice(0, -1), String(index + 1)])
}

/** The row a key picks while the panel is open: the keys that jump to the Nth session elsewhere. */
export function pickIndex(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>,
  desktop: boolean = currentShell() !== null,
): number | undefined {
  const action = workbenchShortcut({ ...event, typing: false }, desktop)
  return typeof action === 'object' && action !== null && action.kind === 'session' ? action.index - 1 : undefined
}

/**
 * Both chips open the one panel in one place: against the 模型 chip of the same row, the nearest one up the tree (the
 * chip itself for 模型). Without one, the chip that opened it.
 */
function besideModel(trigger: HTMLElement): HTMLElement {
  let scope: HTMLElement | null = trigger.parentElement
  for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
    const model = scope.querySelector<HTMLElement>('button.model-picker')
    if (model) return model
  }
  return trigger
}

/** Past this many characters a chip's value may be cut off at a narrow width. */
const LONG_NAME = 24

/** The 模型 or 思考 chip: its value, and the shared panel focused on the list or the levels. */
function BoardChip({ board, kind }: { board: Board; kind: 'model' | 'thinking' }) {
  const face = board[kind]
  const request = useSearchRequest()
  const value = face.valueText === undefined ? undefined : '~face'
  return (
    <>
      {board.effects}
      <ValuePicker
        label={COPY[kind]}
        value={value}
        options={value ? [{ value, label: face.valueText! }] : []}
        {...(face.placeholder ? { placeholder: face.placeholder } : {})}
        {...(kind === 'thinking'
          ? {
              leading: (
                <span className="thinking-label" aria-hidden="true">
                  {COPY.thinking}
                </span>
              ),
            }
          : face.leading
            ? { leading: face.leading }
            : {})}
        className={face.className}
        menuChevron
        anchor={besideModel}
        width={board.panel ? 'md' : 'lg'}
        pending={face.pending === true}
        {...(face.pendingLabel ? { pendingLabel: face.pendingLabel } : {})}
        disabled={face.disabled === true}
        disabledReason={face.disabledReason}
        // A long model name truncates on the chip; hovering shows it whole.
        {...(face.hint ? { hint: face.hint } : face.valueText && face.valueText.length > LONG_NAME ? { hint: face.valueText } : {})}
        {...(board.onOpenChange ? { onOpenChange: board.onOpenChange } : {})}
        onValueChange={() => {}}
        // A slash argument (/model <query>) opens the panel on that search; the board fills its own field from it.
        {...(kind === 'model' && request ? { searchRequest: request } : {})}
        panel={
          board.panel ?? (
            <PickerBoard
              label={COPY.model}
              levelsLabel={COPY.thinking}
              sources={boardSources(board.groups)}
              value={board.value}
              levels={board.levels}
              onItem={board.onModel}
              onLevel={board.onLevel}
              staysOn={board.staysOn}
              focus={kind === 'thinking' ? 'levels' : 'list'}
              keyCaps={pickCaps}
              pickIndex={event => pickIndex(event)}
              searchMatch={(item, query) => fuzzyModelMatch(item.label, query)}
              query={kind === 'model' ? request : undefined}
              settings={board.settings}
              footer={board.footer}
              className={kind === 'thinking' ? 'model-board is-thinking' : 'model-board'}
            />
          )
        }
      />
    </>
  )
}

/** A Brief or a few words, at the foot of the levels column. */
function noteOf(note: string | Brief | undefined): ReactNode {
  if (note === undefined) return undefined
  return typeof note === 'string' ? note : <BriefHint brief={note} className="model-note" />
}

/** A model setting the Harness reports besides thinking (a speed): a few values as segments, more as a row. */
function ConfigRow({ option, disabled, onChoose }: { option: SessionConfigOption; disabled: boolean; onChoose: (value: string) => void }) {
  const values = agentConfigValues(option)
  const name = escapeHiddenCharacters(option.name)
  if (values.length >= 2 && values.length <= 3)
    return (
      <div className="model-setting">
        <span className="model-setting-name">{name}</span>
        <SegmentedControl
          label={name}
          size="xs"
          value={option.currentValue}
          disabled={disabled}
          options={values.map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
          onValueChange={onChoose}
        />
      </div>
    )
  return (
    <ValuePicker
      variant="row"
      label={name}
      value={option.currentValue}
      options={values.map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
      disabled={disabled}
      searchable={option.options.length > 8}
      onValueChange={onChoose}
    />
  )
}

// ---- The built-in Harness: Latch's own services ---------------------------------------------------------------------

function builtinLevels(catalog: HostCatalog, chosen: ModelRef | undefined, key: string | undefined): BoardLevels<string> {
  const [providerId = '', name = ''] = key?.split('\u0000') ?? []
  const ref = key ? { providerId, model: name } : chosen
  if (!ref) return { value: MODEL_DEFAULT_LEVEL, options: defaultOnly() }
  const levels = thinkingLevels(catalog, ref)
  const current = chosen !== undefined && sameModelId(chosen, ref)
  // Another model keeps the level when it declares it too (`switchModel`): what choosing it would start on.
  const effort = chosen?.effort !== undefined && (current || levels.includes(chosen.effort)) ? chosen.effort : undefined
  const withdrawn = current && effort !== undefined && !levels.includes(effort)
  return {
    value: effort ?? MODEL_DEFAULT_LEVEL,
    options: [
      ...defaultOnly(),
      ...levels.map(level => ({ value: level, label: thinkingWord(level) })),
      ...(withdrawn ? [{ value: effort, label: thinkingWord(effort), disabledReason: COPY.levelUnavailable }] : []),
    ],
    note: withdrawn
      ? noteOf(COPY.chooseAnotherLevel(thinkingWord(effort)))
      : levels.length === 0
        ? noteOf(REASONING_COPY.builtinNote)
        : undefined,
  }
}

function withLevel(key: string | undefined, chosen: ModelRef | undefined, level: string): ModelRef | undefined {
  const [providerId = '', name = ''] = key?.split('\u0000') ?? []
  const ref = key ? { providerId, model: name } : chosen
  if (!ref) return undefined
  return { providerId: ref.providerId, model: ref.model, ...(level === MODEL_DEFAULT_LEVEL ? {} : { effort: level }) }
}

/** Groups without the line under each option: a panel row is the model alone. */
const plain = (groups: Array<PickerGroup<string>>) =>
  groups.map(group => ({ ...group, options: group.options.map(option => ({ ...option, description: undefined })) }))

// ---- A Harness with its own models ----------------------------------------------------------------------------------

interface HarnessThinking {
  /** The thinking of the model in use, as reported or as the draft knows it. */
  option: SessionConfigOption | undefined
  note?: string | Brief | undefined
  /** While the Harness reported no levels: what its lone 默认 means, on hover of that row and of the chip. */
  defaultHint?: string | undefined
  /** Rows under the levels: reading what the picked model offers. */
  footer?: ReactNode
  hint?: string | undefined
  /** A draft: the thinking a pick of another model would offer, as the Host knows it. */
  of?: ((value: string) => SessionConfigOption | undefined) | undefined
  /** A draft: choosing another model and a level of it at once. */
  pickWith?: ((value: string, configId: string, level: string) => void) | undefined
}

/**
 * A Harness's own models with their thinking and other options, from one list: a running session's `config`, or for a
 * draft the list its last session offered. A pick is an intent, written to the session or kept for the start.
 */
function harnessBoard({
  catalog,
  harness,
  config: given,
  reported,
  state,
  slow,
  onRefresh,
  onConfig,
  manage,
  locked,
  disabled,
  note: noteOverride,
  rows,
  panel,
  reading = false,
  onOpenChange,
  service,
  computer,
  defaultModel,
  thinking,
}: {
  catalog: HostCatalog
  harness: HarnessInfo | undefined
  config: readonly SessionConfigOption[]
  reported?: string | undefined
  state: AgentConfigState
  /** A write has waited long enough to say whose answer it waits for. */
  slow: boolean
  onRefresh?: (() => void | Promise<void>) | undefined
  onConfig: (configId: string, value: string) => void | Promise<void>
  manage: ReactNode
  locked?: string | undefined
  disabled?: boolean | undefined
  note?: string | null | undefined
  rows?: ReactNode
  panel?: ReactNode
  reading?: boolean
  onOpenChange?: ((open: boolean) => void) | undefined
  service?:
    | { picked?: ModelRef | undefined; onPick?: (model: ModelRef | undefined) => void }
    | { session: true; route?: TaskSummary['modelRoute'] }
  computer?: string | undefined
  defaultModel?: string | undefined
  thinking: HarnessThinking
}): Board {
  const { busy, feedback } = state
  // IDs typed for the Harness's own login are no model of the service a session's route goes to.
  const routed = service !== undefined && 'session' in service && service.route !== undefined
  const config = withTypedModels(given, routed ? undefined : harness?.customModels)
  const blocked = agentConfigBlocked(state)
  const blockedReason = blocked ? (feedback?.kind === 'unknown' ? REASONING_COPY.unknown : COPY.switchBusy) : undefined
  const choose = (id: string, value: string) => {
    const intent = agentConfigChoice(config, id, value, state)
    if (intent) return onConfig(intent.configId, intent.value)
    return undefined
  }
  const modelOption = config.find(option => option.category === 'model')
  const others = config.filter(option => option.category === 'model_config')
  const name = harness ? harnessName(harness) : 'Harness'
  const reportedOr = modelOption ? agentConfigLabel(modelOption) : reported
  const picked = service && 'picked' in service ? service.picked : undefined
  const session = service && 'session' in service ? { route: service.route } : undefined
  const pickedProvider = findProvider(catalog, picked?.providerId ?? session?.route?.providerId)
  const text = picked ? picked.model : (reportedOr ?? REASONING_COPY.defaultModel)
  const note = noteOverride === null ? undefined : (noteOverride ?? unreportedModelNote(name, true, config))
  const writing = busy !== null && (busy === modelOption?.id || others.some(option => option.id === busy))
  const ownFeedback = feedbackFor(feedback, [modelOption?.id, ...others.map(option => option.id)])
  const groups = ownModelGroups(
    catalog,
    harness,
    modelOption
      ? agentConfigValues(modelOption).map(item => ({
          value: item.value,
          label: escapeHiddenCharacters(item.name),
          ...defaultTag(item.value, defaultModel),
          ...(blockedReason ? { disabledReason: blockedReason } : {}),
        }))
      : [{ value: OWN_MODEL, label: reportedOr ?? REASONING_COPY.defaultModel }],
    session,
    computer,
  )
  const unusable = unusableServices(catalog, harness, computer, session)
  // The panel holds choices; where a service's requests go is on its source (hover, or tap on a phone). Only a state
  // that needs acting on is a line.
  const failure = session?.route ? routeService(catalog, session.route, computer).unusable?.note : undefined
  const bypassed = session?.route?.bypassed && !failure
  const value = picked ? serviceValue(picked) : (modelOption?.currentValue ?? OWN_MODEL)

  // Thinking: the levels of the model in use, or of another as far as the Host knows them.
  const own = thinking.option
  const thinkingFeedback = feedbackFor(feedback, [own?.id])
  const levelsOf = (option: SessionConfigOption | undefined, current: boolean): BoardLevels<string> => {
    if (!option)
      return {
        value: MODEL_DEFAULT_LEVEL,
        options: current && thinking.defaultHint ? [{ ...defaultOnly()[0]!, hint: thinking.defaultHint }] : defaultOnly(),
      }
    return {
      value: option.currentValue,
      options: agentConfigValues(option).map(item => ({
        value: item.value,
        label: escapeHiddenCharacters(item.name),
        ...(current && blockedReason ? { disabledReason: blockedReason } : {}),
      })),
    }
  }
  const levels = (shown: string | undefined): BoardLevels<string> => {
    const current = shown === undefined || shown === value
    if (current) {
      const notice = (feedback && thinkingFeedback) || thinking.footer
      return {
        ...levelsOf(own, true),
        pending: reading || (busy !== null && (busy === own?.id || writing)),
        note:
          own?.source === 'launch' || thinking.note || notice ? (
            <>
              {noteOf(own?.source === 'launch' ? MODE_COPY.launchSetting : thinking.note)}
              {feedback && thinkingFeedback && <ConfigFeedback feedback={feedback} onRefresh={onRefresh} />}
              {thinking.footer}
            </>
          ) : undefined,
      }
    }
    return { ...levelsOf(thinking.of?.(shown), false), pending: busy !== null }
  }

  const pickModel = (next: string) => {
    // In a session, another service's model or the Harness's own while on a service moves the session there.
    if (session && parseModelChoice(next)) {
      if (modelOption && !blocked) void onConfig(modelOption.id, next)
      return
    }
    const ref = serviceRef(next)
    if (ref || picked) {
      // Leaving a service for one of the Harness's own models, its current one included.
      if (service && 'onPick' in service) service.onPick?.(ref)
      if (!ref && modelOption && next !== modelOption.currentValue) void onConfig(modelOption.id, next)
      return
    }
    if (modelOption) void choose(modelOption.id, next)
  }
  const thinkingLabel = own ? agentConfigLabel(own) : REASONING_COPY.defaultLevel

  return {
    model: {
      valueText: escapeHiddenCharacters(feedback?.kind === 'unknown' && ownFeedback ? COPY.outcomeUnknown(text) : text),
      ...(pickedProvider ? { leading: <ProviderTile provider={pickedProvider} size={14} /> } : {}),
      className: picked || reportedOr !== undefined ? 'model-picker is-id' : 'model-picker',
      pending: writing || reading,
      pendingLabel: reading ? COPY.reading : slow ? COPY.waitingFor(name) : COPY.switching,
      disabled: locked !== undefined || disabled === true,
      disabledReason: locked,
    },
    thinking: {
      valueText: escapeHiddenCharacters(
        feedback?.kind === 'unknown' && own && thinkingFeedback ? COPY.outcomeUnknown(thinkingLabel) : thinkingLabel,
      ),
      className: (own?.options.length ?? 0) <= 1 ? 'thinking-picker is-fixed' : 'thinking-picker',
      pending: reading || (own !== undefined && busy === own.id),
      pendingLabel: reading ? COPY.reading : slow ? COPY.waitingFor(name) : COPY.switching,
      disabled: locked !== undefined || disabled === true,
      disabledReason: locked,
      hint: thinking.hint ?? (own ? undefined : thinking.defaultHint),
    },
    groups,
    value,
    levels,
    onModel: pickModel,
    onLevel: (model, level) => {
      if (model === undefined || model === value) {
        if (own && level !== MODEL_DEFAULT_LEVEL) void choose(own.id, level)
        return
      }
      const other = thinking.of?.(model)
      if (other && level !== MODEL_DEFAULT_LEVEL && thinking.pickWith) thinking.pickWith(model, other.id, level)
      else pickModel(model)
    },
    // A session's switch is answered later: the panel stays on the levels, which follow once it is.
    staysOn: next => (session ? next !== value && !blocked : levels(next).options.length > 1),
    settings: others.length ? (
      <>
        {others.map(option => (
          <ConfigRow
            key={option.id}
            option={option}
            disabled={blocked}
            onChoose={next => {
              void choose(option.id, next)
            }}
          />
        ))}
      </>
    ) : undefined,
    footer: (
      <>
        <UnusableServices services={unusable} />
        {note && <p className="model-note">{note}</p>}
        {rows}
        {failure && (
          <p className="model-note" data-tone="error">
            {failure}
          </p>
        )}
        {bypassed && (
          <p className="model-note" data-tone="warn">
            {COPY.bypassedPrefix}
            {name}
            {COPY.bypassedSuffix}
          </p>
        )}
        {feedback && ownFeedback && <ConfigFeedback feedback={feedback} onRefresh={onRefresh} />}
        {manage}
      </>
    ),
    ...(panel ? { panel } : {}),
    ...(onOpenChange ? { onOpenChange } : {}),
  }
}

// ---- A new session ------------------------------------------------------------------------------------------------

export interface DraftBoardProps {
  catalog: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  access: Access
  disabled: boolean
  onManageModels?: (() => void) | undefined
  onProvidersChanged?: (() => void) | undefined
  /** A read of the Harness's lists, or the IDs typed for it, changed. */
  onRead?: (() => void | Promise<void>) | undefined
  /** The Host computer's name on a page that is not the Latch app on it; see `onComputer`. */
  computer?: string | undefined
}

/** The model and thinking of a new session. A Harness with its own models tells Latch nothing before it starts. */
function useDraftBoard({
  catalog,
  choice,
  onChoice,
  access,
  disabled,
  onManageModels,
  onProvidersChanged,
  onRead,
  computer,
}: DraftBoardProps): Board {
  const [adding, setAdding] = useState(false)
  const [typing, setTyping] = useState(false)
  const preferences = useModelPreferences()
  const harness = engineEntries(catalog, choice.workspaceId).find(entry => entry.harness.id === choice.harnessId)?.harness
  const reading = useReading(harness)
  const manage = onManageModels && (
    <MenuFooterLink icon={ModelGlyph} chevron={false} closes onClick={onManageModels}>
      {COPY.manageModels}
    </MenuFooterLink>
  )
  if (!harness)
    return {
      model: {
        valueText: undefined,
        placeholder: COPY.model,
        className: 'model-picker',
        disabled: true,
        disabledReason: COPY.chooseHarness,
      },
      thinking: {
        valueText: REASONING_COPY.defaultLevel,
        className: 'thinking-picker is-fixed',
        disabled: true,
        disabledReason: COPY.levelsNeedHarness,
      },
      groups: [],
      value: undefined,
      levels: () => ({ value: MODEL_DEFAULT_LEVEL, options: defaultOnly() }),
      onModel: () => {},
      onLevel: () => {},
    }
  if (harness.capabilities.models.owner !== 'latch') {
    const name = harnessName(harness)
    const known = draftConfig(harness, choice.config)
    const modelOption = known?.config.find(option => option.category === 'model')
    const service = servicePick(catalog, harness, choice.config)
    // A model of its own replaces a service pick; thinking and the rest are the Harness's own, kept either way.
    const pick = (configId: string, value: string) => {
      const base = configId === modelOption?.id ? withServicePick(choice.config, undefined) : choice.config
      onChoice({ config: { ...base, [configId]: value } })
    }
    // Leaving a service for the Harness's own default is a choice of its own: remembered, and before a project's 默认模型.
    const pickService = (model: ModelRef | undefined) => {
      onChoice({ config: model ? withServicePick(choice.config, model, modelOption?.id)! : withOwnDefault(choice.config, modelOption?.id) })
    }
    // The picks a choice of `value` makes, as the model menu makes them.
    const picksFor = (value: string): Record<string, string> => {
      const ref = serviceRef(value)
      if (ref) return withServicePick(choice.config, ref, modelOption?.id)!
      if (service) {
        const own = withOwnDefault(choice.config, modelOption?.id)
        return modelOption && value !== modelOption.currentValue ? { ...own, [modelOption.id]: value } : own
      }
      return modelOption ? { ...withServicePick(choice.config, undefined), [modelOption.id]: value } : (choice.config ?? {})
    }
    const option = known?.config.find(item => item.category === 'thought_level')
    const pickedModel = modelOption?.currentValue
    const unknown = !service && known?.thinkingUnknown === true && pickedModel !== undefined
    // What a model nothing is known of offers is read in an empty session: by itself where that loads none of the
    // person's own code, on request otherwise.
    const readable = unknown && readsModel(harness, access)
    const bySelf = readable && harness.catalogueRead?.when === 'select'
    const thinkingNote = harness.capabilities.models.thinkingInModel && !service ? COPY.useModelList : undefined
    const thinkingDefault =
      thinkingNote !== undefined || service || !known || known.thinkingUnknown
        ? undefined
        : unreportedThinkingNote(name, true, known.config, harness.capabilities.models.thinkingPerModel === true)
    const opened = (open: boolean) => {
      if (!open) setTyping(false)
      // Opening the panel of a Harness nothing is known of is asking what it offers.
      if (open && readsOnSelect(harness, access)) readOnSelect(harness, onRead)
    }
    const board = harnessBoard({
      catalog,
      harness,
      // The model's other settings are offered for the Harness's own models; on a service's model only the model is chosen here.
      config: service ? (known?.config.filter(item => item.category === 'model') ?? []) : (known?.config ?? []),
      state: { busy: null },
      slow: false,
      onConfig: pick,
      manage,
      disabled,
      note: service
        ? null
        : known
          ? (unreportedModelNote(name, true, known.config) ?? null)
          : harness.catalogueRead || harness.offer
            ? null
            : unreportedModelNote(name, false, []),
      rows: (
        <CatalogueRows
          harness={harness}
          access={access}
          hasModels={modelOption !== undefined}
          ownModels={!service}
          onRead={onRead}
          onTypeModel={() => {
            setTyping(true)
          }}
        />
      ),
      panel:
        typing && modelOption ? (
          <TypedModelsPanel
            harness={harness}
            onBack={() => {
              setTyping(false)
            }}
            onChoose={model => {
              pick(modelOption.id, model)
              setTyping(false)
            }}
            onSaved={onRead}
          />
        ) : undefined,
      reading,
      onOpenChange: opened,
      service: { picked: service, onPick: pickService },
      computer,
      defaultModel: defaultModelOf(harness),
      thinking: {
        option: service && !option ? undefined : option,
        note: thinkingNote,
        defaultHint: thinkingDefault,
        footer:
          readable && !bySelf && !reading ? (
            <MenuFooterLink chevron={false} closes onClick={() => void readHarnessCatalogue(harness, false, pickedModel).catch(() => {})}>
              {COPY.readLevels}
            </MenuFooterLink>
          ) : undefined,
        hint: service && !option && harness.capabilities.models.serviceThinking ? REASONING_COPY.serviceDefault : undefined,
        of: value => draftConfig(harness, picksFor(value))?.config.find(item => item.category === 'thought_level'),
        pickWith: (value, configId, level) => {
          onChoice({ config: { ...picksFor(value), [configId]: level } })
        },
      },
    })
    return { ...board, ...(bySelf ? { effects: <ReadPickedModel harness={harness} model={pickedModel} /> } : {}) }
  }
  const noService = !choice.model
  const groups = plain(modelGroups(catalog, preferences, choice.model, access))
  const provider = findProvider(catalog, choice.model?.providerId)
  const level = builtinLevels(catalog, choice.model, undefined)
  return {
    model: {
      valueText: choice.model?.model,
      placeholder: COPY.chooseModel,
      ...(provider ? { leading: <ProviderTile provider={provider} size={14} /> } : {}),
      className: choice.model ? 'model-picker is-id' : 'model-picker',
      disabled,
    },
    thinking: {
      valueText: choice.model?.effort ? thinkingWord(choice.model.effort) : REASONING_COPY.defaultLevel,
      className: level.options.length <= 1 ? 'thinking-picker is-fixed' : 'thinking-picker',
      disabled,
    },
    groups,
    value: choice.model ? modelKey(choice.model) : undefined,
    levels: key => builtinLevels(catalog, choice.model, key),
    onModel: key => {
      rememberModel(key)
      const [providerId = '', model = ''] = key.split('\u0000')
      onChoice({ model: switchModel(catalog, choice.model, { providerId, model }) })
    },
    onLevel: (key, chosen) => {
      const model = withLevel(key, choice.model, chosen)
      if (!model) return
      if (key) rememberModel(key)
      onChoice({ model })
    },
    footer: (
      <>
        <UnusableServices services={unusableServices(catalog, harness, computer)} />
        {access.admin ? (
          <MenuFooterLink
            icon={PlusGlyph}
            chevron={false}
            onClick={() => {
              setAdding(true)
            }}>
            {COPY.addService}
          </MenuFooterLink>
        ) : (
          noService && <MenuFooterNote>{SETUP_COPY.addProviderElsewhere()}</MenuFooterNote>
        )}
        {manage}
      </>
    ),
    ...(adding
      ? {
          panel: (
            <ModelAddPanel
              access={access}
              onCancel={() => {
                setAdding(false)
              }}
              onManage={onManageModels}
              onSaved={model => {
                rememberModel(modelKey(model))
                onChoice({ model })
                onProvidersChanged?.()
              }}
            />
          ),
        }
      : {}),
    onOpenChange: open => {
      if (!open) setAdding(false)
    },
  }
}

export function DraftModelControl(props: DraftBoardProps) {
  return <BoardChip board={useDraftBoard(props)} kind="model" />
}

export function DraftThinkingControl(props: DraftBoardProps) {
  return <BoardChip board={useDraftBoard(props)} kind="thinking" />
}

// ---- A session ----------------------------------------------------------------------------------------------------

export type SessionBoardProps = AgentConfigState & {
  computer?: string | undefined
  /** This device may read the session but not change it: why, as the chips' tooltip. */
  locked?: string | undefined
  /** The service the session's requests go to through Latch, fixed when it started. */
  route?: TaskSummary['modelRoute']
  catalog: HostCatalog
  harness: HarnessInfo | undefined
  model: ModelRef | undefined
  current: ModelRef | undefined
  /** The model name the session last ran on, for when the agent lists no options. */
  reported?: string | undefined
  onModel: (model: ModelRef | undefined) => void
  config: readonly SessionConfigOption[]
  onRefresh?: (() => void | Promise<void>) | undefined
  onConfig: (configId: string, value: string) => void | Promise<void>
  onManageModels?: (() => void) | undefined
}

/**
 * The same panel in a session. The built-in Harness lists your services and a switch goes with the next message; a
 * Harness with its own models lists what it reported, and a change is written to it at once.
 */
function useSessionBoard({
  catalog,
  harness,
  model,
  current,
  reported,
  onModel,
  config,
  busy,
  feedback,
  onRefresh,
  onConfig,
  onManageModels,
  locked,
  route,
  computer,
}: SessionBoardProps): Board {
  const preferences = useModelPreferences()
  const writes = config.filter(
    option => option.category === 'model' || option.category === 'model_config' || option.category === 'thought_level',
  )
  const slow = useSlowWrite(busy !== null && writes.some(option => option.id === busy))
  const manage = onManageModels && (
    <MenuFooterLink icon={ModelGlyph} chevron={false} closes onClick={onManageModels}>
      {COPY.manageModels}
    </MenuFooterLink>
  )
  if (harness?.capabilities.models.owner === 'latch' && catalog.providers.length > 0) {
    const provider = findProvider(catalog, model?.providerId)
    const word = model?.effort ? thinkingWord(model.effort) : REASONING_COPY.defaultLevel
    const switching = current !== undefined && model !== undefined && model.effort !== current.effort
    const level = builtinLevels(catalog, model, undefined)
    return {
      model: {
        valueText: !model ? REASONING_COPY.defaultModel : sameModelId(model, current) ? model.model : COPY.nextMessage(model.model),
        ...(provider ? { leading: <ProviderTile provider={provider} size={14} /> } : {}),
        className: model ? 'model-picker is-id' : 'model-picker',
        disabled: locked !== undefined,
        disabledReason: locked,
      },
      thinking: {
        valueText: switching ? COPY.nextMessage(word) : word,
        className: level.options.length <= 1 ? 'thinking-picker is-fixed' : 'thinking-picker',
        disabled: locked !== undefined,
        disabledReason: locked,
      },
      groups: plain(modelGroups(catalog, preferences, model)),
      value: model ? modelKey(model) : undefined,
      levels: key => builtinLevels(catalog, model, key),
      onModel: key => {
        rememberModel(key)
        const [providerId = '', name = ''] = key.split('\u0000')
        onModel(switchModel(catalog, model, { providerId, model: name }))
      },
      onLevel: (key, chosen) => {
        const next = withLevel(key, model, chosen)
        if (!next) return
        if (key) rememberModel(key)
        onModel(next)
      },
      footer: (
        <>
          <UnusableServices services={unusableServices(catalog, harness, computer)} />
          {model && !sameModel(model, current) && (
            <MenuFooterLink
              chevron={false}
              closes
              onClick={() => {
                onModel(undefined)
              }}>
              {resetModelLabel(current)}
            </MenuFooterLink>
          )}
          {manage}
        </>
      ),
    }
  }
  const option = config.find(item => item.category === 'thought_level')
  // Only where 默认 sends no level: elsewhere the Harness's own default applies, as the note says.
  const routed = route !== undefined && !route.bypassed && harness?.capabilities.models.serviceThinking === true
  const name = harness ? harnessName(harness) : 'Harness'
  return harnessBoard({
    catalog,
    harness,
    config,
    reported,
    state: { busy, ...(feedback ? { feedback } : {}) },
    slow,
    onRefresh,
    onConfig,
    manage,
    locked,
    service: { session: true, route },
    computer,
    thinking: {
      option,
      note: !routed && harness?.capabilities.models.thinkingInModel ? COPY.useModelList : undefined,
      defaultHint:
        routed || harness?.capabilities.models.thinkingInModel
          ? undefined
          : unreportedThinkingNote(name, true, config, harness?.capabilities.models.thinkingPerModel === true),
      hint: routed && !option ? REASONING_COPY.serviceDefault : undefined,
    },
  })
}

export function SessionModelControl(props: SessionBoardProps) {
  return <BoardChip board={useSessionBoard(props)} kind="model" />
}

export function SessionThinkingControl(props: SessionBoardProps) {
  return <BoardChip board={useSessionBoard(props)} kind="thinking" />
}
