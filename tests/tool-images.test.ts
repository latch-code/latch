import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '@latch/protocol'
import { TOOL_IMAGES_SENT, toolImageWindow } from '@latch/core'

const image = (id: string) =>
  ({ id, kind: 'image', name: `${id}.png`, mime: 'image/png', size: 1, sha256: 'a'.repeat(64) }) as unknown as AttachmentRef

describe('tool images in each request', () => {
  it('sends only the newest three tool images; older tool results keep their text alone', () => {
    const history = [
      { role: 'user', attachmentRefs: [image('person')] },
      { role: 'tool', attachmentRefs: [image('s1')] },
      { role: 'tool', attachmentRefs: [image('s2')] },
      { role: 'assistant' },
      { role: 'tool', attachmentRefs: [image('s3'), image('s4')] },
      { role: 'tool' },
      { role: 'tool', attachmentRefs: [image('s5')] },
    ]
    const window = toolImageWindow(history)
    expect(TOOL_IMAGES_SENT).toBe(3)
    expect([...window.entries()].map(([index, refs]) => [index, refs.map(ref => ref.id)])).toEqual([
      [6, ['s5']],
      [4, ['s3', 's4']],
    ])
    // The person's own attachments are not counted or dropped here.
    expect(window.has(0)).toBe(false)
    expect(
      toolImageWindow(history, 1)
        .get(6)
        ?.map(ref => ref.id),
    ).toEqual(['s5'])
    expect(
      toolImageWindow(history, 2)
        .get(4)
        ?.map(ref => ref.id),
    ).toEqual(['s4'])
  })
})
