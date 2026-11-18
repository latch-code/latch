import { Button, StatusWord } from '@latch/ui'
import type { CustomizationActions } from '../core/customization.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    unknown: '结果未知',
    saving: '正在保存',
    retry: '重试同一请求',
    abandon: '放弃等待',
  },
  {
    unknown: 'Outcome unknown',
    saving: 'Saving',
    retry: 'Retry same request',
    abandon: 'Stop waiting',
  },
)

export function CustomizationRecovery({
  writer,
  admin,
  onDone,
  size,
}: {
  writer: CustomizationActions
  admin: boolean
  onDone: () => void
  size: 'sm' | 'xs'
}) {
  const pending = writer.pending
  if (!pending) return null
  return (
    <>
      <StatusWord tone={pending.unknown ? 'warn' : 'running'}>{pending.unknown ? COPY.unknown : COPY.saving}</StatusWord>
      {pending.unknown && (
        <>
          <span>{pending.unknown.text}</span>
          {admin && pending.unknown.retryable && (
            <Button
              size={size}
              variant="secondary"
              loading={pending.sending}
              onClick={() => {
                void writer.retry().then(result => {
                  if (result.kind === 'done') onDone()
                })
              }}>
              {COPY.retry}
            </Button>
          )}
          <Button size={size} variant="ghost" disabled={pending.sending} onClick={writer.abandon}>
            {COPY.abandon}
          </Button>
        </>
      )}
    </>
  )
}
