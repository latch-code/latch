import { useEffect, useRef, useState } from 'react'

import type { AgentAvatar as AvatarValue, CustomAgent, CustomAgentSummary, HarnessInfo, HostCatalog, ModelRef } from '@latch/protocol'
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
  FileGlyph,
  HistoryGlyph,
  MessageGlyph,
  PinGlyph,
  PluginsGlyph,
  TerminalGlyph,
  WarningGlyph,
  ShieldAlertGlyph,
  ChevronRightGlyph,
  type IconComponent,
} from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ModelPicker, ProjectPicker } from '../components/Pickers.tsx'
import { harnessName } from '../composerChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import type { AgentCreationToken } from '../core/agentCreation.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import { WriteNotice } from './AgentForm.tsx'
import { DraftAvatarPicker } from './AvatarPicker.tsx'
import { ABILITY_WORDS, firstFace, helperCandidates, helperMode, isolationBrief, type HelperCandidate } from './helpers.ts'
import { usesHostModels } from './model.ts'
import { BeforeActing } from './parts.tsx'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'
import type { HelperAbility } from '@latch/protocol'

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
    <ul className="helper-abilities" aria-label="能做的事">
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
                不先问你
              </StatusWord>
            )}
          </span>
          {candidate.card && <span className="helper-card-line">{candidate.card.line}</span>}
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
        还有 {waiting.length} 位没准备好
      </FoldHeader>
      <Collapse open={open}>
        <ul className="helper-cards" aria-label="没准备好">
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
            设置 › Harness
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
  model?: ModelRef
  defaultProjectId?: string
}

/** The request 创建 sends: the Harness, fixed from now on, and what the person wrote; nothing the Harness cannot use. */
export function helperRequest(harness: Pick<HarnessInfo, 'id' | 'modes' | 'capabilities'>, draft: HelperDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions,
    harnessId: harness.id,
    mode: helperMode(harness),
    skills: [] as string[],
    avatar: draft.avatar,
    ...(draft.model && usesHostModels(harness) ? { model: draft.model } : {}),
    ...(draft.defaultProjectId ? { defaultProjectId: draft.defaultProjectId } : {}),
  }
}

/**
 * Creating a helper, in two steps on one page. First 「你想让谁成为你的帮手？」: a card for each ready Harness that can
 * take an Agent, Latch 内置 first, and below the ones not ready. Then who it is: the face, a name, its duty,
 * 多说几句 for the instructions, and 更多 for the model, 做事前 and 在哪做. Nothing exists until
 * 创建, which writes with a requestId; its Harness is fixed from then on.
 */
export function HelperCreate({
  catalog,
  access,
  agents,
  writes,
  disabled,
  onCreated,
  onCancel,
  onSettings,
  onManageProviders,
}: {
  catalog: HostCatalog
  access: DeviceAccess
  /** The Agents there are, for a hue none of them wears. */
  agents: readonly CustomAgentSummary[]
  writes: AgentWrites
  disabled: boolean
  onCreated: (agent: CustomAgent) => void
  onCancel: () => void
  /** Opens 设置 › Harness, on a device that may change it. */
  onSettings?: () => void
  onManageProviders?: () => void
}) {
  const { ready, waiting } = helperCandidates(catalog)
  const [draft, setDraft] = useState<HelperDraft | null>(null)
  const [choosing, setChoosing] = useState(true)
  const [more, setMore] = useState(false)
  const [words, setWords] = useState(false)
  const [abandon, setAbandon] = useState<AgentCreationToken>()
  const state = writeFor(writes.state, 'agent:new')
  const hadCreation = useRef(false)
  if (state) hadCreation.current = true
  useEffect(() => {
    if (hadCreation.current && !writes.held && !writes.saving && state === null) {
      setDraft(null)
      setChoosing(true)
      hadCreation.current = false
    }
  }, [writes.held, writes.saving, state])
  const locked = disabled || writes.saving || writes.held
  const chosen = draft ? ready.find(item => item.harness.id === draft.harnessId) : undefined
  const update = (patch: Partial<HelperDraft>) => {
    setDraft(previous => (previous ? { ...previous, ...patch } : previous))
  }
  const choose = (candidate: HelperCandidate) => {
    setDraft(previous => ({
      name: previous?.name ?? '',
      description: previous?.description ?? '',
      instructions: previous?.instructions ?? '',
      harnessId: candidate.harness.id,
      avatar: previous?.avatar ?? firstFace(candidate.card, agents),
      ...(previous?.defaultProjectId ? { defaultProjectId: previous.defaultProjectId } : {}),
      ...(previous?.harnessId === candidate.harness.id && previous.model ? { model: previous.model } : {}),
    }))
    setChoosing(false)
  }
  if (writes.creationAvailable === false) return <InlineNotice>这台设备已不能继续创建 Agent。</InlineNotice>
  if ((writes.held || writes.saving) && state) {
    return (
      <div className="helper-create agent-form" aria-label="新建 Agent" role="form">
        <h1 className="settings-title">确认创建结果</h1>
        {writes.saving && <InlineNotice>正在确认创建结果…</InlineNotice>}
        <WriteNotice state={state} onRetry={() => void writes.retry<CustomAgent>().then(saved => saved && onCreated(saved))} />
        <div className="agent-form-actions">
          <span className="agent-form-spacer" />
          <Button disabled>取消</Button>
          {writes.held && writes.abandon && 'creationToken' in state && state.creationToken && (
            <Button onClick={() => setAbandon(state.creationToken)}>放弃这次创建的等待</Button>
          )}
        </div>
        {abandon && 'creationToken' in state && state.creationToken?.record === abandon.record && (
          <ConfirmDialog
            title="放弃等待创建结果？"
            message="Mac 可能已经创建了这个 Agent。这里只放下此设备保存的待确认请求，不会撤销创建；再次创建会是另一个请求。"
            confirmLabel="放弃等待"
            onClose={() => setAbandon(undefined)}
            onConfirm={async () => {
              if (await writes.abandon?.(abandon)) {
                setDraft(null)
                setChoosing(true)
              }
            }}
          />
        )}
      </div>
    )
  }
  if (choosing || !draft || !chosen) {
    return (
      <div className="helper-create" aria-label="新建 Agent" role="form">
        <h1 className="helper-create-question">你想让谁成为你的帮手？</h1>
        {ready.length ? (
          <ul className="helper-cards" aria-label="候选">
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
          <p className="agent-form-empty">还没有能运行 Agent 的 Harness</p>
        )}
        <Waiting waiting={waiting} {...(onSettings ? { onSettings } : {})} />
        <div className="agent-form-actions">
          <span className="agent-form-spacer" />
          <Button onClick={onCancel}>取消</Button>
        </div>
      </div>
    )
  }
  const harness = chosen.harness
  const problem = draft.name.trim() ? undefined : '先给它起个名字'
  // Said where the person decides: Latch does not isolate an external Harness, and one that never asks says that too.
  const isolation = isolationBrief(harness)
  const create = async () => {
    if (problem || locked) return
    const saved = await writes.run<CustomAgent>('agent:new', 'custom-agents', 'POST', helperRequest(harness, draft))
    if (saved) onCreated(saved)
  }
  return (
    <form
      className="helper-create agent-form"
      aria-label="新建 Agent"
      onSubmit={event => {
        event.preventDefault()
        void create()
      }}>
      <div className="helper-chosen">
        <HarnessTile harness={harness} size={16} />
        <span>
          选了 <strong>{harnessName(harness)}</strong>
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={locked}
          onClick={() => {
            setChoosing(true)
          }}>
          换
        </Button>
        {/* That Latch does not isolate it stays where the person decides, behind ⓘ; 不先问你 is said in words, amber. */}
        {isolation && (
          <Hint
            className={chosen.unasked ? 'helper-isolation agent-permission-note is-warn' : 'helper-isolation'}
            label={chosen.unasked ? '不先问你' : ''}
            lead={
              chosen.unasked ? (
                <WarningGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
              ) : (
                <ShieldAlertGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
              )
            }
            moreLabel="不隔离：说明">
            {isolation.label}。{isolation.detail}
          </Hint>
        )}
      </div>
      <div className="helper-who">
        <DraftAvatarPicker
          avatar={draft.avatar}
          name={draft.name.trim()}
          onPick={avatar => {
            update({ avatar })
          }}
        />
        <TextField
          label="名字"
          value={draft.name}
          maxLength={80}
          placeholder="给它起个名字"
          required
          disabled={locked}
          onChange={event => {
            update({ name: event.target.value })
          }}
        />
      </div>
      <TextField
        label="职责"
        value={draft.description}
        maxLength={200}
        placeholder="一句话，例如：查资料，写成一页摘要"
        disabled={locked}
        onChange={event => {
          update({ description: event.target.value.replaceAll('\n', ' ') })
        }}
      />
      <div className="helper-fold">
        <FoldHeader open={words} onOpenChange={setWords}>
          多说几句
        </FoldHeader>
        <Collapse open={words}>
          <TextAreaField
            label="指令"
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
      <div className="helper-fold">
        <FoldHeader open={more} onOpenChange={setMore}>
          更多
        </FoldHeader>
        <Collapse open={more}>
          <dl className="agent-facts helper-more">
            <dt>用的模型</dt>
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
                      用默认
                    </Button>
                  )}
                </>
              ) : (
                <span>它自己的默认</span>
              )}
            </dd>
            <dt>做事前</dt>
            <dd>
              <BeforeActing harness={harness} mode={helperMode(harness)} />
            </dd>
            <dt>在哪做</dt>
            <dd>
              {!draft.defaultProjectId && (
                <Hint label="它自己的文件夹" moreLabel="在哪做：说明">
                  不是隔离：它仍能读写这台 Mac 上别处的文件。选了项目，新话题就在项目里做。
                </Hint>
              )}
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
          取消
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={locked || problem !== undefined}
          loading={state !== null && 'phase' in state && state.phase === 'saving'}
          title={problem}>
          创建
        </Button>
      </div>
    </form>
  )
}
