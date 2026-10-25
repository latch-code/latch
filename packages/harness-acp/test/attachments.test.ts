import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpStore, emptyAcpState } from '../src/store.ts'
import { describe, expect, it } from 'vitest'
import { promptBlocks, checkedAttachments } from '../src/attachments.ts'
import type { AttachmentRef } from '@latch/protocol'
const ref: AttachmentRef = {
  id: 'abcdefghijklmnopqrstuv',
  name: 'note.txt',
  size: 4,
  kind: 'text',
  mime: 'text/plain',
  sha256: 'a'.repeat(64),
}
describe('ACP prompt attachments', () => {
  it('keeps attachment metadata and explicit file choices through a store restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-acp-attachments-'))
    let store = createAcpStore(root)
    try {
      await store.load()
      const state = emptyAcpState(),
        fileRefs = [{ root: 'default', path: 'notes.txt' }]
      state.tasks['task-attachment'] = {
        summary: { id: 'task-attachment', title: 'test', status: 'idle', updatedAt: new Date().toISOString() },
        messages: [{ id: 'message', role: 'user', text: '', attachments: [ref], fileRefs }],
        revision: 1,
        acp: { cwd: root, turnSeq: 1 },
      }
      await store.write(JSON.stringify(state))
      await store.close()
      store = createAcpStore(root)
      expect((await store.load()).tasks['task-attachment']!.messages[0]).toMatchObject({ attachments: [ref], fileRefs })
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('uses embedded resources and image content only after initialize advertises each capability', async () => {
    const image: AttachmentRef = { ...ref, id: 'zyxwvutsrqponmlkjihgfe', name: 'image.png', kind: 'image', mime: 'image/png' }
    const read = async (item: AttachmentRef) =>
      item.kind === 'image'
        ? { type: 'image' as const, mimeType: 'image/png' as const, data: 'aGVsbG8=' }
        : { type: 'text' as const, name: item.name, text: 'text' }
    await expect(promptBlocks('prompt', [ref], { images: true, embeddedContext: false }, read)).rejects.toMatchObject({
      code: 'agent-text-unsupported',
    })
    await expect(promptBlocks('prompt', [image], { images: false, embeddedContext: true }, read)).rejects.toMatchObject({
      code: 'agent-image-unsupported',
    })
    expect(await promptBlocks('prompt', [ref, image], { images: true, embeddedContext: true }, read)).toEqual([
      { type: 'text', text: 'prompt' },
      { type: 'resource', resource: { uri: `latch-attachment:${ref.id}`, mimeType: 'text/plain', text: 'text' } },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ])
    expect(() => checkedAttachments([ref, ref])).toThrow('附件引用无效')
  })
})
