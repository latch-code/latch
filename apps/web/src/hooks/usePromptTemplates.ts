import { useEffect, useState } from 'react'
import type { PromptTemplate } from '@latch/protocol'
import { api } from '../core/api.ts'
export function usePromptTemplates(enabled: boolean, revision: string | undefined) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  useEffect(() => {
    if (!enabled) {
      setTemplates([])
      return
    }
    const controller = new AbortController()
    void api<{ templates: PromptTemplate[] }>('prompts', { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setTemplates(result.templates)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [enabled, revision])
  return templates
}
export function scopedTemplates(
  templates: readonly PromptTemplate[],
  projectId: string | undefined,
  harnessId: string | undefined,
): PromptTemplate[] {
  return templates.filter(
    template =>
      template.scope.kind === 'all'
      || (template.scope.kind === 'project' ? template.scope.id === projectId : template.scope.id === harnessId),
  )
}
