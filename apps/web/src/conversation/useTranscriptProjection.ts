import { useMemo, useRef } from 'react'
import type { Message, TaskDetail } from '@latch/protocol'
import { projectTurns, sameData, type TranscriptProjection } from '../conversation.ts'
import { useLocale, type Locale } from '../core/i18n.ts'

const EMPTY_PROJECTION = projectTurns([])

/** Both the transcript and its navigation read the same committed turns. */
export function useTranscriptProjection(detail: TaskDetail | null): TranscriptProjection {
  const sessionId = detail?.summary.id
  const messages = detail?.messages
  const locale = useLocale()
  const last = useRef<{ sessionId: string; messages: Message[]; locale: Locale; projection: TranscriptProjection } | null>(null)
  return useMemo(() => {
    if (sessionId === undefined || !messages) {
      last.current = null
      return EMPTY_PROJECTION
    }
    const previous = last.current?.sessionId === sessionId ? last.current : undefined
    // Old Hosts can send the whole history with each fragment. Keep the projection if only the live tail changed.
    if (previous && previous.locale === locale && sameData(previous.messages, messages)) return previous.projection
    const projection = projectTurns(messages, previous?.projection.turns)
    last.current = { sessionId, messages, locale, projection }
    return projection
  }, [locale, messages, sessionId])
}
