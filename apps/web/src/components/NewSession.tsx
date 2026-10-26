import { useState, type ReactNode, type RefObject } from 'react'
import { BookOpenText, ChevronRight, FileCheck, Laptop, PlugZap, ShieldAlert, Timer, TriangleAlert } from 'lucide-react'
import type { ModelRef, TaskMode } from '@latch/protocol'
import type { DeviceAccess } from '../core/permissions.ts'
import { ProviderSetupPanel } from './SetupPanels.tsx'
import type { StartBlock } from '../composerChoice.ts'
import { Button, Collapse, DemoMark, ICON_STROKE, Tooltip, type LucideIcon } from '@latch/ui'
import { SETUP_COPY } from '../core/securityCopy.ts'

interface Suggestion {
  title: string
  description: string
  prompt: string
  icon: LucideIcon
  modes: TaskMode[]
}

/** Prompts the built-in demo model recognizes; shown only while the Host runs in demo mode. */
const demoSuggestions: Suggestion[] = [
  { title: '阅读流式内容', description: 'Markdown、代码和长内容', prompt: '展示流式输出', icon: BookOpenText, modes: ['chat', 'agent'] },
  { title: '生成一份报告', description: '在手机上批准后写入文件', prompt: '批准生成验收报告', icon: FileCheck, modes: ['agent'] },
  { title: '运行一个长任务', description: '离线后接续，随时取消', prompt: '运行可取消长任务', icon: Timer, modes: ['agent'] },
]
const taskSuggestions: Suggestion[] = [
  {
    title: '梳理一个想法',
    description: '从目标、选择和下一步开始',
    prompt: '我想和你一起梳理一个想法。请先问我目标和当前遇到的问题。',
    icon: BookOpenText,
    modes: ['chat', 'agent'],
  },
  {
    title: '一起整理资料',
    description: '理清重点，形成清楚的说明',
    prompt: '我有一些资料想请你一起整理。请先问我资料是什么、打算给谁看，以及希望得到什么结果。',
    icon: FileCheck,
    modes: ['chat', 'agent'],
  },
  {
    title: '制定行动计划',
    description: '把目标拆成可执行的步骤',
    prompt: '请帮我把接下来的目标拆成一份行动计划。先和我确认目标、时间和现有条件。',
    icon: Timer,
    modes: ['chat', 'agent'],
  },
]

/**
 * Why a session cannot start and the one thing that fixes it. A missing model service is added right here: the card
 * opens the same small panel as the model picker's 「添加模型服务…」. Anything else goes to settings.
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
  const inPlace = model && owner && providers !== undefined && held?.action === undefined
  return (
    <div className="setup-card" role="status" data-ambient-avoid="surface">
      <div className="setup-card-row">
        <span className="setup-card-icon" aria-hidden="true">
          {model ? <PlugZap size={16} strokeWidth={ICON_STROKE[16]} /> : <TriangleAlert size={16} strokeWidth={ICON_STROKE[16]} />}
        </span>
        <div className="setup-card-text">
          <strong>{model ? '连接模型服务' : 'Harness 暂不可用'}</strong>
          <p>
            {block.message}{' '}
            {owner
              ? (held?.hint ?? (model ? '添加一个模型服务后即可开始。' : '可在设置中检查 Agent 与插件。'))
              : model
                ? SETUP_COPY.modelNeedsAdmin
                : SETUP_COPY.harnessNeedsAdmin}
          </p>
        </div>
        {owner && !adding && (
          <Button
            ref={triggerRef}
            variant="primary"
            data-ambient-avoid="accent"
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
 * The row under a new session's input: where it runs (this computer, the only one) and, for a full-access harness,
 * that level in amber with a way to the ceilings in 设置 › 电脑. Asking per step is the default and says nothing.
 */
export function ContextRow({ hostName, fullAccess, onComputer }: { hostName: string; fullAccess: boolean; onComputer?: () => void }) {
  return (
    <div className="composer-context">
      <Tooltip content="会话在这台电脑上运行">
        <span className="context-value">
          <Laptop size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <span className="sr-only">电脑：</span>
          {hostName}
        </span>
      </Tooltip>
      {fullAccess
        && (onComputer ? (
          <Tooltip content="电脑与权限上限…">
            <button
              type="button"
              className="context-value context-link"
              aria-label="权限：完全访问，查看电脑与权限上限"
              onClick={onComputer}>
              <ShieldAlert className="context-risk" size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
              完全访问
              <ChevronRight className="context-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            </button>
          </Tooltip>
        ) : (
          <span className="context-value">
            <ShieldAlert className="context-risk" size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            <span className="sr-only">权限：</span>
            完全访问
          </span>
        ))}
    </div>
  )
}

/** Suggestions only fill the draft; model output and execution still use the selected real harness. */
export function DemoSuggestions({ demo, mode, onSuggestion }: { demo: boolean; mode: TaskMode; onSuggestion: (prompt: string) => void }) {
  const suggestions = (demo ? demoSuggestions : taskSuggestions).filter(item => item.modes.includes(mode))
  if (suggestions.length === 0) return null
  return (
    <section className="suggestions" aria-label={demo ? '演示任务' : '任务灵感'} data-ambient-avoid="surface">
      {suggestions.map(item => (
        <button
          key={item.prompt}
          type="button"
          className="suggestion-card"
          onClick={() => {
            onSuggestion(item.prompt)
          }}>
          <item.icon size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span className="suggestion-title">
            {item.title}
            {demo && <DemoMark compact />}
          </span>
          <span className="suggestion-description">{item.description}</span>
        </button>
      ))}
    </section>
  )
}

export function NewSession({
  title,
  harnesses,
  onboarding,
  composer,
  setup,
  demo,
  mode,
  onSuggestion,
}: {
  title?: string
  harnesses?: ReactNode
  onboarding?: ReactNode
  composer: ReactNode
  setup?: ReactNode
  demo: boolean
  mode: TaskMode
  onSuggestion: (prompt: string) => void
}) {
  return (
    <div className="new-session">
      <div className="new-session-inner">
        <h2 className="new-session-title" data-ambient-anchor="" data-ambient-avoid="text">
          {title ?? '今天要做什么？'}
        </h2>
        {harnesses && (
          <div className="new-session-harnesses" data-ambient-avoid="surface">
            {harnesses}
          </div>
        )}
        {onboarding}
        {setup}
        <div data-ambient-avoid="surface">{composer}</div>
        <DemoSuggestions demo={demo} mode={mode} onSuggestion={onSuggestion} />
      </div>
    </div>
  )
}
