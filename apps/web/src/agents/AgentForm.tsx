import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { CustomAgent, CustomAgentDetail, CustomAgentList, GeneralAgentDetail, HostCatalog } from '@latch/protocol'
import { Button, Checkbox, Hint, ICON_STROKE, InlineNotice, StatusWord, TextAreaField, TextField, ShieldGlyph, TrashGlyph } from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ProjectPicker } from '../components/Pickers.tsx'
import { harnessName } from '../composerChoice.ts'
import { AgentDeleteDialog } from './AgentDeleteDialog.tsx'
import { defineCopy } from '../core/i18n.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { draftOf, normalizedDraft, patchOf, rebaseDraft, saveWaits, type AgentDraft } from './model.ts'
import { isolationBrief } from './helpers.ts'
import { writeFor, type AgentWrites, type WriteState } from './useAgentWrites.ts'
import { AgentDefaults } from './AgentDefaults.tsx'
import { BudgetControl, useModelSpend } from '../settings/ModelSpend.tsx'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'

const COPY = defineCopy(
  {
    effect: '何时生效',
    effectDetail:
      '内置 Harness 从下一轮起读取所选模型、指令和记忆。外部 Harness 在首次聊天或清空上下文后读取指令和记忆。要修改外部 Harness 的模型或权限，请使用当前聊天中的可用选项。',
    unknown: '结果未知',
    retry: '重试同一请求',
    abandon: '放弃等待',
    conflict: '已在别处修改',
    latest: '载入最新',
    notSaved: '没有保存',
    noSkills: '没有已启用的技能',
    allSkills: '全部已启用的技能',
    pluginDisabled: '插件已停用',
    nameRequired: '先填名称',
    settings: (name: string) => `${name} 的设置`,
    name: '名称',
    namePrompt: '例如：资料整理',
    duty: '职责',
    dutyPrompt: '一句话，例如：查资料，写成一页摘要',
    instructions: '指令',
    execution: '执行方式',
    runner: '由谁运行',
    runsOn: (name: string) => `由 ${name} 运行`,
    fixedHarness: '建好后不能换 Harness，要用别的就新建一个 Agent。',
    boundary: (label: string, detail?: string) => (detail ? ` ${label}。${detail}` : ` ${label}`),
    budget: '本月预算',
    project: '默认项目',
    home: { label: '家', description: '没有选项目时，在家里做' },
    skills: '技能',
    skillsUnavailable: '这个 Harness 收不到技能',
    skillsUnavailableDetail: '技能经内置加载或技能服务送达；这个 Harness 两种都不接受，所选技能不会发送。',
    tools: '可以使用',
    restrict: '只收紧',
    restrictDetail: '只对内置 Harness 生效：它只能调用勾选的插件的工具，不会因此获得新的能力。',
    allPlugins: '全部已启用的插件',
    conflictDetail: '这项记录已更新，请刷新后再修改。',
    delete: '删除',
    cancel: '取消',
    conflictTip: '已在别处修改，载入最新后再保存',
    save: '保存',
  },
  {
    effect: 'When changes take effect',
    effectDetail:
      'The built-in Harness reads the selected model, instructions, and memory from the next turn. An external Harness reads instructions and memory when you first start a chat or clear its context. Use the options in the current chat to change an external Harness’s model or permissions.',
    unknown: 'Outcome unknown',
    retry: 'Retry the same request',
    abandon: 'Stop waiting',
    conflict: 'Changed elsewhere',
    latest: 'Load latest',
    notSaved: 'Changes weren’t saved',
    noSkills: 'No enabled skills',
    allSkills: 'All enabled skills',
    pluginDisabled: 'Plugin disabled',
    nameRequired: 'Enter a name first',
    settings: (name: string) => `Settings for ${name}`,
    name: 'Name',
    namePrompt: 'For example, Research Assistant',
    duty: 'Role',
    dutyPrompt: 'One sentence, such as “Research a topic and write a one-page summary”',
    instructions: 'Instructions',
    execution: 'Execution',
    runner: 'Harness',
    runsOn: (name: string) => `Runs on ${name}`,
    fixedHarness: 'To use a different Harness, create a new Agent.',
    boundary: (label: string, detail?: string) => (detail ? ` ${label}. ${detail}` : ` ${label}`),
    budget: 'Monthly budget',
    project: 'Default project',
    home: { label: 'Home', description: 'Work in the Agent’s home folder when no project is selected' },
    skills: 'Skills',
    skillsUnavailable: 'This Harness cannot receive skills',
    skillsUnavailableDetail:
      'Latch sends skills through built-in loading or the skill service. This Harness supports neither, so it won’t receive selected skills.',
    tools: 'Allowed tools',
    restrict: 'Limits tool access',
    restrictDetail:
      'This applies to the built-in Harness only. Its tool access is limited to the selected plugins and their existing capabilities.',
    allPlugins: 'All enabled plugins',
    conflictDetail: 'This record has changed. Load the latest version before editing it.',
    delete: 'Delete',
    cancel: 'Cancel',
    conflictTip: 'Changed elsewhere. Load the latest version before saving.',
    save: 'Save',
  },
)

/** When a change reaches the Agent's sessions: the fine print behind ⓘ. */
export function TakesEffect({ label = COPY.effect }: { label?: string }) {
  return (
    <Hint label={label} lead={false} className="agent-effect">
      {COPY.effectDetail}
    </Hint>
  )
}

/** A write's state under its form: saving, refused, changed meanwhile, or unknown with a retry of the same request. */
export function WriteNotice({
  state,
  onRetry,
  onReload,
  onAbandon,
}: {
  state: WriteState | null
  onRetry: () => void
  onReload?: () => void
  onAbandon?: () => void
}) {
  if (!state || !('kind' in state)) return null
  if (state.kind === 'unknown')
    return (
      <InlineNotice
        tone="warn"
        title={COPY.unknown}
        action={state.unreplayable ? undefined : <Button onClick={onRetry}>{COPY.retry}</Button>}
        {...(onAbandon ? { onClose: onAbandon, closeLabel: COPY.abandon } : {})}>
        <span>{state.message}</span> <span className="agent-request-id">{state.write.body.requestId}</span>
      </InlineNotice>
    )
  if (state.kind === 'conflict')
    return (
      <InlineNotice tone="warn" title={COPY.conflict} action={onReload ? <Button onClick={onReload}>{COPY.latest}</Button> : undefined}>
        {state.message}
      </InlineNotice>
    )
  return (
    <InlineNotice tone="error" title={COPY.notSaved}>
      {state.message}
    </InlineNotice>
  )
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="agent-form-section">
      <header>
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

/** 技能: the enabled skills to load. `undefined` (通用 only): all of them. */
function SkillChoice({
  catalog,
  value,
  onChange,
  allowAll,
  disabled,
}: {
  catalog: HostCatalog
  value: string[] | undefined
  onChange: (value: string[] | undefined) => void
  allowAll: boolean
  disabled: boolean
}) {
  const skills = catalog.skills ?? []
  // A chosen skill whose plugin is off now is kept, and said to be off.
  const missing = (value ?? []).filter(id => !skills.some(skill => skill.id === id))
  if (!skills.length && !missing.length) return <p className="agent-form-empty">{COPY.noSkills}</p>
  return (
    <div className="agent-checks">
      {allowAll && (
        <Checkbox
          label={COPY.allSkills}
          checked={value === undefined}
          disabled={disabled}
          onChange={event => {
            onChange(event.target.checked ? undefined : skills.map(skill => skill.id))
          }}
        />
      )}
      {skills.map(skill => (
        <Checkbox
          key={skill.id}
          label={skill.name}
          description={skill.pluginName}
          checked={value === undefined || value.includes(skill.id)}
          disabled={disabled || value === undefined}
          onChange={event => {
            const current = value ?? []
            onChange(event.target.checked ? [...current, skill.id] : current.filter(id => id !== skill.id))
          }}
        />
      ))}
      {missing.map(id => (
        <Checkbox
          key={id}
          label={id}
          description={COPY.pluginDisabled}
          checked
          disabled={disabled}
          onChange={() => {
            onChange((value ?? []).filter(item => item !== id))
          }}
        />
      ))}
    </div>
  )
}

/**
 * Create or edit one of 我的 Agent: name, a one-line description, instructions, the Harness (only those that can receive
 * an Agent), the model where the Harness runs on Latch's models, the default project, skills and 「可以使用」. Saving
 * sends what changed against the revision the form was opened on; the Host's answer decides what shows.
 */
export function AgentForm({
  catalog,
  access,
  agent,
  plugins,
  writes,
  disabled,
  onSaved,
  onDeleted,
  onCancel,
  onReload,
  onManageProviders,
  onOptionsRead,
}: {
  catalog: HostCatalog
  access: DeviceAccess
  agent: CustomAgentDetail['agent']
  plugins: CustomAgentList['plugins']
  writes: AgentWrites
  /** Offline or held by another write. */
  disabled: boolean
  onSaved: (agent: CustomAgent) => void
  /** After the deletion; `notice` when its folder stayed where it was. */
  onDeleted?: (notice?: string) => void
  onCancel?: () => void
  onReload?: () => void
  onManageProviders?: () => void
  onOptionsRead?: () => void | Promise<void>
}) {
  const base = useMemo(() => draftOf(agent), [agent])
  // The Agent's monthly budget is kept beside its definition, not in it: it saves on its own and needs no 保存 here.
  const spending = useModelSpend(catalog.features?.modelUsage === true, agent.id)
  const [draft, setDraft] = useState<AgentDraft>(base)
  const [deleting, setDeleting] = useState(false)
  // A new revision from the Host (a save, a new avatar, an edit elsewhere) keeps what the person is in the middle of
  // changing, laid over the new definition; a field changed both here and there says so.
  const revision = agent.revision
  const shown = useRef(base)
  const [conflicts, setConflicts] = useState<Array<keyof AgentDraft>>([])
  const elsewhere = conflicts.length > 0
  useEffect(() => {
    const previous = shown.current
    shown.current = base
    if (previous === base) return
    setDraft(current => {
      const rebased = rebaseDraft(previous, base, current)
      if (rebased.conflicts.length) setConflicts(known => [...new Set([...known, ...rebased.conflicts])])
      return rebased.draft
    })
  }, [revision])
  const harness = catalog.harnesses.find(item => item.id === draft.harnessId)
  // The Harness is fixed, so one that cannot run now does not hold back a new name or instructions.
  const problem = draft.name.trim() ? undefined : COPY.nameRequired
  const normalized = normalizedDraft(catalog, draft)
  const changes = patchOf(draftOf(agent), normalized)
  const changed = Object.keys(changes).length > 0
  const key = `agent:${agent.id}`
  const state = writeFor(writes.state, key)
  const locked = disabled || writes.saving || writes.held
  const update = (patch: Partial<AgentDraft>) => {
    setDraft(previous => ({ ...previous, ...patch }))
  }
  const save = async () => {
    if (problem || locked || saveWaits(conflicts)) return
    const saved = await writes.run<CustomAgent>(key, `custom-agents/${encodeURIComponent(agent.id)}`, 'PATCH', {
      ...changes,
      baseRevision: agent.revision,
    })
    if (saved) {
      setConflicts([])
      onSaved(saved)
    }
  }
  const retry = async () => {
    const saved = await writes.retry<CustomAgent>()
    if (saved) onSaved(saved)
  }
  const isolation = harness ? isolationBrief(harness) : undefined
  const toolPlugins = plugins.filter(plugin => plugin.capabilities.some(item => item.startsWith('tool:')))
  const builtIn = harness?.agentContext === 'private'
  return (
    <form
      className="agent-form"
      aria-label={COPY.settings(agent.name)}
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}>
      <TextField
        label={COPY.name}
        value={draft.name}
        maxLength={80}
        placeholder={COPY.namePrompt}
        disabled={locked}
        onChange={event => {
          update({ name: event.target.value })
        }}
      />
      <TextField
        label={COPY.duty}
        value={draft.description}
        maxLength={200}
        placeholder={COPY.dutyPrompt}
        disabled={locked}
        onChange={event => {
          update({ description: event.target.value.replaceAll('\n', ' ') })
        }}
      />
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
      <Section title={COPY.execution} aside={<TakesEffect />}>
        <dl className="agent-facts">
          <dt>{COPY.runner}</dt>
          <dd>
            {/* Fixed at creation: another Harness is another Agent. Latch does not isolate it either way. */}
            <Hint
              label={COPY.runsOn(harness ? harnessName(harness) : draft.harnessId)}
              lead={harness ? <HarnessTile harness={harness} size={14} /> : undefined}>
              {COPY.fixedHarness}
              {isolation ? COPY.boundary(isolation.label, isolation.detail) : ''}
            </Hint>
          </dd>
          <AgentDefaults
            catalog={catalog}
            draft={draft}
            access={access}
            disabled={locked}
            onDraft={setDraft}
            {...(onOptionsRead ? { onRead: onOptionsRead } : {})}
            {...(onManageProviders ? { onManage: onManageProviders } : {})}
          />
          {catalog.features?.modelUsage && (
            <>
              <dt>{COPY.budget}</dt>
              <dd>
                <BudgetControl
                  scope="agent"
                  id={agent.id}
                  spend={spending.spend}
                  admin={access.admin}
                  disabled={disabled}
                  onChanged={spending.reload}
                />
              </dd>
            </>
          )}
        </dl>
      </Section>

      <Section title={COPY.project}>
        <div className="agent-form-pickers">
          <ProjectPicker
            catalog={catalog}
            defaultLocation={COPY.home}
            harness={harness}
            access={access}
            value={draft.defaultProjectId ?? 'default'}
            disabled={locked}
            onChange={id => {
              if (id === 'default') {
                const { defaultProjectId: _project, ...rest } = draft
                setDraft(rest)
              } else update({ defaultProjectId: id })
            }}
          />
        </div>
      </Section>
      <Section
        title={COPY.skills}
        aside={harness && !harness.skills ? <Hint label={COPY.skillsUnavailable}>{COPY.skillsUnavailableDetail}</Hint> : undefined}>
        <SkillChoice
          catalog={catalog}
          value={draft.skills}
          allowAll={false}
          disabled={locked}
          onChange={skills => {
            update({ skills: skills ?? [] })
          }}
        />
      </Section>
      {builtIn && (
        <Section
          title={COPY.tools}
          aside={
            <Hint label={COPY.restrict} lead={<ShieldGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}>
              {COPY.restrictDetail}
            </Hint>
          }>
          <div className="agent-checks">
            <Checkbox
              label={COPY.allPlugins}
              checked={draft.tools === undefined}
              disabled={locked}
              onChange={event => {
                if (event.target.checked) {
                  const { tools: _tools, ...rest } = draft
                  setDraft(rest)
                } else update({ tools: toolPlugins.map(plugin => plugin.id) })
              }}
            />
            {toolPlugins.map(plugin => (
              <Checkbox
                key={plugin.id}
                label={plugin.name}
                checked={draft.tools === undefined || draft.tools.includes(plugin.id)}
                disabled={locked || draft.tools === undefined}
                onChange={event => {
                  const current = draft.tools ?? []
                  update({ tools: event.target.checked ? [...current, plugin.id] : current.filter(id => id !== plugin.id) })
                }}
              />
            ))}
          </div>
        </Section>
      )}
      <WriteNotice state={state} onRetry={() => void retry()} {...(onReload ? { onReload } : {})} />
      {elsewhere && !(state && 'kind' in state) && (
        <InlineNotice
          tone="warn"
          title={COPY.conflict}
          action={
            <Button
              onClick={() => {
                setConflicts([])
                setDraft(base)
              }}>
              {COPY.latest}
            </Button>
          }>
          {COPY.conflictDetail}
        </InlineNotice>
      )}
      <div className="agent-form-actions">
        {agent && onDeleted && (
          <Button
            variant="ghost"
            icon={TrashGlyph}
            disabled={locked}
            onClick={() => {
              setDeleting(true)
            }}>
            {COPY.delete}
          </Button>
        )}
        <span className="agent-form-spacer" />
        {onCancel && (
          <Button disabled={writes.saving} onClick={onCancel}>
            {COPY.cancel}
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={locked || problem !== undefined || !changed || saveWaits(conflicts)}
          loading={state !== null && 'phase' in state && state.phase === 'saving'}
          title={saveWaits(conflicts) ? COPY.conflictTip : problem}>
          {COPY.save}
        </Button>
      </div>
      {deleting && agent && onDeleted && (
        <AgentDeleteDialog
          agent={agent}
          writes={writes}
          onClose={() => {
            setDeleting(false)
          }}
          onDeleted={onDeleted}
        />
      )}
    </form>
  )
}

/** 通用's settings: its instructions and which skills its sessions load. */
export function GeneralForm({
  catalog,
  detail,
  writes,
  disabled,
  onReload,
}: {
  catalog: HostCatalog
  detail: GeneralAgentDetail
  writes: AgentWrites
  disabled: boolean
  onReload: () => void
}) {
  const general = detail.general
  const [instructions, setInstructions] = useState(general.instructions)
  const [skills, setSkills] = useState<string[] | undefined>(general.skills)
  useEffect(() => {
    setInstructions(general.instructions)
    setSkills(general.skills)
  }, [general.revision])
  const state = writeFor(writes.state, 'agent:general')
  const locked = disabled || writes.saving || writes.held
  const changed = instructions !== general.instructions || JSON.stringify(skills ?? null) !== JSON.stringify(general.skills ?? null)
  return (
    <form
      className="agent-form"
      aria-label={COPY.settings(AGENT_SPACE_COPY.general)}
      onSubmit={event => {
        event.preventDefault()
        if (locked || !changed) return
        void writes.run('agent:general', 'custom-agents/general', 'PATCH', {
          baseRevision: general.revision,
          ...(instructions !== general.instructions ? { instructions } : {}),
          ...(JSON.stringify(skills ?? null) !== JSON.stringify(general.skills ?? null) ? { skills: skills ?? null } : {}),
        })
      }}>
      <TextAreaField
        label={COPY.instructions}
        value={instructions}
        rows={6}
        maxLength={32_000}
        disabled={locked}
        onChange={event => {
          setInstructions(event.target.value)
        }}
      />
      <Section title={COPY.skills} aside={<TakesEffect />}>
        <SkillChoice catalog={catalog} value={skills} allowAll disabled={locked} onChange={setSkills} />
      </Section>
      <WriteNotice state={state} onRetry={() => void writes.retry()} onReload={onReload} />
      <div className="agent-form-actions">
        <span className="agent-form-spacer" />
        <Button
          type="submit"
          variant="primary"
          disabled={locked || !changed}
          loading={state !== null && 'phase' in state && state.phase === 'saving'}>
          {COPY.save}
        </Button>
      </div>
    </form>
  )
}
