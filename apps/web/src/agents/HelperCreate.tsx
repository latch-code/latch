import { useEffect, useRef, useState } from 'react'

import type {
  AgentAvatar as AvatarValue,
  CustomAgent,
  CustomAgentSummary,
  CustomAgentList,
  HarnessInfo,
  HostCatalog,
  ModelRef,
} from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  Collapse,
  FoldHeader,
  Hint,
  InlineNotice,
  ICON_STROKE,
  StatusWord,
  TextAreaField,
  TextField,
  Tooltip,
  FileGlyph,
  HistoryGlyph,
  MessageGlyph,
  PinGlyph,
  PluginsGlyph,
  TerminalGlyph,
  WarningGlyph,
  ChevronRightGlyph,
  type IconComponent,
} from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ModelPicker, ProjectPicker } from '../components/Pickers.tsx'
import { harnessName } from '../composerChoice.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import type { AgentCreationToken } from '../core/agentCreation.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import { AgentCapabilities, WriteNotice } from './AgentForm.tsx'
import { DraftAvatarPicker } from './AvatarPicker.tsx'
import { ABILITY_WORDS, firstFace, helperCandidates, helperCardLine, helperMode, isolationBrief, type HelperCandidate } from './helpers.ts'
import { usesHostModels } from './model.ts'
import { BeforeActing } from './parts.tsx'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'
import type { HelperAbility } from '@latch/protocol'

const COPY = defineCopy(
  {
    abilities: '能做的事',
    unasked: '不先问你',
    waiting: (count: number) => `还有 ${formatNumber(count)} 位没准备好`,
    notReady: '没准备好',
    harnessSettings: '设置 › Harness',
    deviceBlocked: '这台设备已不能继续创建 Agent。',
    check: '确认创建结果',
    checking: '正在确认创建结果…',
    cancel: '取消',
    stopWaiting: '放弃这次创建的等待',
    abandonTitle: '放弃等待创建结果？',
    abandonDetail: 'Mac 可能已经创建了这个 Agent。这里只放下此设备保存的待确认请求，不会撤销创建；再次创建会是另一个请求。',
    abandon: '放弃等待',
    choose: '你想让谁成为你的帮手？',
    candidates: '候选',
    empty: '还没有能运行 Agent 的 Harness',
    nameRequired: '先给它起个名字',
    chosen: '选了',
    change: '换',
    boundary: (label: string, detail?: string) => (detail ? `${label}。${detail}` : label),
    name: '名字',
    namePrompt: '给它起个名字',
    duty: '职责',
    dutyPrompt: '一句话，例如：查资料，写成一页摘要',
    instructionsMore: '多说几句',
    instructions: '指令',
    cloudEntry: '添加工作电脑上的 Agent',
    entryIdentity: '名字和职责显示在这台电脑的名单里。新委托使用工作电脑上所选 Agent 的配置。',
    localStandby: '选回这台 Mac 后，新委托会使用 Latch 内置和这里的模型设置。',
    capabilities: '技能与工具',
    more: '更多',
    model: '用的模型',
    useDefault: '用默认',
    harnessDefault: '它自己的默认',
    beforeActing: '做事前',
    workspace: '在哪做',
    ownFolder: '它自己的文件夹',
    ownFolderDetail: '不是隔离：它仍能读写这台 Mac 上别处的文件。选了项目，首次聊天就在项目里做。',
    create: '创建',
  },
  {
    abilities: 'Capabilities',
    unasked: 'Acts without asking',
    waiting: (count: number) => plural(count, { one: '{n} Harness isn’t ready', other: '{n} Harnesses aren’t ready' }),
    notReady: 'Not ready',
    harnessSettings: 'Settings › Harness',
    deviceBlocked: 'This device can no longer create an Agent.',
    check: 'Check creation',
    checking: 'Checking whether the Agent was created…',
    cancel: 'Cancel',
    stopWaiting: 'Stop waiting for this creation request',
    abandonTitle: 'Stop waiting for the creation result?',
    abandonDetail:
      'Your Mac may already have created the Agent. This clears the pending request on this device. It does not undo creation. Creating again sends a new request.',
    abandon: 'Stop waiting',
    choose: 'Which Harness should run your Agent?',
    candidates: 'Available Harnesses',
    empty: 'No Harness can run an Agent yet',
    nameRequired: 'Give your Agent a name first',
    chosen: 'Selected',
    change: 'Change',
    boundary: (label: string, detail?: string) => (detail ? `${label}. ${detail}` : label),
    name: 'Name',
    namePrompt: 'Give your Agent a name',
    duty: 'Role',
    dutyPrompt: 'One sentence, such as “Research a topic and write a one-page summary”',
    instructionsMore: 'Add more detail',
    instructions: 'Instructions',
    cloudEntry: 'Add an assistant from the work computer',
    entryIdentity: 'The name and role appear in this computer’s list. New requests use the target assistant’s settings.',
    localStandby: 'Switching back uses the built-in Harness and this computer’s model settings.',
    capabilities: 'Skills and tools',
    more: 'More',
    model: 'Model',
    useDefault: 'Use default',
    harnessDefault: 'Harness default',
    beforeActing: 'Before acting',
    workspace: 'Workspace',
    ownFolder: 'Its own folder',
    ownFolderDetail: 'The Agent can still read and write files elsewhere on this Mac. Choose a project to start its first chat there.',
    create: 'Create',
  },
)

const ABILITY_ICONS: Record<HelperAbility, IconComponent> = {
  files: FileGlyph,
  commands: TerminalGlyph,
  mcp: PluginsGlyph,
  ask: MessageGlyph,
  memory: PinGlyph,
  schedule: HistoryGlyph,
}

/** What it really does, as short tags: an icon and two or three words, only for what it can do. */
function Abilities({ candidate }: { candidate: HelperCandidate }) {
  if (!candidate.abilities.length) return null
  return (
    <ul className="helper-abilities" aria-label={COPY.abilities}>
      {candidate.abilities.map(ability => {
        const Glyph = ABILITY_ICONS[ability]
        return (
          <li key={ability} className="helper-ability">
            <Glyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            {ABILITY_WORDS[ability]}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One candidate: the face it would start with, its name and real mark (with an amber 不先问你 beside the name where it acts
 * without asking first), its one line and what it does.
 */
function CandidateCard({
  candidate,
  face,
  disabled,
  onChoose,
}: {
  candidate: HelperCandidate
  face: AvatarValue
  disabled: boolean
  onChoose: () => void
}) {
  const name = harnessName(candidate.harness)
  const line = helperCardLine(candidate)
  return (
    <li>
      <Button variant="ghost" className="helper-card" disabled={disabled} aria-label={name} onClick={onChoose}>
        <AgentAvatar avatar={face} size={40} />
        <span className="helper-card-text">
          <span className="helper-card-name">
            <span>{name}</span>
            <HarnessTile harness={candidate.harness} size={14} />
            {candidate.unasked && (
              <StatusWord tone="warn" className="helper-unasked">
                {COPY.unasked}
              </StatusWord>
            )}
          </span>
          {line && <span className="helper-card-line">{line}</span>}
          <Abilities candidate={candidate} />
        </span>
        <ChevronRightGlyph className="helper-card-go" size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
      </Button>
    </li>
  )
}

/** The Harnesses that cannot be anyone's helper yet, greyed, each with its reason; never a card one could pick. */
function Waiting({ waiting, onSettings }: { waiting: ReturnType<typeof helperCandidates>['waiting']; onSettings?: () => void }) {
  const [open, setOpen] = useState(false)
  if (!waiting.length) return null
  return (
    <div className="helper-waiting">
      <FoldHeader open={open} onOpenChange={setOpen}>
        {COPY.waiting(waiting.length)}
      </FoldHeader>
      <Collapse open={open}>
        <ul className="helper-cards" aria-label={COPY.notReady}>
          {waiting.map(item => (
            <li key={item.harness.id} className="helper-card" data-waiting="">
              <HarnessTile harness={item.harness} size={20} />
              <span className="helper-card-text">
                <span className="helper-card-name">{harnessName(item.harness)}</span>
                {item.detail ? (
                  <Hint label={item.words} lead={<WarningGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}>
                    {item.detail}
                  </Hint>
                ) : (
                  <span className="helper-card-line">{item.words}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        {onSettings && (
          <Button size="sm" variant="ghost" onClick={onSettings}>
            {COPY.harnessSettings}
          </Button>
        )}
      </Collapse>
    </div>
  )
}

/** What the new helper will be: everything the form holds, sent once at 创建. */
interface HelperDraft {
  harnessId: string
  avatar: AvatarValue
  name: string
  description: string
  instructions: string
  skills?: string[]
  tools?: string[]
  model?: ModelRef
  defaultProjectId?: string
}

/** The request 创建 sends: the Harness, fixed from now on, and what the person wrote; nothing the Harness cannot use. */
export function helperRequest(
  harness: Pick<HarnessInfo, 'id' | 'modes' | 'capabilities' | 'skills' | 'agentContext'>,
  draft: HelperDraft,
  workComputer?: CustomAgentSummary['workComputer'],
) {
  return {
    ...(workComputer ? { workComputer } : {}),
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions,
    harnessId: harness.id,
    mode: helperMode(harness),
    skills: harness.skills ? (draft.skills ?? []) : [],
    ...(harness.agentContext === 'private' && draft.tools !== undefined ? { tools: draft.tools } : {}),
    avatar: draft.avatar,
    ...(draft.model && usesHostModels(harness) ? { model: draft.model } : {}),
    ...(draft.defaultProjectId ? { defaultProjectId: draft.defaultProjectId } : {}),
  }
}

/**
 * The person can describe the helper before choosing its engine. The same identity draft belongs to both
 * views. Creating requires an explicit engine choice and is retried with the original request ID.
 */
export function HelperCreate({
  catalog,
  access,
  agents,
  plugins,
  writes,
  disabled,
  onCreated,
  onCancel,
  onSettings,
  onManageProviders,
  workComputer,
}: {
  catalog: HostCatalog
  access: DeviceAccess
  /** The Agents there are, for a hue none of them wears. */
  agents: readonly CustomAgentSummary[]
  plugins?: CustomAgentList['plugins'] | undefined
  writes: AgentWrites
  disabled: boolean
  onCreated: (agent: CustomAgent) => void
  onCancel: () => void
  /** Opens 设置 › Harness, on a device that may change it. */
  onSettings?: () => void
  onManageProviders?: () => void
  workComputer?: CustomAgentSummary['workComputer']
}) {
  const { ready, waiting } = helperCandidates(catalog)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState<Omit<HelperDraft, 'name' | 'description'> | null>(null)
  const [choosing, setChoosing] = useState(true)
  const [more, setMore] = useState(false)
  const [capabilities, setCapabilities] = useState(false)
  const [words, setWords] = useState(false)
  const [abandon, setAbandon] = useState<AgentCreationToken>()
  const state = writeFor(writes.state, 'agent:new')
  const hadCreation = useRef(false)
  if (state) hadCreation.current = true
  useEffect(() => {
    if (hadCreation.current && !writes.held && !writes.saving && state === null) {
      setDraft(null)
      setName('')
      setDescription('')
      setChoosing(true)
      hadCreation.current = false
    }
  }, [writes.held, writes.saving, state])
  const locked = disabled || writes.saving || writes.held
  const chosen = draft ? ready.find(item => item.harness.id === draft.harnessId) : undefined
  const update = (patch: Partial<Omit<HelperDraft, 'name' | 'description'>>) => {
    setDraft(previous => (previous ? { ...previous, ...patch } : previous))
  }
  const choose = (candidate: HelperCandidate) => {
    setDraft(previous => ({
      ...(previous?.skills ? { skills: previous.skills } : {}),
      ...(previous?.tools ? { tools: previous.tools } : {}),
      instructions: previous?.instructions ?? '',
      harnessId: candidate.harness.id,
      avatar: previous?.avatar ?? firstFace(candidate.card, agents),
      ...(previous?.defaultProjectId ? { defaultProjectId: previous.defaultProjectId } : {}),
      ...(previous?.harnessId === candidate.harness.id && previous.model ? { model: previous.model } : {}),
    }))
    setChoosing(false)
  }
  if (writes.creationAvailable === false) return <InlineNotice>{COPY.deviceBlocked}</InlineNotice>
  if ((writes.held || writes.saving) && state) {
    return (
      <div className="helper-create agent-form" aria-label={AGENT_SPACE_COPY.newAgent} role="form">
        <h1 className="settings-title">{COPY.check}</h1>
        {writes.saving && <InlineNotice>{COPY.checking}</InlineNotice>}
        <WriteNotice state={state} onRetry={() => void writes.retry<CustomAgent>().then(saved => saved && onCreated(saved))} />
        <div className="agent-form-actions">
          <span className="agent-form-spacer" />
          <Button disabled>{COPY.cancel}</Button>
          {writes.held && writes.abandon && 'creationToken' in state && state.creationToken && (
            <Button onClick={() => setAbandon(state.creationToken)}>{COPY.stopWaiting}</Button>
          )}
        </div>
        {abandon && 'creationToken' in state && state.creationToken?.record === abandon.record && (
          <ConfirmDialog
            title={COPY.abandonTitle}
            message={COPY.abandonDetail}
            confirmLabel={COPY.abandon}
            onClose={() => setAbandon(undefined)}
            onConfirm={async () => {
              if (await writes.abandon?.(abandon)) {
                setDraft(null)
                setName('')
                setDescription('')
                setChoosing(true)
              }
            }}
          />
        )}
      </div>
    )
  }
  const identity = (
    <>
      <div className={draft && !choosing ? 'helper-who' : undefined}>
        {draft && !choosing && (
          <DraftAvatarPicker
            avatar={draft.avatar}
            name={name.trim()}
            onPick={avatar => {
              update({ avatar })
            }}
          />
        )}
        <TextField
          label={COPY.name}
          value={name}
          maxLength={80}
          placeholder={COPY.namePrompt}
          required
          disabled={locked}
          onChange={event => {
            setName(event.target.value)
          }}
        />
      </div>
      <TextField
        label={COPY.duty}
        value={description}
        maxLength={200}
        placeholder={COPY.dutyPrompt}
        disabled={locked}
        onChange={event => {
          setDescription(event.target.value.replaceAll('\n', ' '))
        }}
      />
    </>
  )
  if (workComputer) {
    const createEntry = async () => {
      if (locked || !name.trim()) return
      const body =
        chosen && draft
          ? helperRequest(chosen.harness, { ...draft, name, description }, workComputer)
          : {
              name: name.trim(),
              description: description.trim(),
              instructions: '',
              skills: [],
              harnessId: 'standard',
              mode: 'agent',
              workComputer,
            }
      const saved = await writes.run<CustomAgent>('agent:new', 'custom-agents', 'POST', body)
      if (saved) onCreated(saved)
    }
    return (
      <form
        className="helper-create agent-form"
        aria-label={AGENT_SPACE_COPY.newAgent}
        onSubmit={event => {
          event.preventDefault()
          void createEntry()
        }}>
        <h1 className="settings-title">{COPY.cloudEntry}</h1>
        <p className="agent-profile-quiet">{COPY.entryIdentity}</p>
        {identity}
        {!chosen && <p className="agent-profile-quiet">{COPY.localStandby}</p>}
        <WriteNotice state={state} onRetry={() => void writes.retry<CustomAgent>().then(saved => saved && onCreated(saved))} />
        <div className="agent-form-actions">
          <span className="agent-form-spacer" />
          <Button onClick={onCancel} disabled={locked}>
            {COPY.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={locked || !name.trim()}>
            {COPY.create}
          </Button>
        </div>
      </form>
    )
  }
  if (choosing || !draft || !chosen) {
    return (
      <div className="helper-create agent-form" aria-label={AGENT_SPACE_COPY.newAgent} role="form">
        <h1 className="settings-title">{AGENT_SPACE_COPY.newAgent}</h1>
        {identity}
        <h2 className="agent-profile-heading">{COPY.choose}</h2>
        {ready.length ? (
          <ul className="helper-cards" aria-label={COPY.candidates}>
            {ready.map(candidate => (
              <CandidateCard
                key={candidate.harness.id}
                candidate={candidate}
                face={firstFace(candidate.card, agents)}
                disabled={locked}
                onChoose={() => {
                  choose(candidate)
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="agent-form-empty">{COPY.empty}</p>
        )}
        <Waiting waiting={waiting} {...(onSettings ? { onSettings } : {})} />
        <div className="agent-form-actions">
          <span className="agent-form-spacer" />
          <Button onClick={onCancel}>{COPY.cancel}</Button>
        </div>
      </div>
    )
  }
  const harness = chosen.harness
  const problem = name.trim() ? undefined : COPY.nameRequired
  // Said where the person decides: Latch does not isolate an external Harness, and one that never asks says that too.
  const isolation = isolationBrief(harness)
  const create = async () => {
    if (problem || locked) return
    const saved = await writes.run<CustomAgent>(
      'agent:new',
      'custom-agents',
      'POST',
      helperRequest(harness, { ...draft, name, description }, workComputer),
    )
    if (saved) onCreated(saved)
  }
  return (
    <form
      className="helper-create agent-form"
      aria-label={AGENT_SPACE_COPY.newAgent}
      onSubmit={event => {
        event.preventDefault()
        void create()
      }}>
      <div className="helper-chosen">
        {/* That Latch does not isolate it is the choice's tooltip, where the person decides; 不先问你 is said in words, amber. */}
        <Tooltip content={isolation && !chosen.unasked ? COPY.boundary(isolation.label, isolation.detail) : undefined}>
          <span className="helper-chosen-name" tabIndex={isolation && !chosen.unasked ? 0 : undefined}>
            <HarnessTile harness={harness} size={16} />
            <span>
              {COPY.chosen} <strong>{harnessName(harness)}</strong>
            </span>
          </span>
        </Tooltip>
        <Button
          size="xs"
          variant="ghost"
          disabled={locked}
          onClick={() => {
            setChoosing(true)
          }}>
          {COPY.change}
        </Button>
        {isolation && chosen.unasked && (
          <Hint
            className="helper-isolation agent-permission-note is-warn"
            label={COPY.unasked}
            lead={<WarningGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}>
            {COPY.boundary(isolation.label, isolation.detail)}
          </Hint>
        )}
      </div>
      {identity}
      <div className="helper-fold">
        <FoldHeader open={words} onOpenChange={setWords}>
          {COPY.instructionsMore}
        </FoldHeader>
        <Collapse open={words}>
          <TextAreaField
            label={COPY.instructions}
            value={draft.instructions}
            rows={6}
            maxLength={32_000}
            disabled={locked}
            onChange={event => {
              update({ instructions: event.target.value })
            }}
          />
        </Collapse>
      </div>
      {(harness.skills || harness.agentContext === 'private') && (
        <div className="helper-fold">
          <FoldHeader open={capabilities} onOpenChange={setCapabilities}>
            {COPY.capabilities}
          </FoldHeader>
          <Collapse open={capabilities}>
            <AgentCapabilities
              catalog={catalog}
              acceptsSkills={Boolean(harness.skills)}
              builtIn={harness.agentContext === 'private'}
              plugins={plugins}
              skills={draft.skills ?? []}
              tools={draft.tools}
              disabled={locked}
              onSkills={skills => update({ skills })}
              onTools={tools => {
                const { tools: _previous, ...rest } = draft
                setDraft(tools === undefined ? rest : { ...rest, tools })
              }}
            />
          </Collapse>
        </div>
      )}
      <div className="helper-fold">
        <FoldHeader open={more} onOpenChange={setMore}>
          {COPY.more}
        </FoldHeader>
        <Collapse open={more}>
          <dl className="agent-facts helper-more">
            <dt>{COPY.model}</dt>
            <dd>
              {usesHostModels(harness) ? (
                <>
                  <ModelPicker
                    catalog={catalog}
                    value={draft.model}
                    access={access}
                    disabled={locked}
                    {...(onManageProviders ? { onManage: onManageProviders } : {})}
                    onChange={model => {
                      update({ model: { providerId: model.providerId, model: model.model } })
                    }}
                  />
                  {draft.model && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={locked}
                      onClick={() => {
                        setDraft(previous => {
                          if (!previous) return previous
                          const { model: _model, ...rest } = previous
                          return rest
                        })
                      }}>
                      {COPY.useDefault}
                    </Button>
                  )}
                </>
              ) : (
                <span>{COPY.harnessDefault}</span>
              )}
            </dd>
            <dt>{COPY.beforeActing}</dt>
            <dd>
              <BeforeActing harness={harness} mode={helperMode(harness)} />
            </dd>
            <dt>{COPY.workspace}</dt>
            <dd>
              {!draft.defaultProjectId && <Hint label={COPY.ownFolder}>{COPY.ownFolderDetail}</Hint>}
              <ProjectPicker
                catalog={catalog}
                harness={harness}
                access={access}
                value={draft.defaultProjectId ?? 'default'}
                disabled={locked}
                onChange={id => {
                  setDraft(previous => {
                    if (!previous) return previous
                    const { defaultProjectId: _project, ...rest } = previous
                    return id === 'default' ? rest : { ...rest, defaultProjectId: id }
                  })
                }}
              />
            </dd>
          </dl>
        </Collapse>
      </div>
      <WriteNotice state={state} onRetry={() => void writes.retry<CustomAgent>().then(saved => saved && onCreated(saved))} />
      <div className="agent-form-actions">
        <span className="agent-form-spacer" />
        <Button disabled={writes.saving || writes.held} onClick={onCancel}>
          {COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={locked || problem !== undefined}
          loading={state !== null && 'phase' in state && state.phase === 'saving'}
          title={problem}>
          {COPY.create}
        </Button>
      </div>
    </form>
  )
}
