import { Button, StatusWord } from '@latch/ui'

/** What a card's write line shows: a 待办's own write, or a session's attend or stop from the board. */
export type CardWriteLine = { state: 'sending' } | { state: 'unknown'; reason: string } | { state: 'refused'; reason: string }

/**
 * The card's own write: sending, an unknown result with 重试 and 放弃, or the Host's refusal. Without `onDismiss` an
 * unknown result has 重试 only (a stop: it ends when the Host says the run settled) and a refusal no 知道了.
 */
export function ItemWriteLine({
  state,
  onRetry,
  onDismiss,
}: {
  state: CardWriteLine | undefined
  onRetry: () => void
  onDismiss?: (() => void) | undefined
}) {
  if (!state || state.state === 'sending') return null
  if (state.state === 'refused')
    return (
      <span className="work-board-item-write" data-state="refused">
        <StatusWord tone="failed">{state.reason}</StatusWord>
        {onDismiss && (
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            知道了
          </Button>
        )}
      </span>
    )
  return (
    <span className="work-board-item-write" data-state="unknown" title={state.reason}>
      <StatusWord tone="warn">结果未知</StatusWord>
      <Button size="xs" onClick={onRetry}>
        重试
      </Button>
      {onDismiss && (
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          放弃
        </Button>
      )}
    </span>
  )
}
