import { describe, expect, it } from 'vitest'
import { buildPrompt, parseReply, readChecklist, readPending, readRun, tally } from '../examples/release-check/src/checklist.ts'

const items = [
  { id: 'a', title: '版本号已更新', where: 'package.json' },
  { id: 'b', title: '变更记录写到这一版', where: 'CHANGELOG.md' },
  { id: 'c', title: 'e2e 通过', where: '' },
]
const block = (body: string) => '```latch-release-check\n' + body + '\n```'

describe('the release check example: prompt and reply', () => {
  it('numbers the checklist and asks for the fenced block at the end', () => {
    const prompt = buildPrompt(items)
    expect(prompt).toContain('1. 版本号已更新（看 package.json）')
    expect(prompt).toContain('3. e2e 通过\n')
    expect(prompt).toContain('latch-release-check')
    expect(prompt).toContain('1 到 3')
  })

  it('reads the last block into one result per item, unmentioned items as missing', () => {
    const reply = [
      '先看了一遍。',
      block('{"items":[{"id":1,"status":"fail","evidence":"旧的"}]}'),
      '再看一遍：',
      block(
        JSON.stringify({
          items: [
            { id: 1, status: 'pass', evidence: '0.10.0' },
            { id: '2', status: 'fail', evidence: '缺一节' },
            { id: 9, status: 'pass' },
            { id: 2, status: 'pass' },
          ],
        }),
      ),
    ].join('\n')
    const results = parseReply(reply, items)!
    expect(results.map(result => [result.id, result.status, result.evidence])).toEqual([
      ['a', 'pass', '0.10.0'],
      ['b', 'fail', '缺一节'],
      ['c', 'missing', ''],
    ])
    expect(tally(results)).toEqual({ pass: 1, fail: 1, other: 1 })
  })

  it('has no structured result without a block, with a block that is not JSON, or one that names no item', () => {
    expect(parseReply('都没问题。', items)).toBeUndefined()
    expect(parseReply(block('{ items: 版本号 通过'), items)).toBeUndefined()
    expect(parseReply(block('{"items":[{"id":4,"status":"pass"},{"id":1,"status":"ok"}]}'), items)).toBeUndefined()
  })

  it('reads stored documents defensively', () => {
    expect(readChecklist({ items: [{ id: 'a', title: ' x ' }, { id: 'a', title: 'dup' }, { title: 'no id' }] })).toEqual([
      { id: 'a', title: 'x', where: '' },
    ])
    expect(readChecklist('nope')).toEqual([])
    expect(readPending({ requestId: 'r', projectId: 'p', startedAt: 't', items })).toMatchObject({ projectName: 'p', items })
    expect(readPending({ projectId: 'p' })).toBeUndefined()
    expect(readRun({ sessionId: 's', startedAt: 't', finishedAt: 't', outcome: 'odd', items: [] })).toBeUndefined()
    expect(
      readRun({ sessionId: 's', startedAt: 't', finishedAt: 't', outcome: 'completed', items: [{ id: 'a', status: 'pass' }], note: 5 }),
    ).toMatchObject({ note: '', structured: false, items: [{ id: 'a', status: 'pass', evidence: '' }] })
  })
})
