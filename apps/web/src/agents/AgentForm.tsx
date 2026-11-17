import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { CustomAgent, CustomAgentDetail, CustomAgentList, GeneralAgentDetail, HostCatalog } from '@latch/protocol'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Hint,
  ICON_STROKE,
  InlineNotice,
  StatusWord,
  TextAreaField,
  TextField,
  ShieldGlyph,
  TrashGlyph,
} from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ProjectPicker } from '../components/Pickers.tsx'
import { harnessName } from '../composerChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { draftOf, normalizedDraft, patchOf, rebaseDraft, saveWaits, type AgentDraft } from './model.ts'
import { isolationBrief } from './helpers.ts'
import { writeFor, type AgentWrites, type WriteState } from './useAgentWrites.ts'
import { MessageError } from '../core/api.ts'
import { AgentDefaults } from './AgentDefaults.tsx'
import { BudgetControl, useModelSpend } from '../settings/ModelSpend.tsx'

/** When a change reaches the Agent's sessions: the fine print behind ⓘ. */
export function TakesEffect({ label = '何时生效' }: { label?: string }) {
  return (
    <Hint label={label} lead={false} className="agent-effect">
      内置 Harness 从下一轮起读取所选模型、指令和记忆。外部 Harness 在首次聊天或清空上下文后读取指令和记忆。要修改外部 Harness
      的模型或权限，请使用当前聊天中的可用选项。
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
        title="结果未知"
        action={state.unreplayable ? undefined : <Button onClick={onRetry}>重试同一请求</Button>}
        {...(onAbandon ? { onClose: onAbandon, closeLabel: '放弃等待' } : {})}>
        <span>{state.message}</span> <span className="agent-request-id">{state.write.body.requestId}</span>
      </InlineNotice>
    )
  if (state.kind === 'conflict')
    return (
      <InlineNotice tone="warn" title="已在别处修改" action={onReload ? <Button onClick={onReload}>载入最新</Button> : undefined}>
        {state.message}
      </InlineNotice>
    )
  return (
    <InlineNotice tone="error" title="没有保存">
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
  if (!skills.length && !missing.length) return <p className="agent-form-empty">没有已启用的技能</p>
  return (
    <div className="agent-checks">
      {allowAll && (
        <Checkbox
          label="全部已启用的技能"
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
          description="插件已停用"
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
  homePath,
}: {
  catalog: HostCatalog
  access: DeviceAccess
  agent: CustomAgentDetail['agent']
  plugins: CustomAgentList['plugins']
  writes: AgentWrites
  /** Offline or held by another write. */
  disabled: boolean
  onSaved: (agent: CustomAgent) => void
  onDeleted?: () => void
  onCancel?: () => void
  onReload?: () => void
  onManageProviders?: () => void
  onOptionsRead?: () => void | Promise<void>
  homePath?: string | undefined
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
  const problem = draft.name.trim() ? undefined : '先填名称'
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
      aria-label={`${agent.name} 的设置`}
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}>
      <TextField
        label="名称"
        value={draft.name}
        maxLength={80}
        placeholder="例如：资料整理"
        disabled={locked}
        onChange={event => {
          update({ name: event.target.value })
        }}
      />
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
      <Section title="执行方式" aside={<TakesEffect />}>
        <dl className="agent-facts">
          <dt>由谁运行</dt>
          <dd>
            {/* Fixed at creation: another Harness is another Agent. Latch does not isolate it either way. */}
            <Hint
              label={`由 ${harness ? harnessName(harness) : draft.harnessId} 运行`}
              lead={harness ? <HarnessTile harness={harness} size={14} /> : undefined}>
              建好后不能换 Harness，要用别的就新建一个 Agent。
              {isolation ? ` ${isolation.label}。${isolation.detail}` : ''}
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
              <dt>本月预算</dt>
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

      <Section title="默认项目">
        <div className="agent-form-pickers">
          <ProjectPicker
            catalog={catalog}
            defaultLocation={{ label: '家', description: '没有选项目时，在家里做' }}
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
        title="技能"
        aside={
          harness && !harness.skills ? (
            <Hint label="这个 Harness 收不到技能">技能经内置加载或技能服务送达；这个 Harness 两种都不接受，所选技能不会发送。</Hint>
          ) : undefined
        }>
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
          title="可以使用"
          aside={
            <Hint label="只收紧" lead={<ShieldGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />}>
              只对内置 Harness 生效：它只能调用勾选的插件的工具，不会因此获得新的能力。
            </Hint>
          }>
          <div className="agent-checks">
            <Checkbox
              label="全部已启用的插件"
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
          title="已在别处修改"
          action={
            <Button
              onClick={() => {
                setConflicts([])
                setDraft(base)
              }}>
              载入最新
            </Button>
          }>
          这项记录已更新，请刷新后再修改。
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
            删除
          </Button>
        )}
        <span className="agent-form-spacer" />
        {onCancel && (
          <Button disabled={writes.saving} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={locked || problem !== undefined || !changed || saveWaits(conflicts)}
          loading={state !== null && 'phase' in state && state.phase === 'saving'}
          title={saveWaits(conflicts) ? '已在别处修改，载入最新后再保存' : problem}>
          保存
        </Button>
      </div>
      {deleting && agent && onDeleted && (
        <ConfirmDialog
          title={`删除「${agent.name}」？`}
          danger
          confirmLabel="删除"
          message={`它的记忆一并删除，已有会话保留。它在内置 Harness 上的会话不再接受输入。它的文件夹留着${homePath ? `：${homePath}` : ''}。`}
          onClose={() => {
            setDeleting(false)
          }}
          onConfirm={async () => {
            const done = await writes.run(`agent:${agent.id}`, `custom-agents/${encodeURIComponent(agent.id)}`, 'DELETE', {})
            if (done === undefined) throw new MessageError('没有删除，原因见页面下方。')
            onDeleted()
          }}
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
      aria-label="通用 的设置"
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
        label="指令"
        value={instructions}
        rows={6}
        maxLength={32_000}
        disabled={locked}
        onChange={event => {
          setInstructions(event.target.value)
        }}
      />
      <Section title="技能" aside={<TakesEffect />}>
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
          保存
        </Button>
      </div>
    </form>
  )
}
