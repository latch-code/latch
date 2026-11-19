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
  it('sends each attachment in the best form the agent reported and names the rest by path, never refusing one', async () => {
    const image: AttachmentRef = { ...ref, id: 'zyxwvutsrqponmlkjihgfe', name: 'image.png', kind: 'image', mime: 'image/png' }
    const pdf: AttachmentRef = { ...ref, id: 'pdfpdfpdfpdfpdfpdfpdf0', name: '报告.pdf', kind: 'file', mime: 'application/pdf', size: 2048 }
    const read = async (item: AttachmentRef) =>
      item.kind === 'image'
        ? { type: 'image' as const, mimeType: 'image/png' as const, data: 'aGVsbG8=' }
        : { type: 'text' as const, name: item.name, text: 'text' }
    const pathOf = async (item: AttachmentRef) => `/data/attachments/s/files/${item.id}/${item.name}`
    // Codex and pi report pictures only: text goes by its path, and so does the PDF.
    expect(await promptBlocks('prompt', [ref, image, pdf], { images: true, embeddedContext: false }, read, pathOf)).toEqual([
      { type: 'text', text: 'prompt' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      {
        type: 'text',
        text: [
          '用户附上了这些文件，已保存在本机，可用你的工具按路径读取：',
          `- note.txt（text/plain，4 B）：/data/attachments/s/files/${ref.id}/note.txt`,
          `- 报告.pdf（application/pdf，2 KB）：/data/attachments/s/files/${pdf.id}/报告.pdf`,
        ].join('\n'),
      },
    ])
    // An agent that takes no pictures gets the picture's path.
    const blind = await promptBlocks('', [image], { images: false, embeddedContext: true }, read, pathOf)
    expect(blind).toEqual([{ type: 'text', text: expect.stringContaining(`/files/${image.id}/image.png`) }])
    // Text past the embedded limit reads better from the file.
    const long = { ...ref, size: 300 * 1024 }
    expect(await promptBlocks('', [long], { images: true, embeddedContext: true }, read, pathOf)).toEqual([
      { type: 'text', text: expect.stringContaining('note.txt（text/plain，300 KB）') },
    ])
    expect(await promptBlocks('prompt', [ref, image], { images: true, embeddedContext: true }, read, pathOf)).toEqual([
      { type: 'text', text: 'prompt' },
      { type: 'resource', resource: { uri: `latch-attachment:${ref.id}`, mimeType: 'text/plain', text: 'text' } },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ])
    // A driver given no way to save the file says so; it is not a refusal of the file's type.
    await expect(promptBlocks('prompt', [pdf], { images: true, embeddedContext: true }, read)).rejects.toMatchObject({
      code: 'attachments-unsupported',
    })
    expect(() => checkedAttachments([ref, ref])).toThrow('附件引用无效')
  })
})
