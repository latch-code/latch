import { escapeSecurityText, type TaskSummary } from '@latch/protocol'
import { Button, Fact, Icon, RunningGlyph, WaitingGlyph } from '@latch/ui'
import { waitKind } from '../sessions.ts'

export function HomeFocusSummary({
  attention,
  running,
  connected,
  onAttention,
  onClose,
}: {
  attention: readonly TaskSummary[]
  running: number
  connected: boolean
  onAttention: (id: string) => void
  onClose: () => void
}) {
  const first = attention[0]
  const wait = first && waitKind(first)
  const title = first && escapeSecurityText(first.title || '未命名会话')
  const action = wait?.kind === 'asks' ? wait.words : wait ? '等待回应' : '查看'
  return (
    <div className="home-focus-summary" data-backdrop-clear="">
      {first && (
        <Button variant="ghost" className="home-focus-attention" onClick={() => onAttention(first.id)}>
          <Icon icon={WaitingGlyph} size={14} />
          <span>
            等你处理 <Fact>{attention.length}</Fact>
          </span>
          <span className="home-focus-first">{title}</span>
        </Button>
      )}
      <span className="home-focus-running">
        <Icon icon={RunningGlyph} size={14} />
        {connected ? '进行中' : '上次进行中'} <Fact>{running}</Fact>
      </span>
      <Button variant="ghost" className="home-focus-return" onClick={onClose}>
        返回总览
      </Button>
      <span className="sr-only" role="status">
        {first ? `专注输入。等你处理 ${attention.length} 件。${action}：${title}` : '专注输入。没有要你处理的。'}
      </span>
    </div>
  )
}
