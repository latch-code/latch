import { describe, expect, it } from 'vitest'
import type { Message, TaskDetail } from '@latch/protocol'
import { fileHistories, recordedFileHistory } from '../src/preview/fileHistory.ts'
const summary: TaskDetail['summary'] = {
  harnessId: 'standard',
  id: 'session',
  title: 'History',
  status: 'idle',
  updatedAt: '2026-10-25T10:00:00Z',
  cwd: '/project',
  folders: [
    { id: 'main', path: '/project' },
    { id: 'docs', path: '/notes' },
  ],
}
const edit = (id: string, folder: string, path: string, state: Message['state'] = 'completed'): Message => ({
  id,
  role: 'tool',
  text: 'applied',
  state,
  tool: {
    toolTitle: '写入文件',
    input: JSON.stringify({ folder }),
    diffs: [{ path, oldText: 'before', newText: `after ${id}`, previous: 'text' }],
  },
})
describe('per-file recorded history', () => {
  it('identifies the current user turn without folding earlier tool edits into it', () => {
    const result = fileHistories({
      summary,
      messages: [
        { id: 'first', role: 'user', text: 'First change' },
        edit('one', 'main', 'a.ts'),
        { id: 'second', role: 'user', text: 'Next change' },
        edit('two', 'main', 'b.ts'),
        edit('three', 'main', 'a.ts'),
      ],
    })
    expect(result.map(file => [file.path, file.currentTurnId, file.entries.map(entry => entry.turnId)])).toEqual([
      ['a.ts', 'second', ['first', 'second']],
      ['b.ts', 'second', ['second']],
    ])
  })
  it('keeps differently encoded filenames distinct instead of rewriting Host file identities', () => {
    const result = fileHistories({ summary, messages: [edit('one', 'main', 'café.txt'), edit('two', 'main', 'cafe\u0301.txt')] })
    expect(result.map(item => item.path)).toEqual(['café.txt', 'cafe\u0301.txt'])
  })
  it('keeps same-name files in distinct frozen roots and preserves every applied edit in message order', () => {
    const messages = [edit('one', 'main', 'report.md'), edit('two', 'docs', 'report.md'), edit('three', 'main', '/project/report.md')]
    const result = fileHistories({ summary, messages })
    expect(result.map(item => [item.root, item.path, item.entries.map(entry => entry.toolId)])).toEqual([
      ['main', 'report.md', ['one', 'three']],
      ['docs', 'report.md', ['two']],
    ])
    expect(result[0]!.target).toEqual({ sessionId: 'session', reference: 'report.md', rootId: 'main', view: 'changes' })
    expect(messages[0]!.tool!.diffs![0]!.path).toBe('report.md')
  })
  it('does not turn pending, rejected, outside or unrecognized-folder records into a file history', () => {
    const waiting = edit('wait', 'main', 'report.md', 'awaiting-approval')
    const queued = edit('queue', 'main', 'report.md', 'queued')
    const rejected = edit('denied', 'main', 'report.md', 'cancelled')
    rejected.tool!.decision = { outcome: 'rejected', at: '2026-10-25T10:00:00Z' }
    expect(
      fileHistories({
        summary,
        messages: [waiting, queued, rejected, edit('outside', 'main', '../../etc/hosts'), edit('unknown', 'absent', 'report.md')],
      }),
    ).toEqual([])
  })
  it('keeps a completed advisory Agent edit even when its permission request was rejected', () => {
    const message = edit('advisory', 'main', 'report.md')
    message.tool!.decision = { outcome: 'rejected', at: '2026-10-25T10:00:00Z' }
    expect(fileHistories({ summary, messages: [message] })[0]!.entries[0]!.toolId).toBe('advisory')
  })
  it('supports legacy single-folder sessions and file URIs without merging files from another session', () => {
    const legacy = { ...summary, folders: undefined }
    expect(fileHistories({ summary: legacy, messages: [edit('one', 'default', 'file:///project/report.md')] })[0]).toMatchObject({
      root: 'default',
      path: 'report.md',
    })
    expect(fileHistories({ summary: { ...legacy, id: 'other' }, messages: [] })).toEqual([])
  })

  it('resolves recorded tool diffs inside frozen roots as previewable and outside roots as transient diff-only history', () => {
    const inside = edit('one', 'main', 'report.md')
    const outside1 = edit('out1', 'main', '/outside/notes.ts')
    const outside2 = edit('out2', 'main', '/outside/notes.ts')
    const pending = edit('wait', 'main', '/outside/notes.ts', 'awaiting-approval')
    const detail = {
      summary,
      messages: [{ id: 'u1', role: 'user' as const, text: 'edit' }, inside, outside1, outside2, pending],
    }
    const inRoot = recordedFileHistory(detail, 'one', 0)
    expect(inRoot?.insideRoot).toBe(true)
    expect(inRoot?.history.root).toBe('main')
    expect(inRoot?.history.path).toBe('report.md')

    const outRoot = recordedFileHistory(detail, 'out1', 0)
    expect(outRoot?.insideRoot).toBe(false)
    expect(outRoot?.history.path).toBe('/outside/notes.ts')
    expect(outRoot?.history.entries.map(entry => entry.id)).toEqual(['out1:0', 'out2:0'])
    expect(outRoot?.history.currentTurnId).toBe('u1')

    expect(recordedFileHistory(detail, 'wait', 0)).toBeUndefined()
    expect(recordedFileHistory(detail, 'missing', 0)).toBeUndefined()
  })
})
