import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { ChevronDown, ChevronUp, FlaskConical } from 'lucide-react'
import { pairRoute, type AppSnapshot, type SessionConfigOption, type WorkspaceInfo, type WorktreeStart } from '@latch/protocol'
import { Badge, Button, Hint, ICON_STROKE, MOTION, Sheet, usePresence, ValuePicker } from '@latch/ui'
import {
  draftConfig,
  engineEntries,
  findProvider,
  harnessName,
  servicePick,
  withServicePick,
  type ComposerChoice,
} from '../composerChoice.ts'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import type { DeviceAccess } from '../core/permissions.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ModelPicker, ModeSwitch, ProjectPicker } from '../components/Pickers.tsx'
import { agentConfigValues, DEFAULT_LEVEL, DEFAULT_MODEL } from '../composer/modelReasoning.ts'
import {
  onComputer,
  OWN_MODEL,
  ownModelGroups,
  ROUTE_NOTE,
  serviceRef,
  serviceValue,
  unusableServices,
  UnusableServices,
} from '../composer/ModelControl.tsx'
import { draftPermission, draftRead } from '../composer/permission.ts'
import { FolderControl } from '../composer/FolderControl.tsx'
import { MODE_ICONS } from '../composer/PermissionList.tsx'
import { BriefHint } from '../composer/BriefHint.tsx'
import { computerName, MODE_COPY } from '../core/securityCopy.ts'
import {
  CatalogueRows,
  readOnSelect,
  readsOnPermission,
  readsOnSelect,
  TypedModelsPanel,
  useReading,
} from '../composer/harnessCatalogue.tsx'

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
  worktree,
}: {
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
  /** A Git project's draft: 当前文件夹 or 新工作树. */
  worktree?:
    | { project: WorkspaceInfo; picked: WorktreeStart | undefined; onPick: (worktree: WorktreeStart | undefined) => void }
    | undefined
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
  const computer = access.local ? undefined : computerName(snapshot.hostName)
  const entries = catalog ? engineEntries(catalog, choice.workspaceId) : []
  const harness = entries.find(entry => entry.harness.id === choice.harnessId)?.harness
  const known = harness?.capabilities.models.owner === 'latch' ? undefined : draftConfig(harness, choice.config)
  const reading = useReading(harness)
  const permission = draftPermission(harness, choice.mode, known?.config, draftRead(harness, access, reading))
  // As in the menu on a wider screen: the main rows, and the rest under 更多.
  const [morePermission, setMorePermission] = useState(false)
  const permissionRows = permission?.rows?.filter(row => morePermission || !row.more)
  const hiddenPermission = permission?.rows?.some(row => row.more) === true
  const modelOption = known?.config.find(option => option.category === 'model')
  const thought = known?.config.find(option => option.category === 'thought_level')
  const service = servicePick(catalog, harness, choice.config)
  // With a saved service the model row lists services too, as the composer's menu does: those Latch can forward this
  // Harness's requests to, and the others with why not.
  const services =
    catalog !== undefined
    && harness !== undefined
    && harness.capabilities.models.owner !== 'latch'
    && catalog.providers.some(provider => provider.kind !== 'demo')
  const forwards =
    services
    && catalog.providers.some(provider => provider.kind !== 'demo' && pairRoute(harness.capabilities, provider).kind === 'passthrough')
  // A model of its own replaces a service pick; thinking and the rest are kept either way.
  const pick = (configId: string, value: string) => {
    const base = configId === modelOption?.id ? withServicePick(choice.config, undefined) : choice.config
    onChoice({ config: { ...base, [configId]: value } })
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
  const typedPanel = (configId: string | undefined) =>
    typing && harness && configId
      ? {
          panel: (
            <TypedModelsPanel
              harness={harness}
              onBack={() => {
                setTyping(false)
              }}
              onChoose={model => {
                pick(configId, model)
                setTyping(false)
              }}
              onSaved={read}
            />
          ),
        }
      : {}
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
      {...(footer && option.category === 'model' ? { onOpenChange: opened, ...typedPanel(option.id) } : {})}
      onValueChange={value => {
        pick(option.id, value)
      }}
    />
  )
  return (
    <Sheet
      open={open}
      detent="large"
      title="新会话"
      className="new-session-sheet"
      onClose={onClose}
      action={
        <Button variant="primary" disabled={!canStart} loading={sending} onClick={onStart}>
          开始
        </Button>
      }>
      {present && catalog && (
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
          {worktree && (
            <FolderControl
              variant="row"
              project={worktree.project}
              worktree={worktree.picked}
              onWorktree={worktree.onPick}
              disabled={disabled}
              starts
            />
          )}
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
              description: onComputer(entry.line, computer),
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
              <StaticRow label="思考" value={DEFAULT_LEVEL} />
            </>
          ) : services ? (
            <>
              <ValuePicker
                variant="row"
                label="模型"
                className="new-sheet-row"
                value={service ? serviceValue(service) : (modelOption?.currentValue ?? OWN_MODEL)}
                {...(service
                  ? { valueText: `${service.model} · ${findProvider(catalog, service.providerId)?.name ?? service.providerId}` }
                  : {})}
                disabled={disabled}
                pending={reading}
                pendingLabel="正在读取…"
                searchable={(modelOption?.options.length ?? 0) + catalog.providers.length >= 8}
                groups={ownModelGroups(
                  catalog,
                  harness,
                  modelOption
                    ? agentConfigValues(modelOption).map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))
                    : [{ value: OWN_MODEL, label: DEFAULT_MODEL }],
                  undefined,
                  computer,
                )}
                footer={
                  <div className="model-footer">
                    <UnusableServices services={unusableServices(catalog, harness, computer)} />
                    {rows(modelOption !== undefined)}
                    {forwards && <BriefHint brief={ROUTE_NOTE(harnessName(harness), computer)} className="model-note" />}
                  </div>
                }
                onOpenChange={opened}
                {...typedPanel(modelOption?.id)}
                onValueChange={value => {
                  const ref = serviceRef(value)
                  if (ref) onChoice({ config: withServicePick(choice.config, ref, modelOption?.id) })
                  else if (modelOption) pick(modelOption.id, value)
                  else onChoice({ config: withServicePick(choice.config, undefined) })
                }}
              />
              {service ? (
                <StaticRow label="思考" value="开始后才知道" />
              ) : thought ? (
                optionRow('思考', thought)
              ) : (
                <StaticRow
                  label="思考"
                  value={
                    known?.thinkingUnknown
                      ? '开始后才知道'
                      : known || harness.catalogueRead
                        ? DEFAULT_LEVEL
                        : `${DEFAULT_LEVEL} · 开始后可以换`
                  }
                />
              )}
            </>
          ) : known ? (
            <>
              {modelOption ? (
                optionRow('模型', modelOption, <div className="model-footer">{rows(true)}</div>)
              ) : (
                <StaticRow label="模型" value={DEFAULT_MODEL} />
              )}
              {thought ? (
                optionRow('思考', thought)
              ) : (
                <StaticRow label="思考" value={known.thinkingUnknown ? '开始后才知道' : DEFAULT_LEVEL} />
              )}
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
                <StaticRow label="思考" value={DEFAULT_LEVEL} />
              </>
            ) : (
              <>
                <StaticRow label="模型" value={`${DEFAULT_MODEL} · 开始后可以换`} />
                <StaticRow label="思考" value={`${DEFAULT_LEVEL} · 开始后可以换`} />
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
              // Its modes come from the same read as the model list, so opening it first asks as well.
              onOpenChange={open => {
                // Each opening shows the main rows again, with the current one among them.
                if (open) setMorePermission(false)
                if (open && !disabled && readsOnPermission(harness, access)) readOnSelect(harness, read)
              }}
              options={
                permissionRows?.map(row => {
                  const Glyph = MODE_ICONS[row.icon]
                  return {
                    value: row.value,
                    label: escapeHiddenCharacters(row.name),
                    ...(row.line ? { description: escapeHiddenCharacters(row.line) } : {}),
                    media: <Glyph size={16} aria-hidden="true" className={row.neverAsks ? 'permission-never' : undefined} />,
                  }
                }) ?? [{ value: 'current', label: permission.label, ...(permission.line ? { description: permission.line } : {}) }]
              }
              footer={
                <>
                  {hiddenPermission && (
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={morePermission ? ChevronUp : ChevronDown}
                      aria-expanded={morePermission}
                      onClick={() => {
                        setMorePermission(!morePermission)
                      }}>
                      {morePermission ? MODE_COPY.fewer : MODE_COPY.more}
                    </Button>
                  )}
                  {permission.note && <BriefHint brief={permission.note} className="permission-list-note" />}
                </>
              }
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
        <div className="new-sheet-note">
          <Hint lead={<FlaskConical size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />} label={<Badge tone="warn">演示</Badge>}>
            回复由本地脚本生成，不调用模型服务。
          </Hint>
        </div>
      )}
      {present && setup}
      {present && composer}
    </Sheet>
  )
}
