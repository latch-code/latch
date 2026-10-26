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
}: {
  detail: TaskDetail | null
  available: boolean
  width: number
  onOpen(target: FileOpenTarget, options: { focus: false }): void
}): void {
  const tracker = useRef(new AutoOpenOutputs()).current
  const enabled = usePreferences().autoOpenDocuments
  useEffect(() => {
    const target = tracker.observe(detail, { enabled, available, width })
    if (target) onOpen(target, { focus: false })
  }, [tracker, detail, enabled, available, width, onOpen])
}
