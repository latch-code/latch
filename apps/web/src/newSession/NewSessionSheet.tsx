import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { FlaskConical } from 'lucide-react'
import type { AppSnapshot, PersonalAssistantSummary, SessionConfigOption } from '@latch/protocol'
import { Badge, Button, ICON_STROKE, MenuFooterNote, MOTION, Sheet, usePresence, ValuePicker } from '@latch/ui'
import { draftConfig, engineEntries, type ComposerChoice } from '../composerChoice.ts'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import type { DeviceAccess } from '../core/permissions.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ModelPicker, ModeSwitch, ProjectPicker } from '../components/Pickers.tsx'
import { agentConfigValues, DEFAULT_MODEL } from '../composer/modelReasoning.ts'
import { draftPermission } from '../composer/permission.ts'
import { CatalogueRows, readOnSelect, readsOnSelect, TypedModelsPanel, useReading } from '../composer/harnessCatalogue.tsx'

function StaticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="new-sheet-row">
      <span className="new-sheet-label">{label}</span>
      <span className="new-sheet-value">{value}</span>
    </div>
  )
}

/** The phone's new session: one row per choice (项目, Harness, 模型, 思考, 权限), then the input; 开始 is in the header. */
export function NewSessionSheet({
  personal,
  open,
  onClose,
  snapshot,
  access,
  choice,
  onChoice,
  disabled,
  canStart,
  sending,
  onStart,
  composer,
  setup,
  demo,
  onManageProviders,
  onProvidersChanged,
  onHarnessChanged,
  onManageWorkspaces,
  onCreateProject,
  projectAsk,
  onBrowseFiles,
  focusComposer,
}: {
  personal?: PersonalAssistantSummary
  open: boolean
  onClose: () => void
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin' | 'scopes'>
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  disabled: boolean
  canStart: boolean
  sending: boolean
  onStart: () => void
  composer: ReactNode
  setup?: ReactNode
  demo: boolean
  onManageProviders?: (() => void) | undefined
  onProvidersChanged?: (() => void) | undefined
  /** The Harness's lists or the model IDs typed for it changed on the Host. */
  onHarnessChanged?: (() => Promise<void>) | undefined
  onManageWorkspaces?: (() => void) | undefined
  onCreateProject?: (() => void) | undefined
  projectAsk?: { request: number; notice?: string | undefined; clearNotice: () => void }
  onBrowseFiles?(): void
  focusComposer?: RefObject<HTMLTextAreaElement | null>
}) {
  const { present } = usePresence(open, MOTION.sheet)
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    if (!open || !present) return undefined
    const frame = requestAnimationFrame(() => {
      focusComposer?.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, present, focusComposer])
  const catalog = snapshot.catalog
  const entries = catalog ? engineEntries(catalog, choice.workspaceId) : []
  const harness = entries.find(entry => entry.harness.id === choice.harnessId)?.harness
  const known = harness?.capabilities.models.owner === 'latch' ? undefined : draftConfig(harness, choice.config)
  const reading = useReading(harness)
  const permission = draftPermission(harness, choice.mode, known?.config)
  const pick = (configId: string, value: string) => {
    onChoice({ config: { ...choice.config, [configId]: value } })
  }
  const read = () => onHarnessChanged?.()
  const opened = (open: boolean) => {
    if (!open) setTyping(false)
    if (open && readsOnSelect(harness, access)) readOnSelect(harness, read)
  }
  /** Where the Harness's list comes from, reading it, and typing an ID it does not list. */
  const rows = (hasModels: boolean) =>
    harness && (
      <CatalogueRows
        harness={harness}
        access={access}
        hasModels={hasModels}
        onRead={read}
        onTypeModel={() => {
          setTyping(true)
        }}
      />
    )
  /** One of the Harness's own options as a row; the list says where it came from. */
  const optionRow = (label: string, option: SessionConfigOption, footer?: ReactNode) => (
    <ValuePicker
      variant="row"
      label={label}
      className="new-sheet-row"
      value={option.currentValue}
      disabled={disabled}
      searchable={option.options.length >= 8}
      options={agentConfigValues(option).map(item => ({
        value: item.value,
        label: escapeHiddenCharacters(item.name),
        ...(item.description ? { description: escapeHiddenCharacters(item.description) } : {}),
      }))}
      {...(footer ? { footer } : {})}
      {...(footer && option.category === 'model'
        ? {
            onOpenChange: opened,
            ...(typing && harness
              ? {
                  panel: (
                    <TypedModelsPanel
                      harness={harness}
                      onBack={() => {
                        setTyping(false)
                      }}
                      onChoose={model => {
                        pick(option.id, model)
                        setTyping(false)
                      }}
                      onSaved={read}
                    />
                  ),
                }
              : {}),
          }
        : {})}
      onValueChange={value => {
        pick(option.id, value)
      }}
    />
  )
  const modelOption = known?.config.find(option => option.category === 'model')
  const thought = known?.config.find(option => option.category === 'thought_level')
  return (
    <Sheet
      open={open}
      detent="large"
      title={personal ? '和' + personal.name + '聊聊' : '新会话'}
      className="new-session-sheet"
      onClose={onClose}
      action={
        <Button variant="primary" disabled={!canStart} loading={sending} onClick={onStart}>
          开始
        </Button>
      }>
      {present && !personal && catalog && (
        <div className="new-sheet-card">
          <ProjectPicker
            access={access}
            harness={harness}
            variant="row"
            catalog={catalog}
            value={choice.workspaceId === 'default' && !choice.projectSkipped && catalog.sessionFolders ? undefined : choice.workspaceId}
            disabled={disabled}
            onChange={workspaceId => onChoice({ workspaceId, projectSkipped: workspaceId === 'default' })}
            onManage={onManageWorkspaces}
            onCreate={onCreateProject}
            openRequest={projectAsk?.request}
            notice={projectAsk?.notice}
            onClosed={projectAsk?.clearNotice}
          />
          <ValuePicker
            variant="row"
            label="Harness"
            placeholder="选择 Harness"
            className="new-sheet-row"
            value={harness?.id}
            leading={harness ? <HarnessTile harness={harness} size={16} /> : undefined}
            disabled={disabled}
            options={entries.map(entry => ({
              value: entry.harness.id,
              label: entry.label,
              description: entry.line,
              media: <HarnessTile harness={entry.harness} size={20} />,
              ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
            }))}
            onValueChange={harnessId => {
              onChoice({ harnessId })
              const chosen = entries.find(entry => entry.harness.id === harnessId)?.harness
              if (readsOnSelect(chosen, access)) readOnSelect(chosen, read)
            }}
          />
          {harness?.capabilities.models.owner === 'latch' ? (
            <>
              <ModelPicker
                variant="row"
                catalog={catalog}
                value={choice.model}
                disabled={disabled}
                access={access}
                onChange={model => onChoice({ model })}
                onManage={onManageProviders}
                onAdded={onProvidersChanged}
              />
              <StaticRow label="思考" value="模型默认" />
            </>
          ) : known ? (
            <>
              {modelOption ? (
                optionRow('模型', modelOption, <div className="model-footer">{rows(true)}</div>)
              ) : (
                <StaticRow label="模型" value={DEFAULT_MODEL} />
              )}
              {thought ? optionRow('思考', thought) : <StaticRow label="思考" value={known.thinkingUnknown ? '开始后才知道' : '默认'} />}
            </>
          ) : (
            harness
            && (harness.catalogueRead ? (
              <>
                <ValuePicker
                  variant="row"
                  label="模型"
                  className="new-sheet-row"
                  value="default"
                  disabled={disabled}
                  pending={reading}
                  pendingLabel="正在读取…"
                  options={[{ value: 'default', label: DEFAULT_MODEL }]}
                  footer={<div className="model-footer">{rows(false)}</div>}
                  onOpenChange={opened}
                  onValueChange={() => {}}
                />
                <StaticRow label="思考" value="默认" />
              </>
            ) : (
              <>
                <StaticRow label="模型" value={`${DEFAULT_MODEL} · 开始后可以换`} />
                <StaticRow label="思考" value="默认 · 开始后可以换" />
              </>
            ))
          )}
          {permission && (
            <ValuePicker
              variant="row"
              label="权限"
              className={`new-sheet-row new-sheet-permission${permission.amber ? ' is-amber' : ''}`}
              value={permission.rows ? permission.option!.currentValue : 'current'}
              disabled={disabled && permission.rows !== undefined}
              options={
                permission.rows?.map(row => ({
                  value: row.value,
                  label: escapeHiddenCharacters(row.name),
                  ...(row.line ? { description: escapeHiddenCharacters(row.line) } : {}),
                })) ?? [{ value: 'current', label: permission.label }]
              }
              footer={<MenuFooterNote>{permission.note ?? permission.line}</MenuFooterNote>}
              onValueChange={value => {
                if (permission.option) pick(permission.option.id, value)
              }}
            />
          )}
          {onBrowseFiles && (
            <Button variant="ghost" onClick={onBrowseFiles}>
              浏览项目文件
            </Button>
          )}
        </div>
      )}
      {present && !catalog && (
        <div className="new-sheet-card">
          <div className="new-sheet-row">
            <span className="new-sheet-label">方式</span>
            <ModeSwitch value={choice.mode} disabled={disabled} onChange={mode => onChoice({ mode })} />
          </div>
        </div>
      )}
      {present && demo && (
        <p className="new-sheet-note">
          <FlaskConical size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <Badge tone="warn">演示</Badge>回复由本地脚本生成，不调用模型服务。
        </p>
      )}
      {present && setup}
      {present && composer}
    </Sheet>
  )
}
