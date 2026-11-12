import { useState, type ReactNode } from 'react'
import { AlarmClock } from 'lucide-react'
import type { ScheduleResult } from '@latch/protocol'
import { Button, FileGlyph, Icon, StatusWord } from '@latch/ui'
import { MessageContent } from '../MessageContent.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { outcomeWord, replyPreview } from './activity.ts'
import { whenWords } from './scheduleModel.ts'

/**
 * 定时 · <name> in an Agent's conversation: a Host record of a run that settled, never a message, so no Harness receives
 * it. Its outcome, the start of the last reply with 展开, the files it changed or produced, and why it failed with one
 * next step; 打开运行 opens the run's session.
 */
export function ResultCard({
  result,
  onOpenRun,
  onOpenFile,
  nextStep,
}: {
  result: ScheduleResult
  /** Absent when the run never started, or its session is not listed here. */
  onOpenRun?: (() => void) | undefined
  /** Absent when files cannot be opened on this device. */
  onOpenFile?: ((file: { root: string; path: string }) => void) | undefined
  /** A failure's one next step (重试 is 立即运行), where this device can take it. */
  nextStep?: { label: string; run: () => void; busy?: boolean; notice?: ReactNode } | undefined
}) {
  const [open, setOpen] = useState(false)
  const outcome = outcomeWord(result.outcome)
  const preview = replyPreview(result)
  const files = result.files ?? []
  return (
    <section
      className="schedule-result"
      role="group"
      aria-label={`定时结果：${result.name}`}
      data-outcome={result.outcome}
      data-result-id={result.id}>
      <header className="schedule-result-head">
        <Icon icon={AlarmClock} size={14} />
        <strong>定时</strong>
        <span className="schedule-result-name">
          <VisibleText text={result.name} />
        </span>
        <time dateTime={result.at}>{whenWords(result.at)}</time>
        <StatusWord tone={outcome.tone}>{outcome.word}</StatusWord>
      </header>
      <div className="schedule-result-body">
        {result.contentRemoved ? (
          <p className="schedule-result-muted">运行的会话已删除</p>
        ) : (
          <>
            {result.failure?.reason && (
              <p className="schedule-result-reason">
                <VisibleText text={result.failure.reason} />
              </p>
            )}
            {result.reply && (
              <div className="message-text schedule-result-reply">
                <MessageContent text={open ? result.reply : preview.short} />
              </div>
            )}
            {result.reply && preview.more && (
              <Button
                size="xs"
                variant="ghost"
                className="schedule-result-more"
                aria-expanded={open}
                onClick={() => {
                  setOpen(value => !value)
                }}>
                {open ? '收起' : '展开'}
              </Button>
            )}
            {open && result.replyTruncated && <p className="schedule-result-muted">完整回复在运行的会话里</p>}
            {files.length > 0 && (
              <ul className="schedule-result-files" aria-label="文件">
                {files.map(file => (
                  <li key={`${file.root}:${file.path}`} data-change={file.change}>
                    <Icon icon={FileGlyph} size={14} />
                    {onOpenFile && file.change !== 'deleted' ? (
                      <button type="button" className="schedule-result-file is-mono" onClick={() => onOpenFile(file)}>
                        <VisibleText text={file.path} />
                      </button>
                    ) : (
                      <span className="is-mono">
                        <VisibleText text={file.path} />
                      </span>
                    )}
                    <span className="schedule-result-change">
                      {file.change === 'created' ? '新增' : file.change === 'deleted' ? '已删除' : '修改'}
                    </span>
                  </li>
                ))}
                {result.filesMore ? <li className="schedule-result-muted">另有 {result.filesMore} 个文件</li> : null}
              </ul>
            )}
          </>
        )}
        {(onOpenRun || nextStep) && (
          <div className="schedule-result-actions">
            {nextStep && (
              <Button size="xs" loading={nextStep.busy === true} onClick={nextStep.run}>
                {nextStep.label}
              </Button>
            )}
            {onOpenRun && (
              <Button size="xs" variant="ghost" onClick={onOpenRun}>
                打开运行
              </Button>
            )}
          </div>
        )}
        {nextStep?.notice}
      </div>
    </section>
  )
}
