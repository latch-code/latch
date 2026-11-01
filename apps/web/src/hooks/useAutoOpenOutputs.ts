import { useEffect, useRef } from 'react'
import type { FileOpenTarget, TaskDetail } from '@latch/protocol'
import { usePreferences } from '../preferences.ts'
import { AutoOpenOutputs } from '../preview/autoOpenOutputs.ts'
/** The host supplies a non-focusing action and the space a document would have beside the conversation. */
export function useAutoOpenOutputs({
  detail,
  available,
  width,
  onOpen,
  onOffer,
}: {
  detail: TaskDetail | null
  available: boolean
  width: number
  onOpen(target: FileOpenTarget, options: { focus: false }): void
  onOffer(target: FileOpenTarget): void
}): void {
  const tracker = useRef(new AutoOpenOutputs()).current
  const enabled = usePreferences().autoOpenDocuments
  useEffect(() => {
    const opened = tracker.observe(detail, { enabled, available, width })
    if (!opened) return
    onOpen(opened.first, { focus: false })
    for (const target of opened.offered) onOffer(target)
  }, [tracker, detail, enabled, available, width, onOpen, onOffer])
}
