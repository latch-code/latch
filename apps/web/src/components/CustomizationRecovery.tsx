import { Button, StatusWord } from '@latch/ui'
import type { CustomizationActions } from '../core/customization.ts'

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
      <StatusWord tone={pending.unknown ? 'warn' : 'running'}>{pending.unknown ? '结果未知' : '正在保存'}</StatusWord>
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
              重试同一请求
            </Button>
          )}
          <Button size={size} variant="ghost" disabled={pending.sending} onClick={writer.abandon}>
            放弃等待
          </Button>
        </>
      )}
    </>
  )
}
