import { useState, type ReactNode, type RefObject } from 'react'
import { PlugZap, TriangleAlert } from 'lucide-react'
import type { HostCatalog, ModelRef } from '@latch/protocol'
import { Button, Collapse, ICON_STROKE } from '@latch/ui'
import type { DeviceAccess } from '../core/permissions.ts'
import { ProviderSetupPanel } from '../components/SetupPanels.tsx'
import { engineEntries, LATCH_ENGINE_LIMIT, type ComposerChoice, type StartBlock } from '../composerChoice.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
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
  block: Exclude<StartBlock, { kind: 'engine-required' }>
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
                ? (held?.hint ?? `Latch 内置要先连一个模型服务才能开始。${LATCH_ENGINE_LIMIT}`)
                : SETUP_COPY.modelNeedsAdmin
              : owner
                ? '可在设置中检查引擎与插件。'
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

/**
 * A device's first session, with more than one engine to run on: it asks, once. None is marked or preselected, since most
 * engines are not limited by Latch; the answer is remembered on this device and changes in the model control.
 */
export function EngineQuestion({
  catalog,
  access,
  choice,
  onChoice,
}: {
  catalog: HostCatalog
  access: Pick<DeviceAccess, 'legacy' | 'local'>
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
}) {
  const entries = engineEntries(catalog, access, choice.workspaceId)
  return (
    <section className="setup-card engine-question" aria-label="选择引擎">
      <div className="setup-card-text">
        <strong>这台设备先用哪个引擎？</strong>
        <p>{LATCH_ENGINE_LIMIT}其他引擎由它们自己决定权限，Latch 不限制它们，开始时要在 Mac 上确认。</p>
      </div>
      <div className="engine-question-options">
        {entries.map(entry => (
          <Button
            key={entry.harness.id}
            size="sm"
            disabled={entry.disabledReason !== undefined}
            tooltip={entry.disabledReason}
            onClick={() => {
              onChoice({ harnessId: entry.harness.id })
            }}>
            <HarnessTile harness={entry.harness} size={16} />
            {entry.label}
          </Button>
        ))}
      </div>
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
