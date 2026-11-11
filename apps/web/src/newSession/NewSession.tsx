import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { ChevronRight, PlugZap, RefreshCw, TriangleAlert } from 'lucide-react'
import { AGENT_PRESETS, type AgentPresetSettings, type AppSnapshot, type ModelRef, type TaskSummary } from '@latch/protocol'
import { Button, Collapse, CopyButton, ICON_STROKE, Icon } from '@latch/ui'
import { api } from '../core/api.ts'
import { foundWithoutAdapter, presetsFound } from '../core/agentDetection.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { ProviderSetupPanel } from '../components/SetupPanels.tsx'
import type { StartBlock } from '../composerChoice.ts'
import { MarkTile } from '../components/BrandTile.tsx'
import { useComputerName } from '../components/Pickers.tsx'
import { taskHarness } from '../components/Sidebar.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { SETUP_COPY } from '../core/securityCopy.ts'
import { middleEllipsis, relativeTime } from '../format.ts'

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
          {model ? <PlugZap size={16} strokeWidth={ICON_STROKE[16]} /> : <TriangleAlert size={16} strokeWidth={ICON_STROKE[16]} />}
        </span>
        <div className="setup-card-text">
          <strong>{block.message}</strong>
          {/* The title and the button say what is missing; this line says only what the button cannot. */}
          {(model || !owner) && (
            <p>
              {model
                ? owner
                  ? (held?.hint ?? 'Latch 内置只读写文件，不运行命令')
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
            <InstallRow key={preset.id} preset={preset} note={`找到 ${foundWithoutAdapter(preset.detected)!}，还缺适配器`} />
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
            改用 Latch 内置（只读写文件）…
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
  if (!preset.install) return null
  return (
    <div className="harness-found-how">
      <span className="harness-found-prompt" aria-hidden="true">
        $
      </span>
      <code>{preset.install}</code>
      <span className="harness-found-how-actions">
        <CopyButton text={preset.install} label={`复制 ${preset.name} 的安装命令`} size="xs" />
        <Button size="xs" variant="ghost" icon={RefreshCw} loading={checking} onClick={onRecheck}>
          重新检测
        </Button>
      </span>
    </div>
  )
}

/**
 * The first open on this Mac with something found (J9): what was found first, each with the file the Host found, then
 * the half-way Codex, then the rest folded under one line. 「已找到」 says only that an executable with that name is here:
 * the Host ran nothing, so it is not drawn as ready or in green. Latch installs nothing; 「怎么装」 gives the command.
 */
export function FoundHarnessesCard({ onRecheck }: { onRecheck: () => Promise<void> }) {
  const [presets, setPresets] = useState<AgentPresetSettings[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [more, setMore] = useState(false)
  const [how, setHow] = useState<string | null>(null)
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
  const { found, halfway, more: rest } = presetsFound(presets)
  // A Harness that is no preset can be what runs here; the card has nothing of its own to say then.
  if (!found.length) return null
  const howButton = (preset: AgentPresetSettings) =>
    preset.install && (
      <Button
        size="xs"
        aria-expanded={how === preset.id}
        aria-label={`怎么装 ${preset.name}`}
        onClick={() => {
          setHow(how === preset.id ? null : preset.id)
        }}>
        怎么装
      </Button>
    )
  const howRow = (preset: AgentPresetSettings) => (
    <Collapse open={how === preset.id} lazy>
      <HowToInstall preset={preset} checking={checking} onRecheck={recheck} />
    </Collapse>
  )
  return (
    <section className="harness-found" aria-label="找到的 Harness">
      <div className="harness-found-head">
        <strong>
          在这台 Mac 上找到 <span className="harness-found-count">{found.length}</span> 个 Harness
        </strong>
        <Button size="xs" variant="ghost" icon={RefreshCw} loading={checking} onClick={recheck}>
          重新检测
        </Button>
      </div>
      <ul className="harness-found-list">
        {found.map(({ preset, path }) => (
          <li key={preset.id} className="harness-found-row">
            <MarkTile mark={preset.id} size={16} />
            <span className="harness-found-name">{preset.name}</span>
            <span className="harness-found-state">已找到</span>
            {path && (
              <code className="harness-found-path" title={path}>
                <VisibleText text={middleEllipsis(path, 56)} />
              </code>
            )}
          </li>
        ))}
        {halfway.map(({ preset, program }) => (
          <li key={preset.id} className="harness-found-row" data-halfway="">
            <MarkTile mark={preset.id} size={16} />
            <span className="harness-found-name">{preset.name}</span>
            <span className="harness-found-note">找到 {program}，还缺适配器</span>
            {howButton(preset)}
            {howRow(preset)}
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <>
          <button
            type="button"
            className="harness-found-fold"
            aria-expanded={more}
            onClick={() => {
              setMore(!more)
              setHow(null)
            }}>
            <Icon icon={ChevronRight} size={14} />
            还可以装 <span className="harness-found-count">{rest.length}</span> 个
          </button>
          <Collapse open={more} lazy>
            <ul className="harness-found-list">
              {rest.map(preset => (
                <li key={preset.id} className="harness-found-row" data-more="">
                  <MarkTile mark={preset.id} size={16} />
                  <span className="harness-found-name">{preset.name}</span>
                  <span className="harness-found-note">{preset.installNote}</span>
                  {howButton(preset)}
                  {howRow(preset)}
                </li>
              ))}
            </ul>
          </Collapse>
        </>
      )}
    </section>
  )
}

/** Under the input of a new session in a project: that project's latest sessions, each one click from opening. */
export function RecentSessions({
  snapshot,
  sessions,
  onOpen,
}: {
  snapshot: AppSnapshot
  sessions: readonly TaskSummary[]
  onOpen: (id: string) => void
}) {
  if (!sessions.length) return null
  const now = new Date()
  return (
    <section className="new-session-recent" aria-label="这个项目最近的会话">
      <h3>这个项目最近的会话</h3>
      <ul>
        {sessions.map(task => {
          const harness = taskHarness(snapshot, task)
          const title = task.title || '未命名会话'
          return (
            <li key={task.id}>
              <button
                type="button"
                className="new-session-recent-row"
                onClick={() => {
                  onOpen(task.id)
                }}>
                <MarkTile mark={harness.mark} size={16} />
                <span className="new-session-recent-title">
                  <span>{title}</span>
                  <span className="new-session-recent-harness">{harness.label}</span>
                </span>
                <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt, now)}</time>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * The new-session page: the question, centred on its ink, then the input, on a quiet dot grid that fades before it
 * reaches anything to read. On a first open what was found sits above the input; in a project its latest sessions
 * sit under it.
 */
export function NewSession({
  title,
  composer,
  setup,
  found,
  recent,
}: {
  title: ReactNode
  composer: ReactNode
  setup?: ReactNode
  found?: ReactNode
  recent?: ReactNode
}) {
  return (
    <div className="new-session">
      <div className="new-session-inner">
        <h2 className="new-session-title">{title}</h2>
        {found}
        {setup}
        <div>{composer}</div>
        {recent}
      </div>
    </div>
  )
}
