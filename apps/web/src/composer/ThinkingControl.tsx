import { useEffect, useState } from 'react'
import type { HarnessInfo } from '@latch/protocol'
import { Button, InlineNotice, useLayerClose } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { readModelOnSelect } from './harnessCatalogue.tsx'
import type { SessionConfigFeedback } from './modelReasoning.ts'

/** Reads what the model a draft picked offers, once, as soon as it is picked. Draws nothing. */
export function ReadPickedModel({ harness, model }: { harness: HarnessInfo; model: string }) {
  useEffect(() => {
    readModelOnSelect(harness, model)
  }, [harness, model])
  return null
}

/** A config write that failed or whose outcome is unknown, in the menu of the control it blocks; the latter offers a refresh. */
export function ConfigFeedback({
  feedback,
  onRefresh,
}: {
  feedback: SessionConfigFeedback
  onRefresh?: (() => void | Promise<void>) | undefined
}) {
  return (
    <InlineNotice
      tone={feedback.kind === 'unknown' ? 'warn' : 'error'}
      action={feedback.kind === 'unknown' && onRefresh ? <RefreshConfig refresh={onRefresh} /> : undefined}>
      <VisibleText text={feedback.message} />
    </InlineNotice>
  )
}

/** A config write still unanswered after this long says whose answer it waits for. */
export const SLOW_WRITE_MS = 2_000

export function useSlowWrite(writing: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (!writing) return
    const timer = setTimeout(() => {
      setSlow(true)
    }, SLOW_WRITE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [writing])
  return slow && writing
}

function RefreshConfig({ refresh }: { refresh: () => void | Promise<void> }) {
  const close = useLayerClose()
  return (
    <Button
      size="xs"
      onClick={() => {
        void Promise.resolve(refresh())
          .then(close)
          .catch(() => {})
      }}>
      核对
    </Button>
  )
}
