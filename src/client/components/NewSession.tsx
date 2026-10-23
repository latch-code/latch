import type { ReactNode } from 'react'
import { BookOpenText, FileCheck, PlugZap, Timer, TriangleAlert } from 'lucide-react'
import type { TaskMode } from '../../shared/types.ts'
import type { StartBlock } from '../composerChoice.ts'
import { ICON_STROKE, type LucideIcon } from '../icons.tsx'
import { Badge, BrandMark } from './ui.tsx'

interface Suggestion { title: string; description: string; prompt: string; icon: LucideIcon; modes: TaskMode[] }

/** Prompts the built-in demo model recognizes; shown only while the Host runs in demo mode. */
const demoSuggestions: Suggestion[] = [
  { title: '阅读流式内容', description: 'Markdown、代码和长内容', prompt: '展示流式输出', icon: BookOpenText, modes: ['chat', 'agent'] },
  { title: '生成一份报告', description: '在手机上批准后写入文件', prompt: '批准生成验收报告', icon: FileCheck, modes: ['agent'] },
  { title: '运行一个长任务', description: '离线后接续，随时取消', prompt: '运行可取消长任务', icon: Timer, modes: ['agent'] },
]

/** Explains why a session cannot start and links to the setting that fixes it. */
export function SetupCard({ block, owner, onSetup }: { block: StartBlock; owner: boolean; onSetup: () => void }) {
  const model = block.kind === 'model-required'
  return <div className="setup-card" role="status">
    <span className="setup-card-icon" aria-hidden="true">{model ? <PlugZap size={18} strokeWidth={ICON_STROKE} /> : <TriangleAlert size={18} strokeWidth={ICON_STROKE} />}</span>
    <div className="setup-card-text">
      <strong>{model ? '连接模型服务' : 'Harness 暂不可用'}</strong>
      <p>{block.message} {owner ? (model ? '添加一个模型服务后即可开始。' : '可在设置中检查 Agent 与插件。') : '请在主设备上完成配置。'}</p>
    </div>
    {owner && <button type="button" className="button primary" onClick={onSetup}>{model ? '添加模型服务' : '打开设置'}</button>}
  </div>
}

export function NewSession({ composer, setup, demo, mode, onSuggestion }: {
  composer: ReactNode
  setup?: ReactNode
  demo: boolean
  mode: TaskMode
  onSuggestion: (prompt: string) => void
}) {
  const suggestions = demo ? demoSuggestions.filter(item => item.modes.includes(mode)) : []
  return <div className="new-session">
    <div className="new-session-inner">
      <div className="greeting"><BrandMark size={40} /><h2>今天要做什么？</h2></div>
      {setup}
      {composer}
      {suggestions.length > 0 && <section className="suggestions" aria-label="演示任务">
        {suggestions.map(item => <button key={item.prompt} type="button" className="suggestion-card" onClick={() => { onSuggestion(item.prompt) }}>
          <item.icon size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span className="suggestion-title">{item.title}<Badge tone="warn">演示</Badge></span>
          <span className="suggestion-description">{item.description}</span>
        </button>)}
      </section>}
    </div>
  </div>
}
