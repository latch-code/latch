import { useEffect, useState } from 'react'
import type { PersonalOverview } from '@latch/protocol'
import { api } from '../core/api.ts'

/** Presentation metadata is private too. Request only for the visible, authorized conversation. */
export function usePersonalName(assistantId: string | undefined, allowed: boolean, refreshHint: number): string | undefined {
  const [value, setValue] = useState<{ id: string; name: string }>()
  useEffect(() => {
    if (!allowed || !assistantId) {
      setValue(undefined)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (document.hidden) return
      void api<PersonalOverview>('personal', { signal: controller.signal })
        .then(overview => {
          if (controller.signal.aborted) return
          const assistant = overview.assistants.find(item => item.id === assistantId)
          setValue(assistant ? { id: assistantId, name: assistant.name } : undefined)
        })
        .catch(() => {})
    }, 120)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [assistantId, allowed, refreshHint])
  return allowed && value && value.id === assistantId ? value.name : undefined
}
