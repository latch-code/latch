import { useState, type ReactNode } from 'react'
import { AlarmClock } from 'lucide-react'
import type { ScheduleResult } from '@latch/protocol'
import { Button, FileGlyph, Icon, StatusWord } from '@latch/ui'
import { MessageContent } from '../MessageContent.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { outcomeWord, replyPreview } from './activity.ts'
import { whenWords } from './scheduleModel.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    scheduled: '定时',
    runDeleted: '运行的会话已删除',
    collapse: '收起',
    expand: '展开',
    completeReply: '完整回复在运行的会话里',
    files: '文件',
    created: '新增',
    deleted: '已删除',
    modified: '修改',
    openRun: '打开运行',
    result: (name: string) => `定时结果：${name}`,
    moreFiles: (count: number) => `另有 ${formatNumber(count)} 个文件`,
  },
  {
    scheduled: 'Scheduled',
    runDeleted: 'The run’s session was deleted',
    collapse: 'Show less',
    expand: 'Show more',
    completeReply: 'Read the full reply in the run’s session',
    files: 'Files',
    created: 'Added',
    deleted: 'Deleted',
    modified: 'Edited',
    openRun: 'Open run',
    result: (name: string) => `Scheduled result for ${name}`,
    moreFiles: (count: number) => plural(count, { one: '{n} more file', other: '{n} more files' }),
  },
)

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
      aria-label={COPY.result(result.name)}
      data-outcome={result.outcome}
      data-result-id={result.id}>
      <header className="schedule-result-head">
        <Icon icon={AlarmClock} size={14} />
        <strong>{COPY.scheduled}</strong>
        <span className="schedule-result-name">
          <VisibleText text={result.name} />
        </span>
        <time dateTime={result.at}>{whenWords(result.at)}</time>
        <StatusWord tone={outcome.tone}>{outcome.word}</StatusWord>
      </header>
      <div className="schedule-result-body">
        {result.contentRemoved ? (
          <p className="schedule-result-muted">{COPY.runDeleted}</p>
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
                {open ? COPY.collapse : COPY.expand}
              </Button>
            )}
            {open && result.replyTruncated && <p className="schedule-result-muted">{COPY.completeReply}</p>}
            {files.length > 0 && (
              <ul className="schedule-result-files" aria-label={COPY.files}>
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
                      {file.change === 'created' ? COPY.created : file.change === 'deleted' ? COPY.deleted : COPY.modified}
                    </span>
                  </li>
                ))}
                {result.filesMore ? <li className="schedule-result-muted">{COPY.moreFiles(result.filesMore)}</li> : null}
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
                {COPY.openRun}
              </Button>
            )}
          </div>
        )}
        {nextStep?.notice}
      </div>
    </section>
  )
}
