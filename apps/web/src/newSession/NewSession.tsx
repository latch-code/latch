import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { PlugZap, RefreshCw, TriangleAlert } from 'lucide-react'
import { AGENT_PRESETS, type AgentPresetSettings, type ModelRef } from '@latch/protocol'
import { Button, Collapse, CopyButton, ICON_STROKE } from '@latch/ui'
import { api } from '../core/api.ts'
import { foundWithoutAdapter } from '../core/agentDetection.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { ProviderSetupPanel } from '../components/SetupPanels.tsx'
import type { StartBlock } from '../composerChoice.ts'
import { MarkTile } from '../components/BrandTile.tsx'
import { SETUP_COPY } from '../core/securityCopy.ts'

/**
 * Why a session cannot start and the one thing that fixes it, each said plainly. A missing model service is added right
 * here: the card opens the same small panel as the model control's 「添加模型服务…」. Anything else goes to settings.
 */
export function SetupCard({
  block,
  owner,
  onSetup,
  providers,
  triggerRef,
}: {
  block: StartBlock
  owner: boolean
  onSetup: () => void
  /** Adding a model service in place, for a missing one: this device's access and what to do once one is saved. */
  providers?: { access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>; onSaved: (model: ModelRef) => void; onSettings: () => void }
  triggerRef?: RefObject<HTMLButtonElement | null>
}) {
  const model = block.kind === 'model-required'
  const held = block.kind === 'model-required' ? block : undefined
  const [adding, setAdding] = useState(false)
  const settable = held?.settable !== false
  const inPlace = model && settable && owner && providers !== undefined && held?.action === undefined
  return (
    <div className="setup-card" role="status">
      <div className="setup-card-row">
        <span className="setup-card-icon" aria-hidden="true">
          {model ? <PlugZap size={16} strokeWidth={ICON_STROKE[16]} /> : <TriangleAlert size={16} strokeWidth={ICON_STROKE[16]} />}
        </span>
        <div className="setup-card-text">
          <strong>{block.message}</strong>
          <p>
            {model
              ? owner
                ? (held?.hint ?? 'Latch 内置要先连一个模型服务才能开始。Latch 内置只能读写项目里的文件，不能运行命令。')
                : SETUP_COPY.modelNeedsAdmin
              : owner
                ? '可在设置中检查 Harness 与插件。'
                : SETUP_COPY.harnessNeedsAdmin}
          </p>
        </div>
        {owner && settable && !adding && (
          <Button
            ref={triggerRef}
            variant="primary"
            onClick={() => {
              if (inPlace) setAdding(true)
              else onSetup()
            }}>
            {model ? (held?.action ?? '添加模型服务') : '打开设置'}
          </Button>
        )}
      </div>
      {inPlace && (
        <Collapse open={adding} lazy>
          <div className="setup-card-panel">
            <ProviderSetupPanel
              access={providers.access}
              onCancel={() => {
                setAdding(false)
              }}
              onSettings={providers.onSettings}
              onSaved={saved => {
                setAdding(false)
                providers.onSaved(saved)
              }}
            />
          </div>
        </Collapse>
      )}
    </div>
  )
}

function InstallRow({ preset, note }: { preset: AgentPresetSettings; note?: string }) {
  return (
    <li className="harness-install-row">
      <span className="harness-install-name">
        <MarkTile mark={preset.id} size={16} />
        {preset.name}
      </span>
      {note && <span className="harness-install-note">{note}</span>}
      <span className="harness-install-command">
        <code>{preset.install}</code>
        {preset.install && <CopyButton text={preset.install} label={`复制 ${preset.name} 的安装命令`} size="xs" />}
        {preset.installNote && <span className="harness-install-note">{preset.installNote}</span>}
      </span>
    </li>
  )
}

/**
 * Nothing that can run a session was found on this computer: what to install, and a way to look again. The Host looks
 * by itself as well, so one installed meanwhile takes over without this button. Latch 内置 stays one quiet line, since
 * it needs a model service and cannot run commands.
 */
export function HarnessInstallCard({
  access,
  onRecheck,
  onSettings,
  onSaved,
}: {
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  onRecheck: () => Promise<void>
  onSettings: () => void
  onSaved: (model: ModelRef) => void
}) {
  const [presets, setPresets] = useState<AgentPresetSettings[]>(AGENT_PRESETS)
  const [checking, setChecking] = useState(false)
  const [adding, setAdding] = useState(false)
  // Reading them makes the Host look again, which is what a person pressing the button or arriving here wants.
  const look = async () => {
    const reply = await api<{ presets: AgentPresetSettings[] }>('agents').catch(() => undefined)
    if (reply) setPresets(reply.presets)
  }
  useEffect(() => {
    void look()
  }, [])
  const halfway = presets.filter(preset => foundWithoutAdapter(preset.detected) !== undefined)
  const others = presets.filter(preset => !halfway.includes(preset))
  return (
    <section className="setup-card harness-install" aria-label="安装 Harness">
      <div className="setup-card-text">
        <strong>{halfway.length ? '还差一步' : '没有找到可用的 Harness'}</strong>
      </div>
      {halfway.length > 0 && (
        <ul className="harness-install-list">
          {halfway.map(preset => (
            <InstallRow
              key={preset.id}
              preset={preset}
              note={`找到了 ${foundWithoutAdapter(preset.detected)!}，还差让 Latch 连接它的适配器`}
            />
          ))}
        </ul>
      )}
      <div className="harness-install-group">
        <p>{halfway.length ? '或者装别的：' : '先装一个：'}</p>
        <ul className="harness-install-list">
          {others.map(preset => (
            <InstallRow key={preset.id} preset={preset} />
          ))}
        </ul>
      </div>
      <div className="harness-install-foot">
        <Button
          size="sm"
          icon={RefreshCw}
          loading={checking}
          onClick={() => {
            setChecking(true)
            void Promise.all([look(), onRecheck()]).finally(() => {
              setChecking(false)
            })
          }}>
          重新检测
        </Button>
        {!adding && (
          <Button
            variant="link"
            size="sm"
            className="harness-install-builtin"
            onClick={() => {
              setAdding(true)
            }}>
            也可以用 Latch 内置：只能读写文件，不能运行命令，要先添加模型。
          </Button>
        )}
      </div>
      <Collapse open={adding} lazy>
        <div className="setup-card-panel">
          <ProviderSetupPanel
            access={access}
            onCancel={() => {
              setAdding(false)
            }}
            onSettings={onSettings}
            onSaved={saved => {
              setAdding(false)
              onSaved(saved)
            }}
          />
        </div>
      </Collapse>
    </section>
  )
}

/** The new-session page: the question, centred on its ink, then the input. No cards, no hints, no background. */
export function NewSession({ title, composer, setup }: { title: ReactNode; composer: ReactNode; setup?: ReactNode }) {
  return (
    <div className="new-session">
      <div className="new-session-inner">
        <h2 className="new-session-title">{title}</h2>
        {setup}
        <div>{composer}</div>
      </div>
    </div>
  )
}
