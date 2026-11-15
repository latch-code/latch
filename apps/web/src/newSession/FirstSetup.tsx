import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  pairRoute,
  type AgentPresetSettings,
  type AppSnapshot,
  type FirstSetupStatus,
  type ModelRef,
  type SessionDefaults,
} from '@latch/protocol'
import { Button, CheckGlyph, Collapse, Icon, InlineNotice, Modal, ValuePicker } from '@latch/ui'
import { api, inlineError, isUncertain, newRequestId } from '../core/api.ts'
import { shellFolders } from '../core/shell.ts'
import { saveOfferedPreset } from '../core/offeredHarness.ts'
import { providerAddition } from '../core/providerAddition.ts'
import { readStorage } from '../core/storageKeys.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { useViewport } from '../breakpoints.ts'
import { findProvider, harnessName, sameModel, serviceModels, thinkingLevels } from '../composerChoice.ts'
import { HarnessLoginSteps, useLoginStatus } from '../components/HarnessLogin.tsx'
import { MarkTile } from '../components/BrandTile.tsx'
import { BrandMark } from '../components/ui.tsx'
import { AgentSetupPanel, ProviderSetupPanel } from '../components/SetupPanels.tsx'
import { HistoryImportEntry } from '../history/HistoryImport.tsx'
import { PairingSheet } from '../settings/devices/PairingSheet.tsx'
import { loginSurface } from '../panel/terminal/loginRuns.ts'

type Finish = { status: 'completed' | 'deferred'; requestId: string }
type PickDefaults = Partial<Pick<SessionDefaults, 'workspaceId' | 'harnessId' | 'gateway' | 'pinned'>> & { model?: ModelRef | null }
type PickAttempt = { requestId: string; defaults?: PickDefaults }
type SavedChoice = { defaults: SessionDefaults; instanceId: string; revision: number }
/** A page can close while awaiting its receipt. A new device or Host cannot reuse the request. */
const pending = new Map<string, Finish>()
const storageKey = (identity: string) => `latch.first-setup.${identity}`
const pickKey = (identity: string) => `latch.first-setup-choice.${identity}`
const pendingChoices = new Map<string, PickAttempt>()

function pendingChoice(identity: string): PickAttempt | undefined {
  const active = pendingChoices.get(identity)
  if (active) return active
  const requestId = readStorage('localStorage', pickKey(identity))
  return requestId && /^[A-Za-z0-9_-]{8,128}$/u.test(requestId) ? { requestId } : undefined
}

function keepChoice(identity: string, attempt?: PickAttempt): void {
  if (attempt) pendingChoices.set(identity, attempt)
  else pendingChoices.delete(identity)
  try {
    if (attempt) localStorage.setItem(pickKey(identity), attempt.requestId)
    else localStorage.removeItem(pickKey(identity))
  } catch {
    // The same request remains available in this window.
  }
}

function pendingFinish(identity: string): Finish | undefined {
  const active = pending.get(identity)
  if (active) return active
  const text = readStorage('localStorage', storageKey(identity))
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Partial<Finish> | null
    if (
      value
      && (value.status === 'completed' || value.status === 'deferred')
      && typeof value.requestId === 'string'
      && /^[A-Za-z0-9_-]{8,128}$/u.test(value.requestId)
    )
      return { status: value.status, requestId: value.requestId }
  } catch {
    return undefined
  }
}

function keepFinish(identity: string, attempt?: Finish): void {
  if (attempt) pending.set(identity, attempt)
  else pending.delete(identity)
  try {
    if (attempt) localStorage.setItem(storageKey(identity), JSON.stringify(attempt))
    else localStorage.removeItem(storageKey(identity))
  } catch {
    // The attempt is still held in this window's memory.
  }
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="first-setup-group" aria-label={title}>
      <h2>{title}</h2>
      <div className="first-setup-group-body">{children}</div>
    </section>
  )
}

function Ready() {
  return (
    <span className="first-setup-ready">
      <Icon icon={CheckGlyph} size={14} />
      已就绪
    </span>
  )
}

export function FirstSetup({
  snapshot,
  access,
  manual,
  onExit,
  onChanged,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  manual: boolean
  onExit: (finished?: boolean) => void
  onChanged: () => Promise<void>
}) {
  const phone = useViewport() === 'phone'
  const identity = JSON.stringify([snapshot.host.hostId, snapshot.device.id])
  const catalog = snapshot.catalog
  const defaults = catalog?.defaults
  const [presets, setPresets] = useState<AgentPresetSettings[] | null>(null)
  const [scan, setScan] = useState(0)
  const [more, setMore] = useState(false)
  const [agentForm, setAgentForm] = useState<string>()
  const [providerForm, setProviderForm] = useState(() => providerAddition(identity) !== undefined)
  const [providerWriting, setProviderWriting] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pickError, setPickError] = useState('')
  const [projectError, setProjectError] = useState('')
  const [agentError, setAgentError] = useState('')
  const [finishError, setFinishError] = useState('')
  const [held, setHeld] = useState(() => pendingFinish(identity))
  const [heldChoice, setHeldChoice] = useState(() => pendingChoice(identity))
  const [selected, setSelected] = useState<SavedChoice>()
  const effective =
    selected?.instanceId === snapshot.instanceId && selected.revision > (snapshot.revision ?? -1) ? selected.defaults : defaults
  const harness = catalog?.harnesses.find(item => item.id === effective?.harnessId && !item.offer)
  const latchModels = harness?.capabilities.models.owner === 'latch'
  const gateway = effective?.gateway ?? undefined
  const unavailable = latchModels ? effective?.modelUnavailable === true : effective?.gatewayUnavailable === true
  const picked = unavailable ? undefined : latchModels ? effective?.model : gateway
  const checkLogin = harness?.status === 'ready' && !latchModels && !gateway && !unavailable
  const login = useLoginStatus(harness, checkLogin)
  const nativeReady = checkLogin && login.status === 'authenticated' && (!login.expiresAt || Date.parse(login.expiresAt) > Date.now())
  const projects = catalog?.workspaces.filter(project => project.id !== 'default' && !project.unavailable) ?? []
  const projectId = projects.find(project => project.id === effective?.workspaceId)?.id
  const folders = shellFolders()
  const choosing = useRef(false)
  const agents = catalog?.harnesses.filter(item => !item.offer) ?? []
  const offered = catalog?.harnesses.filter(item => item.offer && item.status === 'ready') ?? []

  useEffect(() => {
    const controller = new AbortController()
    api<{ presets: AgentPresetSettings[] }>('agents', { signal: controller.signal }).then(
      result => {
        if (!controller.signal.aborted) setPresets(result.presets)
      },
      error => {
        if (!controller.signal.aborted) setAgentError(inlineError(error))
      },
    )
    return () => controller.abort()
  }, [scan])

  const providers = (catalog?.providers ?? []).filter(provider => {
    if (!harness || provider.kind === 'demo') return false
    const route = pairRoute(harness.capabilities, provider)
    return route.kind === 'direct' || route.kind === 'passthrough' || route.kind === 'translate'
  })
  const choices = providers.flatMap(provider => serviceModels(provider).map(model => ({ providerId: provider.id, model })))
  const chosen = choices.find(model => model.providerId === picked?.providerId && model.model === picked?.model)
  const ready = harness?.status === 'ready' && (chosen !== undefined || nativeReady)
  const levels = catalog && latchModels ? thinkingLevels(catalog, chosen) : []
  const own = 'own'
  const modelValue = chosen ? JSON.stringify([chosen.providerId, chosen.model]) : latchModels || unavailable ? '' : own
  const blocked = busy || providerWriting || held !== undefined || heldChoice !== undefined

  const saveChoice = async (attempt: PickAttempt, readOnly: boolean) => {
    if (choosing.current) return
    choosing.current = true
    setBusy(true)
    setPickError('')
    keepChoice(identity, attempt)
    try {
      const result = readOnly
        ? await api<({ state: 'saved' } & SavedChoice) | { state: 'unknown' }>(`first-setup/choices/${attempt.requestId}`)
        : {
            state: 'saved' as const,
            ...(await api<SavedChoice>('preferences', {
              method: 'PUT',
              body: { defaults: attempt.defaults, setupRequestId: attempt.requestId },
            })),
          }
      if (result.state === 'unknown') {
        setHeldChoice(attempt)
        setPickError('结果未确认。')
        return
      }
      keepChoice(identity)
      setHeldChoice(undefined)
      setSelected(result)
      await onChanged()
    } catch (error) {
      if (readOnly || isUncertain(error)) {
        setHeldChoice(attempt)
        setPickError('保存结果未确认。')
      } else {
        keepChoice(identity)
        setHeldChoice(undefined)
        setPickError(inlineError(error))
      }
    } finally {
      choosing.current = false
      setBusy(false)
    }
  }
  const select = (defaults: PickDefaults) => saveChoice({ requestId: newRequestId(), defaults }, false)
  const setModel = (model: ModelRef | null) => {
    if (!harness) return
    if (latchModels) {
      if (
        model
        && picked?.providerId === model.providerId
        && picked.model === model.model
        && picked.effort
        && levels.includes(picked.effort)
      )
        model = { ...model, effort: picked.effort }
      return select({ harnessId: harness.id, model, pinned: true })
    }
    return select({ harnessId: harness.id, gateway: model, pinned: true })
  }

  const enable = async (id: string, presetId: string | undefined) => {
    setBusy(true)
    setAgentError('')
    try {
      if (await saveOfferedPreset(presetId)) await select({ harnessId: id, pinned: true })
      await onChanged()
    } catch (error) {
      setAgentError(isUncertain(error) ? '启用结果未确认，请重新检测。' : inlineError(error))
    } finally {
      setBusy(false)
    }
  }
  const addProject = async () => {
    if (!folders) return
    setBusy(true)
    setProjectError('')
    try {
      const result = await folders.pick()
      if (result.status === 'added') {
        const added = result.added[0]
        const refused = result.refused[0]
        await onChanged()
        if (added) await select({ workspaceId: added.workspaceId })
        if (refused) setProjectError(refused.message ?? '没有添加这个文件夹。')
      } else if (result.status === 'busy') setProjectError('另一个系统对话框还没结束。')
      else if (result.status === 'failed') setProjectError('没有确认文件夹是否已添加，请重新读取项目。')
    } catch (error) {
      setProjectError(inlineError(error))
    } finally {
      setBusy(false)
    }
  }

  const finish = async (attempt: Finish, readOnly = false) => {
    setBusy(true)
    setFinishError('')
    keepFinish(identity, attempt)
    try {
      const status = readOnly
        ? (await api<AppSnapshot>('snapshot')).firstSetup
        : (await api<{ status: FirstSetupStatus }>('first-setup', { method: 'PUT', body: attempt })).status
      if (status !== attempt.status && status !== 'completed') {
        setHeld(attempt)
        setFinishError('结果未确认。')
        return
      }
      keepFinish(identity)
      setHeld(undefined)
      await onChanged()
      onExit(true)
    } catch (error) {
      if (readOnly || isUncertain(error)) {
        setHeld(attempt)
        setFinishError('结果未确认。')
      } else {
        keepFinish(identity)
        setHeld(undefined)
        setFinishError(inlineError(error))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      label="准备这台电脑"
      variant="page"
      className="first-setup"
      onClose={() => onExit()}
      dismissible={manual && !busy && !providerWriting}>
      <div className="first-setup-content">
        <header>
          <BrandMark size={32} />
          <h1>准备这台电脑</h1>
        </header>
        <Group title="Harness 和模型">
          {agents.map(item => (
            <div className="first-setup-row" data-current-harness={item.id === harness?.id ? '' : undefined} key={item.id}>
              <span className="first-setup-label">
                <MarkTile mark={item.capabilities.display.mark} size={20} />
                {harnessName(item)}
              </span>
              {item.id === harness?.id ? (
                ready ? (
                  <Ready />
                ) : (
                  <span className="first-setup-meta">{item.status === 'ready' ? '需要配置' : (item.statusMessage ?? '暂不可用')}</span>
                )
              ) : (
                <Button
                  size="sm"
                  disabled={blocked || item.status !== 'ready'}
                  onClick={() => void select({ harnessId: item.id, pinned: true })}>
                  使用
                </Button>
              )}
            </div>
          ))}
          {offered.map(item => (
            <div className="first-setup-row" key={item.id}>
              <span className="first-setup-label">
                <MarkTile mark={item.capabilities.display.mark} size={20} />
                {harnessName(item)}
                <span className="first-setup-meta">已找到</span>
              </span>
              <Button size="sm" disabled={blocked} onClick={() => void enable(item.id, item.offer?.presetId)}>
                启用
              </Button>
            </div>
          ))}
          <div className="first-setup-row">
            <Button variant="ghost" size="sm" aria-expanded={more} onClick={() => setMore(value => !value)}>
              更多 Harness
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={blocked}
              onClick={() => {
                setAgentError('')
                setScan(value => value + 1)
                void onChanged()
              }}>
              重新检测
            </Button>
          </div>
          {more && (
            <div className="first-setup-inset">
              {presets
                ?.filter(preset => ![...agents, ...offered].some(item => item.capabilities.display.mark === preset.id))
                .map(preset => (
                  <div key={preset.id}>
                    <div className="first-setup-row">
                      <span className="first-setup-label">
                        <MarkTile mark={preset.id} size={20} />
                        {preset.name}
                      </span>
                      <Button
                        size="sm"
                        disabled={blocked}
                        aria-expanded={agentForm === preset.id}
                        onClick={() => setAgentForm(agentForm === preset.id ? undefined : preset.id)}>
                        {preset.detected?.found ? '查看' : '怎么安装'}
                      </Button>
                    </div>
                    {agentForm === preset.id && (
                      <AgentSetupPanel
                        preset={preset}
                        canAdd={preset.detected?.found === true && !preset.detected.outdated}
                        onBack={() => setAgentForm(undefined)}
                        onRecheck={async () => {
                          setScan(value => value + 1)
                          await onChanged()
                        }}
                        onAdded={agent => {
                          setAgentForm(undefined)
                          void select({ harnessId: agent.id, pinned: true })
                        }}
                      />
                    )}
                  </div>
                ))}
              {!presets && !agentError && <p role="status">正在检测这台电脑上的 Harness…</p>}
            </div>
          )}
          {agentError && <InlineNotice tone="error">{agentError}</InlineNotice>}
          {harness && (
            <div className="first-setup-row">
              <span className="first-setup-label">模型</span>
              {choices.length > 0 && (
                <ValuePicker
                  label="模型"
                  value={modelValue}
                  options={[
                    ...(!latchModels ? [{ value: own, label: '使用 Harness 登录' }] : []),
                    ...choices.map(model => ({
                      value: JSON.stringify([model.providerId, model.model]),
                      label: `${model.model} · ${findProvider(catalog, model.providerId)?.name ?? model.providerId}`,
                    })),
                  ]}
                  disabled={blocked}
                  onValueChange={value => {
                    const model = choices.find(item => JSON.stringify([item.providerId, item.model]) === value)
                    if (value === own || model) void setModel(model ?? null)
                  }}
                />
              )}
              <Button size="sm" disabled={blocked} aria-expanded={providerForm} onClick={() => setProviderForm(value => !value)}>
                添加模型服务
              </Button>
            </div>
          )}
          {unavailable && <InlineNotice tone="error">原来选择的模型服务暂不可用，请重新选择。</InlineNotice>}
          {levels.length > 0 && chosen && (
            <div className="first-setup-row">
              <span className="first-setup-label">思考深度</span>
              <ValuePicker
                label="思考深度"
                value={picked?.effort ?? ''}
                disabled={blocked}
                options={[{ value: '', label: '模型默认' }, ...levels.map(level => ({ value: level, label: level }))]}
                onValueChange={effort => {
                  const model = { ...chosen, ...(effort ? { effort } : {}) }
                  if (!sameModel(model, picked)) void select({ model, pinned: true })
                }}
              />
            </div>
          )}
          {checkLogin && !nativeReady && (
            <div className="first-setup-inset">
              <p role="status">{login.status === 'unauthenticated' ? '需要登录' : '登录状态尚未确认'}</p>
              {harness?.login && (
                <HarnessLoginSteps
                  harnessId={harness.id}
                  login={harness.login}
                  surface={loginSurface(catalog?.features)}
                  onCheck={() => login.check(true)}
                />
              )}
            </div>
          )}
          {pickError && <InlineNotice tone="error">{pickError}</InlineNotice>}
          {heldChoice && (
            <div className="first-setup-row" role="group" aria-label="未确认的配置">
              <Button disabled={busy} onClick={() => void saveChoice(heldChoice, true)}>
                核对选择
              </Button>
              {heldChoice.defaults && (
                <Button disabled={busy} onClick={() => void saveChoice(heldChoice, false)}>
                  重试同一选择
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  keepChoice(identity)
                  setHeldChoice(undefined)
                  setPickError('')
                  void onChanged()
                }}>
                放下这次选择
              </Button>
            </div>
          )}
          <Collapse open={providerForm} lazy>
            <div className="first-setup-inset">
              <ProviderSetupPanel
                access={access}
                additionOwner={identity}
                onBusy={setProviderWriting}
                onCancel={() => setProviderForm(false)}
                onSaved={model => {
                  setProviderForm(false)
                  void setModel(model)
                }}
              />
            </div>
          </Collapse>
        </Group>
        <Group title="项目和已有会话">
          <div className="first-setup-row">
            <span className="first-setup-label">{projects.length ? `${projects.length} 个可用项目` : '还没有添加项目'}</span>
            {folders && (
              <Button size="sm" onClick={() => void addProject()} disabled={blocked}>
                选择文件夹
              </Button>
            )}
          </div>
          {projectError && <InlineNotice tone="error">{projectError}</InlineNotice>}
          {projects.length > 0 && (
            <div className="first-setup-row">
              <ValuePicker
                label="默认项目"
                value={projectId ?? 'default'}
                disabled={blocked}
                options={[
                  { value: 'default', label: '不设默认项目' },
                  ...projects.map(project => ({ value: project.id, label: project.name })),
                ]}
                onValueChange={workspaceId => void select({ workspaceId })}
              />
              {projectId && (
                <HistoryImportEntry snapshot={snapshot} workspaceId={projectId} phone={phone} showCount onOpen={() => void onChanged()} />
              )}
            </div>
          )}
        </Group>
        <Group title="手机">
          <div className="first-setup-row">
            <span className="first-setup-label">
              连接手机<span className="first-setup-meta">可选</span>
            </span>
            {snapshot.host.native?.enabled && (
              <Button size="sm" disabled={blocked} onClick={() => setPairing(true)}>
                设置连接
              </Button>
            )}
          </div>
        </Group>
        <footer className="first-setup-actions">
          {finishError && <InlineNotice tone="error">{finishError}</InlineNotice>}
          {held ? (
            <>
              <Button onClick={() => void finish(held, true)} disabled={busy}>
                核对结果
              </Button>
              <Button variant="primary" onClick={() => void finish(held)} loading={busy}>
                重试同一请求
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={blocked}
                onClick={() => (manual ? onExit() : void finish({ status: 'deferred', requestId: newRequestId() }))}>
                {manual ? '关闭准备页' : '稍后配置'}
              </Button>
              <Button
                variant="primary"
                disabled={!ready || blocked}
                loading={busy}
                onClick={() => void finish({ status: 'completed', requestId: newRequestId() })}>
                开始使用 Latch
              </Button>
            </>
          )}
        </footer>
      </div>
      {pairing && <PairingSheet snapshot={snapshot} onClose={() => setPairing(false)} onChanged={() => void onChanged()} />}
    </Modal>
  )
}
