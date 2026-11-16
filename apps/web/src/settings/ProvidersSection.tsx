import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { KeyRound, ListRestart } from 'lucide-react'
import { type AppSnapshot, type ProviderPreset, type ProviderSettings } from '@latch/protocol'
import { Button, DemoMark, Dialog, InlineNotice, Menu, EditGlyph, PlusGlyph, TrashGlyph } from '@latch/ui'
import { deferredComponent } from '../components/DeferredContent.tsx'
import { ProviderTile } from '../components/BrandTile.tsx'
import { ConfirmDialog } from '../components/overlays.tsx'
import { HealthLine } from '../components/ServiceHealth.tsx'
import { api, ApiError, errorMessage, inlineError, MessageError } from '../core/api.ts'
import { hostView, type DeviceAccess } from '../core/permissions.ts'
import { providerAbilities } from '../core/providerAbilities.ts'
import {
  describeProbeFailure,
  isUnconfirmed,
  keyScopeOf,
  latestQuestions,
  listModels,
  missingKey,
  SERVICE_FORM,
  serviceHealth,
  shownAddress,
  updateProvider,
  type ProbeFailure,
  type ProvidersResponse,
  type ServiceHealth,
} from '../core/providerSetup.ts'
import { computerName, PROVIDER_COPY } from '../core/securityCopy.ts'
import { Loading, moreButton, ObjectRow, SettingsGroup, SettingsRow } from './common.tsx'
import { ConfirmedAddresses } from './ConfirmedAddresses.tsx'
import { FieldDialog } from './dialogs.tsx'
import { ModelVisibilitySettings } from './ModelVisibilitySettings.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'
import { peekProviderDraft } from './providerDraft.ts'
import { isSupported, providerKindLabels, type SupportedProvider } from './providerKind.ts'
import { UsageSettings } from './UsageSettings.tsx'
import { readDenied, type ModelSettingsReads } from './modelSettingsReads.ts'

const ProviderPage = deferredComponent(async () => ({ default: (await import('./ProvidersSettings.tsx')).ProviderPage }), '服务详情')
const ProviderAddContent = deferredComponent(
  async () => ({ default: (await import('./ProvidersSettings.tsx')).ProviderAddContent }),
  SERVICE_FORM.title,
)

type Selection = { kind: 'provider'; id: string; check?: boolean; fetch?: boolean } | null
const EMPTY_PROVIDERS: ProviderSettings[] = []
const EMPTY_PRESETS: ProviderPreset[] = []

/** What a service's row says about it: facts it knows, or what the latest listing in this visit found. */
type Health = ServiceHealth

/** How many services are asked at once; each answer can take up to 20 seconds. */
const CHECKS_AT_ONCE = 4

/**
 * 已连接 has to be something the app just saw, not something it assumes from a saved key, so opening the page lists each
 * usable service's models once. A listing spends no tokens. A new address or key asks again, and a check on a service's
 * own page counts too, so its row never disagrees with the page.
 */
function useServiceHealth(
  providers: readonly ProviderSettings[],
  presets: readonly ProviderPreset[],
): { health: Record<string, Health>; recheck: (id: string) => void; report: (id: string, failure: ProbeFailure | null) => void } {
  const [health, setHealth] = useState<Record<string, Health>>({})
  const usable = useMemo(
    () => providers.filter(provider => provider.enabled && !isUnconfirmed(provider) && !missingKey(provider, presets)),
    [providers, presets],
  )
  const asked = useRef(new Map<string, string>())
  const questions = useRef(latestQuestions())
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const due = usable.filter(provider => asked.current.get(provider.id) !== provider.baseURL)
    if (due.length === 0) return
    for (const provider of due) asked.current.set(provider.id, provider.baseURL)
    setHealth(current => ({ ...current, ...Object.fromEntries(due.map(provider => [provider.id, 'checking' as const])) }))
    const queue = due.map(provider => ({ id: provider.id, latest: questions.current.ask(provider.id) }))
    const next = async (): Promise<void> => {
      if (!mounted.current) return
      const question = queue.shift()
      if (!question) return
      if (question.latest()) {
        const result = await listModels(question.id).then(
          () => serviceHealth(null),
          (cause: unknown) => serviceHealth(describeProbeFailure(cause)),
        )
        if (mounted.current && question.latest()) setHealth(current => ({ ...current, [question.id]: result }))
      }
      await next()
    }
    for (let worker = 0; worker < CHECKS_AT_ONCE; worker++) void next()
  }, [usable])
  return {
    health,
    recheck: id => {
      asked.current.delete(id)
    },
    report: useCallback((id, failure) => {
      questions.current.ask(id)
      setHealth(current => ({ ...current, [id]: serviceHealth(failure) }))
    }, []),
  }
}

/** The state at a service's end: quiet while it works, a red word with the way out when it does not. */
function ServiceStatus({
  provider,
  presets,
  health,
  computer,
  keyBlocked,
  onUpdateKey,
}: {
  provider: ProviderSettings
  presets: readonly ProviderPreset[]
  health: Health | undefined
  computer: string
  keyBlocked: string | undefined
  onUpdateKey: () => void
}) {
  const word = (text: string, tone?: 'err' | 'warn', reason?: string) => (
    <span className="service-status" data-tone={tone} title={reason}>
      {text}
    </span>
  )
  if (!provider.enabled) return word('已停用')
  if (isUnconfirmed(provider)) return word(PROVIDER_COPY.unconfirmedBadge, 'warn', PROVIDER_COPY.unconfirmedRow(computer))
  const keyAction = (label: string) => (
    <Button variant="outline" disabled={keyBlocked !== undefined} tooltip={keyBlocked} onClick={onUpdateKey}>
      {label}
    </Button>
  )
  if (missingKey(provider, presets))
    return (
      <>
        {word(PROVIDER_COPY.missingKeyBadge, 'warn')}
        {keyAction('设置密钥')}
      </>
    )
  switch (health) {
    case 'key':
      return (
        <>
          {word('密钥无效', 'err')}
          {keyAction('更新密钥')}
        </>
      )
    case 'unreachable':
      return word('连不上', 'err')
    case 'local':
      return word('等待允许', 'warn')
    case 'ok':
      return word('已连接', undefined, PROVIDER_COPY.connectedReason)
    case 'checking':
      return word('检测中')
    default:
      return null
  }
}

export function ProvidersSection({
  snapshot,
  access,
  reads,
  onChanged,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  reads: ModelSettingsReads
  onChanged: () => void
}) {
  const [data, setData] = useState(reads.providers)
  const [readConfig, setReadConfig] = useState(false)
  const [error, setError] = useState('')
  const [denied, setDenied] = useState(false)
  const [targetError, setTargetError] = useState('')
  const [selection, setSelection] = useState<Selection>(null)
  // A form left for a session (查看会话) opens again where it was.
  const [adding, setAdding] = useState<{ preset: ProviderPreset | null } | null>(() => {
    const draft = peekProviderDraft()
    return draft ? { preset: draft.preset } : null
  })
  const [sheetFooter, setSheetFooter] = useState<HTMLElement | null>(null)
  const [addCommitting, setAddCommitting] = useState(false)
  const [keyFor, setKeyFor] = useState<SupportedProvider | null>(null)
  const [removing, setRemoving] = useState<ProviderSettings | null>(null)
  const reading = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(false)
  const load = useCallback(async () => {
    if (!mounted.current) return
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    try {
      while (!controller.signal.aborted) {
        const version = reads.providersVersion
        const next = await api<ProvidersResponse>('providers', { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!reads.keepProviders(next, version)) continue
        setData(next)
        setReadConfig(true)
        setDenied(false)
        setError('')
        return
      }
    } catch (cause) {
      if (controller.signal.aborted) return
      if (readDenied(cause)) {
        setDenied(true)
        setReadConfig(false)
        reads.keepProviders(undefined)
        setData(undefined)
        setSelection(null)
        setAdding(null)
        setKeyFor(null)
        setRemoving(null)
      }
      setError(errorMessage(cause))
    }
  }, [reads])
  useEffect(() => {
    mounted.current = true
    const unsubscribe = reads.subscribeProviderChanges(() => {
      setReadConfig(false)
      void load()
    })
    void load()
    return () => {
      unsubscribe()
      mounted.current = false
      reading.current?.abort()
    }
  }, [load, reads])
  const { health, recheck, report } = useServiceHealth(
    (readConfig ? data?.providers : undefined) ?? EMPTY_PROVIDERS,
    data?.presets ?? EMPTY_PRESETS,
  )

  const abilities = providerAbilities(access, hostView(snapshot)?.presence)
  const computer = computerName(snapshot.hostName)
  const targetBlocked =
    snapshot.catalog?.features?.providerUpdateTarget !== true
      ? '请更新并重新启动这台 Mac 上的 Latch 后再修改。'
      : readConfig
        ? undefined
        : '正在核对模型服务的地址和协议…'
  const keyBlocked = abilities.keys ? targetBlocked : PROVIDER_COPY.keyElsewhere(computer)
  if (
    keyFor
    && (keyBlocked !== undefined
      || !data?.providers.some(
        provider => provider.id === keyFor.id && provider.baseURL === keyFor.baseURL && provider.kind === keyFor.kind,
      ))
  ) {
    setKeyFor(null)
  }
  const onTargetError = (cause: unknown) => {
    if (!(cause instanceof ApiError) || cause.code !== 'provider-target-changed') return
    setTargetError(errorMessage(cause))
    setKeyFor(null)
    setReadConfig(false)
    void load()
  }
  const external = snapshot.catalog?.providers.filter(provider => provider.kind === 'demo' || provider.kind === 'plugin') ?? []
  const defaultProvider = snapshot.catalog?.defaults.model?.providerId
  const selected =
    selection?.kind === 'provider' ? data?.providers.filter(isSupported).find(provider => provider.id === selection.id) : undefined
  const changed = () => {
    setTargetError('')
    reads.providersChanged()
    onChanged()
  }
  const saved = (provider: ProviderSettings) => {
    recheck(provider.id)
    changed()
  }
  const deleted = () => {
    setSelection(null)
    changed()
  }
  const addService = () => {
    setAdding({ preset: null })
  }
  const closeAdd = () => {
    if (!addCommitting) setAdding(null)
  }
  const notice: ReactNode = error ? (
    <InlineNotice tone="error" action={<Button onClick={() => void load()}>重试</Button>}>
      {error}
      {data && ' 当前显示上次读取结果。'}
    </InlineNotice>
  ) : null
  // A denied read must remove protected phone levels immediately, including their exit animation.
  if (denied)
    return (
      <SettingsGroup title="模型服务" bare>
        {notice}
      </SettingsGroup>
    )

  const conflict = targetError ? (
    <InlineNotice
      tone="error"
      action={
        <Button size="sm" onClick={() => setTargetError('')}>
          关闭
        </Button>
      }>
      {targetError}
    </InlineNotice>
  ) : null
  const main = (
    <>
      {conflict}
      <SettingsGroup
        title="模型服务"
        meta={
          <Button variant="outline" icon={PlusGlyph} onClick={addService} disabled={!data}>
            {SERVICE_FORM.title}
          </Button>
        }>
        {notice}
        {!data ? (
          !error && (
            <div className="settings-row">
              <Loading label="正在读取模型服务…" />
            </div>
          )
        ) : data.providers.length === 0 ? (
          <SettingsRow title="还没有模型服务" />
        ) : (
          data.providers.map(provider =>
            isSupported(provider) ? (
              <ObjectRow
                key={provider.id}
                className="provider-row"
                label={`编辑 ${provider.name}`}
                leading={<ProviderTile provider={provider} size={24} />}
                dim={!provider.enabled}
                title={
                  <span className="settings-row-name">
                    {provider.name}
                    {data.presets.find(preset => preset.id === provider.presetId)?.requiresKey === false && (
                      <span className="settings-row-note">本地</span>
                    )}
                    {defaultProvider === provider.id && <span className="settings-row-note">默认</span>}
                  </span>
                }
                description={`${providerKindLabels[provider.kind]} · ${provider.models.length} 个模型`}
                onOpen={() => {
                  setSelection({ kind: 'provider', id: provider.id })
                }}
                trailing={
                  <>
                    <HealthLine health={provider.health} />
                    <ServiceStatus
                      provider={provider}
                      presets={data.presets}
                      health={health[provider.id]}
                      computer={computer}
                      keyBlocked={keyBlocked}
                      onUpdateKey={() => {
                        setKeyFor(provider)
                      }}
                    />
                    <Menu
                      label={`${provider.name} 的操作`}
                      align="end"
                      sections={[
                        {
                          id: 'service',
                          items: [
                            {
                              id: 'edit',
                              label: '编辑…',
                              icon: EditGlyph,
                              onSelect: () => {
                                setSelection({ kind: 'provider', id: provider.id })
                              },
                            },
                            {
                              id: 'key',
                              label: '更新密钥…',
                              icon: KeyRound,
                              ...(keyBlocked === undefined ? {} : { disabledReason: keyBlocked }),
                              onSelect: () => {
                                setKeyFor(provider)
                              },
                            },
                            {
                              id: 'models',
                              label: '刷新模型列表',
                              icon: ListRestart,
                              onSelect: () => {
                                setSelection({ kind: 'provider', id: provider.id, fetch: true })
                              },
                            },
                          ],
                        },
                        {
                          id: 'danger',
                          items: [
                            {
                              id: 'remove',
                              label: '移除…',
                              icon: TrashGlyph,
                              danger: true,
                              onSelect: () => {
                                setRemoving(provider)
                              },
                            },
                          ],
                        },
                      ]}
                      trigger={moreButton(`${provider.name} 的操作`)}
                    />
                  </>
                }
              />
            ) : (
              <ObjectRow
                key={provider.id}
                className="provider-row"
                label={provider.name}
                leading={<ProviderTile provider={{ id: provider.id, kind: 'plugin' }} size={24} />}
                dim
                title={<span className="settings-row-name">{provider.name}</span>}
                description="不再支持"
                trailing={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setRemoving(provider)
                    }}>
                    移除…
                  </Button>
                }
              />
            ),
          )
        )}
      </SettingsGroup>
      {external.length > 0 && (
        <SettingsGroup title="其他来源">
          {external.map(provider => (
            <SettingsRow
              key={provider.id}
              className="provider-row is-static"
              leading={<ProviderTile provider={provider} size={24} />}
              record
              title={
                <span className="settings-row-name">
                  {provider.name}
                  {provider.kind === 'demo' && <DemoMark compact />}
                </span>
              }
              description={provider.kind === 'demo' ? '本地脚本回复' : '由插件提供'}
            />
          ))}
        </SettingsGroup>
      )}
      {data && access.local && access.admin && (
        <ConfirmedAddresses providers={data.providers} revision={(data.confirmedAddresses ?? []).join('\n')} onChanged={changed} />
      )}
      {snapshot.catalog && <ModelVisibilitySettings catalog={snapshot.catalog} />}
      {snapshot.catalog?.features?.usage && <UsageSettings catalog={snapshot.catalog} reads={reads} />}
      <Dialog
        open={adding !== null && !!data}
        size="lg"
        title={SERVICE_FORM.title}
        onClose={closeAdd}
        footer={
          adding?.preset ? (
            <div ref={setSheetFooter} className="provider-sheet-footer" />
          ) : (
            <Button size="md" onClick={closeAdd}>
              取消
            </Button>
          )
        }>
        {data && adding && (
          <ProviderAddContent
            preset={adding.preset}
            data={data}
            abilities={abilities}
            computer={computer}
            footer={sheetFooter}
            committing={addCommitting}
            onPick={preset => setAdding({ preset })}
            onConfirmed={changed}
            onSaved={() => {
              setAdding(null)
              changed()
            }}
            onCancel={closeAdd}
            onBusy={setAddCommitting}
          />
        )}
      </Dialog>
      <FieldDialog
        open={keyFor !== null}
        title={keyFor?.hasKey ? '更新密钥' : '设置密钥'}
        subtitle={keyFor && keyScopeOf(keyFor.baseURL) ? `密钥只发往 ${shownAddress(keyScopeOf(keyFor.baseURL)!)}` : undefined}
        label={SERVICE_FORM.key}
        type="password"
        placeholder="输入密钥"
        hint={PROVIDER_COPY.keyHeld.label}
        confirmLabel={keyFor && isUnconfirmed(keyFor) && abilities.confirm ? '用 Touch ID 保存' : '保存'}
        onSubmit={async value => {
          if (!keyFor || keyBlocked !== undefined || !keyScopeOf(keyFor.baseURL)) return keyBlocked ?? '请核对当前服务地址。'
          try {
            await updateProvider(keyFor, {
              apiKey: value,
              ...(isUnconfirmed(keyFor) && abilities.confirm ? { confirmOrigin: true } : {}),
            })
            recheck(keyFor.id)
            changed()
            return ''
          } catch (cause) {
            onTargetError(cause)
            return inlineError(cause)
          }
        }}
        onClose={() => {
          setKeyFor(null)
        }}
      />
      {removing && (
        <ConfirmDialog
          title={`移除「${removing.name}」？`}
          danger
          confirmLabel="移除"
          message="它保存的密钥一起删除；正在使用它的会话要换用其他模型。"
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            try {
              await api(`providers/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new MessageError(errorMessage(cause), { cause })
            }
            deleted()
          }}
        />
      )}
    </>
  )

  const levels: SettingsLevel[] = []
  if (selected && data)
    levels.push({
      key: `provider:${selected.id}`,
      title: selected.name,
      onBack: () => {
        setSelection(null)
      },
      content: (
        <>
          {notice}
          {conflict}
          <ProviderPage
            key={JSON.stringify([selected.id, selected.kind, selected.baseURL])}
            configReady={readConfig}
            targetBlocked={targetBlocked}
            onTargetError={onTargetError}
            admin={access.admin}
            supportsAttachments={snapshot.catalog?.features?.attachments === true}
            provider={selected}
            data={data}
            abilities={abilities}
            isDefault={defaultProvider === selected.id}
            checkOnOpen={selection?.kind === 'provider' && selection.check === true}
            fetchOnOpen={selection?.kind === 'provider' && selection.fetch === true}
            computer={computer}
            onProbed={failure => {
              report(selected.id, failure)
            }}
            onSaved={provider => {
              saved(provider)
            }}
            onDeleted={deleted}
          />
        </>
      ),
    })

  return <SettingsPages main={main} levels={levels} />
}
