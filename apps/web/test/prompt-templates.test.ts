import { describe, expect, it } from 'vitest'
import type { PromptTemplate } from '@latch/protocol'
import { scopedTemplates } from '../src/hooks/usePromptTemplates.ts'
describe('prompt template scopes', () => {
  it('offers global templates and only the current project and agent templates', () => {
    const templates: PromptTemplate[] = [
      { id: 'all', name: 'All', content: 'a', scope: { kind: 'all' } },
      { id: 'project', name: 'Project', content: 'b', scope: { kind: 'project', id: 'p' } },
      { id: 'agent', name: 'Agent', content: 'c', scope: { kind: 'agent', id: 'h' } },
    ]
    expect(scopedTemplates(templates, 'p', 'h')).toHaveLength(3)
    expect(scopedTemplates(templates, undefined, 'other').map(template => template.id)).toEqual(['all'])
  })
})
