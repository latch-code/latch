import { describe, expect, it } from 'vitest'
import { mergeTool, OUTCOME_UNKNOWN, settleTool, toolDetail, toolMessage, type ToolState } from '../src/mapping.ts'
import { toolFields } from '../src/protocol.ts'

const at = '2026-11-14T01:00:00.000Z'
const diff = 'notes.txt\n@@ -1 +1 @@\n-old private text\n+new private text'

describe('file output presentation', () => {
  it('retains the safe producer summary separately from a file patch and its plain-text copy', () => {
    const state: ToolState = { id: 'tool:1:edit', content: [], locations: [], awaiting: 0 }
    mergeTool(
      state,
      toolFields.parse({
        toolCallId: 'edit',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: diff } }],
        outputWithoutFiles: 'Updated notes.txt.',
      }),
      at,
    )
    expect(toolDetail(state)).toMatchObject({ output: diff, outputWithoutFiles: 'Updated notes.txt.' })
    expect(toolMessage(state)).toMatchObject({ text: diff, state: 'completed' })
  })

  it('keeps the real unknown-result note when the file-only output is withheld', () => {
    const state: ToolState = { id: 'tool:1:edit', content: [], locations: [], awaiting: 0 }
    mergeTool(
      state,
      toolFields.parse({
        toolCallId: 'edit',
        kind: 'edit',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: diff } }],
        outputWithoutFiles: '',
      }),
      at,
    )
    settleTool(state, at)
    expect(toolDetail(state)).toMatchObject({ outputWithoutFiles: OUTCOME_UNKNOWN })
    expect(toolMessage(state)).toMatchObject({ state: 'failed', text: `${diff}\n\n${OUTCOME_UNKNOWN}` })
  })

  it('does not retain a safe summary across a later unclassified output replacement', () => {
    const state: ToolState = { id: 'tool:1:edit', content: [], locations: [], awaiting: 0 }
    mergeTool(state, toolFields.parse({ toolCallId: 'edit', rawOutput: diff, outputWithoutFiles: 'First update.' }), at)
    expect(toolDetail(state)).toHaveProperty('outputWithoutFiles', 'First update.')
    mergeTool(state, toolFields.parse({ toolCallId: 'edit', rawOutput: 'A later result.' }), at)
    expect(toolDetail(state)).not.toHaveProperty('outputWithoutFiles')
  })
})
