import { useEffect, useState, type RefObject } from 'react'
import { PlugZap } from 'lucide-react'
import { AGENT_PRESETS, type AgentPresetSettings, type ModelRef } from '@latch/protocol'
import { Button, ChevronDownGlyph, Collapse, CopyButton, Hint, ICON_STROKE, Icon, RefreshGlyph, WarningGlyph } from '@latch/ui'
import { api } from '../core/api.ts'
import { foundWithoutAdapter, presetsFound } from '../core/agentDetection.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { harnessPresetCopy } from '../core/harnessPresetCopy.ts'
import { ProviderSetupPanel } from '../components/SetupPanels.tsx'
import type { StartBlock } from '../composerChoice.ts'
import { MarkTile } from '../components/BrandTile.tsx'
import { useComputerName } from '../components/Pickers.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { SETUP_COPY } from '../core/securityCopy.ts'
import { middleEllipsis } from '../format.ts'
import { TerminalFillButton } from '../components/TerminalFillButton.tsx'

const COPY = defineCopy(
  {
    filesOnly: 'Latch 内置只读写文件，不运行命令',
    addService: '添加模型服务',
    openSettings: '打开设置',
    copyCommand: (name: string, upgrade: boolean) => `复制 ${name} 的${upgrade ? '升级' : '安装'}命令`,
    install: '安装 Harness',
    almostReady: '还差一步',
    noneFound: '没有找到可用的 Harness',
    missingAdapter: (program: string) => `找到 ${program}，还缺适配器`,
    alternative: '或者装别的：',
    chooseOne: '先装一个：',
    recheck: '重新检测',
    useBuiltin: '改用 Latch 内置（只读写文件）…',
    upgradeHelp: '怎么升级',
    installHelp: '怎么装',
    helpFor: (word: string, name: string) => `${word} ${name}`,
    found: '找到的 Harness',
    foundCount: (count: number) => (
      <>
        在这台 Mac 上找到 <span className="harness-found-count">{formatNumber(count)}</span> 个 Harness
      </>
    ),
    needsUpgrade: '需要升级',
    detected: '已找到',
    needsAdapter: '缺适配器',
  },
  {
    filesOnly: 'Latch built-in reads and writes files. It cannot run commands.',
    addService: 'Add model service',
    openSettings: 'Open Settings',
    copyCommand: (name: string, upgrade: boolean) => `Copy ${name} ${upgrade ? 'upgrade' : 'install'} command`,
    install: 'Install a Harness',
    almostReady: 'One more step',
    noneFound: 'No available Harness found',
    missingAdapter: (program: string) => `Found ${program}. Its adapter is missing.`,
    alternative: 'Or install another',
    chooseOne: 'Install one to start',
    recheck: 'Check again',
    useBuiltin: 'Use Latch built-in (file access only)…',
    upgradeHelp: 'How to upgrade',
    installHelp: 'How to install',
    helpFor: (word: string, name: string) => `${word} ${name}`,
    found: 'Detected Harnesses',
    foundCount: (count: number) => (
      <>
        Found <span className="harness-found-count">{formatNumber(count)}</span> {count === 1 ? 'Harness' : 'Harnesses'} on this Mac
      </>
    ),
    needsUpgrade: 'Upgrade needed',
    detected: 'Detected',
    needsAdapter: 'Adapter missing',
  },
)

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
  // Only a device that cannot manage the Host is sent elsewhere, so only then is the computer's name read.
  const computer = useComputerName(!owner)
  return (
    <div className="setup-card" role="status">
      <div className="setup-card-row">
        <span className="setup-card-icon" aria-hidden="true">
          {model ? (
            <PlugZap size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} />
          ) : (
            <WarningGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} />
          )}
        </span>
        <div className="setup-card-text">
          <strong>{block.message}</strong>
          {/* The title and the button say what is missing; this line says only what the button cannot. */}
          {(model || !owner) && (
            <p>
              {model
                ? owner
                  ? (held?.hint ?? COPY.filesOnly)
                  : SETUP_COPY.modelNeedsAdmin(computer)
                : SETUP_COPY.harnessNeedsAdmin(computer)}
            </p>
          )}
        </div>
        {owner && settable && !adding && (
          <Button
            ref={triggerRef}
            variant="primary"
            onClick={() => {
              if (inPlace) setAdding(true)
              else onSetup()
            }}>
            {model ? (held?.action ?? COPY.addService) : COPY.openSettings}
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
  // A command that is here but too old gets its upgrade command instead of the install command.
  const upgrade = preset.detected?.outdated?.upgrade
  const command = upgrade ?? preset.install
  const { installNote } = harnessPresetCopy(preset)
  return (
    <li className="harness-install-row">
      <span className="harness-install-name">
        <MarkTile mark={preset.id} size={16} />
        {preset.name}
      </span>
      {note && <span className="harness-install-note">{note}</span>}
      <span className="harness-install-command">
        <code>{command}</code>
        {command && <CopyButton text={command} label={COPY.copyCommand(preset.name, !!upgrade)} size="xs" />}
        {command && <TerminalFillButton command={command} detached />}
        {!upgrade && installNote && <span className="harness-install-note">{installNote}</span>}
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
  const halfway = presets.filter(preset => foundWithoutAdapter(preset.detected) !== undefined || preset.detected?.outdated)
  const others = presets.filter(preset => !halfway.includes(preset))
  return (
    <section className="setup-card harness-install" aria-label={COPY.install}>
      <div className="setup-card-text">
        <strong>{halfway.length ? COPY.almostReady : COPY.noneFound}</strong>
      </div>
      {halfway.length > 0 && (
        <ul className="harness-install-list">
          {halfway.map(preset => (
            <InstallRow
              key={preset.id}
              preset={preset}
              note={preset.detected?.outdated?.need ?? COPY.missingAdapter(foundWithoutAdapter(preset.detected)!)}
            />
          ))}
        </ul>
      )}
      <div className="harness-install-group">
        <p>{halfway.length ? COPY.alternative : COPY.chooseOne}</p>
        <ul className="harness-install-list">
          {others.map(preset => (
            <InstallRow key={preset.id} preset={preset} />
          ))}
        </ul>
      </div>
      <div className="harness-install-foot">
        <Button
          size="sm"
          icon={RefreshGlyph}
          loading={checking}
          onClick={() => {
            setChecking(true)
            void Promise.all([look(), onRecheck()]).finally(() => {
              setChecking(false)
            })
          }}>
          {COPY.recheck}
        </Button>
        {!adding && (
          <Button
            variant="link"
            size="sm"
            className="harness-install-builtin"
            onClick={() => {
              setAdding(true)
            }}>
            {COPY.useBuiltin}
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

/** The way to install one preset, opened from its row: the command, copying it, and looking again. Nothing more. */
function HowToInstall({ preset, checking, onRecheck }: { preset: AgentPresetSettings; checking: boolean; onRecheck: () => void }) {
  const upgrade = preset.detected?.outdated?.upgrade
  const command = upgrade ?? preset.install
  if (!command) return null
  return (
    <div className="harness-found-how">
      <span className="harness-found-prompt" aria-hidden="true">
        $
      </span>
      <code>{command}</code>
      <span className="harness-found-how-actions">
        <CopyButton text={command} label={COPY.copyCommand(preset.name, !!upgrade)} size="xs" />
        <Button size="xs" variant="ghost" icon={RefreshGlyph} loading={checking} onClick={onRecheck}>
          {COPY.recheck}
        </Button>
      </span>
    </div>
  )
}

/**
 * The first open on this Mac with something found (J9): only what was found, each with the file the Host found, and one
 * that is half there with a short word, its detail on hover. 「已找到」 says only that an executable with that name is here:
 * the Host ran nothing, so it is not drawn as ready. What is not installed is listed in 设置 › Harness.
 */
export function FoundHarnessesCard({ onRecheck }: { onRecheck: () => Promise<void> }) {
  const [presets, setPresets] = useState<AgentPresetSettings[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [how, setHow] = useState<string | null>(null)
  // Folded to one line unless something found needs a step: the input under it stays the page's subject.
  const [open, setOpen] = useState<boolean | null>(null)
  // Reading them makes the Host look again, which is what arriving here or pressing 重新检测 wants.
  const look = async () => {
    const reply = await api<{ presets: AgentPresetSettings[] }>('agents').catch(() => undefined)
    if (reply) setPresets(reply.presets)
  }
  useEffect(() => {
    void look()
  }, [])
  const recheck = () => {
    setChecking(true)
    void Promise.all([look(), onRecheck()]).finally(() => {
      setChecking(false)
    })
  }
  if (!presets) return null
  const { found, halfway } = presetsFound(presets)
  // A Harness that is no preset can be what runs here; the card has nothing of its own to say then.
  if (!found.length) return null
  const howButton = (preset: AgentPresetSettings) => {
    const word = preset.detected?.outdated ? COPY.upgradeHelp : COPY.installHelp
    return (
      (preset.detected?.outdated || preset.install) && (
        <Button
          size="xs"
          aria-expanded={how === preset.id}
          aria-label={COPY.helpFor(word, preset.name)}
          onClick={() => {
            setHow(how === preset.id ? null : preset.id)
          }}>
          {word}
        </Button>
      )
    )
  }
  const howRow = (preset: AgentPresetSettings) => (
    <Collapse open={how === preset.id} lazy>
      <HowToInstall preset={preset} checking={checking} onRecheck={recheck} />
    </Collapse>
  )
  const halfRow = (preset: AgentPresetSettings, word: string, detail: string) => (
    <li key={preset.id} className="harness-found-row" data-halfway="">
      <MarkTile mark={preset.id} size={16} />
      <span className="harness-found-name">{preset.name}</span>
      <Hint className="harness-found-note" label={word}>
        {detail}
      </Hint>
      {howButton(preset)}
      {howRow(preset)}
    </li>
  )
  const shown = open ?? (halfway.length > 0 || found.some(({ preset }) => preset.detected?.outdated))
  return (
    <section className="harness-found" aria-label={COPY.found} data-open={shown ? '' : undefined}>
      <div className="harness-found-head">
        <button
          type="button"
          className="harness-found-toggle"
          aria-expanded={shown}
          onClick={() => {
            setOpen(!shown)
          }}>
          <strong>{COPY.foundCount(found.length)}</strong>
          <span className="harness-found-marks" aria-hidden="true">
            {found.map(({ preset }) => (
              <MarkTile key={preset.id} mark={preset.id} size={16} />
            ))}
          </span>
          <Icon icon={ChevronDownGlyph} size={12} className="harness-found-chevron" />
        </button>
        <Button size="xs" variant="ghost" icon={RefreshGlyph} loading={checking} onClick={recheck}>
          {COPY.recheck}
        </Button>
      </div>
      <Collapse open={shown}>
        <ul className="harness-found-list">
          {found.map(({ preset, path }) =>
            preset.detected?.outdated ? (
              halfRow(preset, COPY.needsUpgrade, preset.detected.outdated.need)
            ) : (
              <li key={preset.id} className="harness-found-row">
                <MarkTile mark={preset.id} size={16} />
                <span className="harness-found-name">{preset.name}</span>
                <span className="harness-found-state">{COPY.detected}</span>
                {path && (
                  <code className="harness-found-path" title={path}>
                    <VisibleText text={middleEllipsis(path, 56)} />
                  </code>
                )}
              </li>
            ),
          )}
          {halfway.map(({ preset, program }) => halfRow(preset, COPY.needsAdapter, COPY.missingAdapter(program)))}
        </ul>
      </Collapse>
    </section>
  )
}
