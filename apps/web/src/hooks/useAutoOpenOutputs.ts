import { useEffect, useRef } from 'react'
import type { FileOpenTarget, TaskDetail } from '@latch/protocol'
import { usePreferences } from '../preferences.ts'
import { AutoOpenOutputs } from '../preview/autoOpenOutputs.ts'
/** The host supplies a non-focusing open action and actual file-column visibility/width. */
export function useAutoOpenOutputs({
  detail,
  visible,
  width,
  onOpen,
}: {
  detail: TaskDetail | null
  visible: boolean
  width: number
  onOpen(target: FileOpenTarget, options: { focus: false }): void
}): void {
  const tracker = useRef(new AutoOpenOutputs()).current
  const enabled = usePreferences().autoOpenDocuments
  useEffect(() => {
    const target = tracker.observe(detail, { enabled, visible, width })
    if (target) onOpen(target, { focus: false })
  }, [tracker, detail, enabled, visible, width, onOpen])
}
