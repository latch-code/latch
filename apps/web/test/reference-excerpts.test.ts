import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { referenceExcerptField } from '../src/composer/referenceExcerptDecorations.tsx'
import { quotedExcerpt } from '../src/composer/quotedExcerpt.ts'
import { hookExcerpt, checkExcerpt, commentExcerpt } from '../src/panel/delivery/model.ts'
import { elementDraft, logsDraft } from '../src/panel/browser/model.ts'
import { quoteDraft } from '../src/preview/quote.ts'
import { carriedText } from '../src/agents/scheduleModel.ts'

function sources(draft: string) {
  const state = EditorState.create({ doc: draft, extensions: [referenceExcerptField] })
  const excerpts = state.field(referenceExcerptField)
  const kinds: string[] = []
  excerpts.ranges.between(0, state.doc.length, (_from, _to, mark) => {
    if (mark.spec.attributes?.['data-source']) kinds.push(mark.spec.attributes['data-source'])
  })
  return { blocks: excerpts.excerpts.map(({ from, to }) => state.doc.sliceString(from, to)), kinds }
}

it('keeps each inserted source and its original editable payload together when restoring a draft', () => {
  const browser = { page: 'localhost', selected: [], console: [], network: [] }
  const records = [
    [
      'console',
      logsDraft({
        ...browser,
        kind: 'console',
        console: [{ id: 1, time: 0, level: 'error', source: 'fixture.js', line: 2, text: 'failed' }],
      })!.text,
    ],
    [
      'network',
      logsDraft({
        ...browser,
        kind: 'network',
        network: [{ id: 2, method: 'GET', time: 0, type: 'fetch', url: '/api', status: 500, error: null, duration: 4, size: 3 }],
      })!.text,
    ],
    [
      'element',
      elementDraft({
        url: 'https://example.com',
        tag: 'button',
        selector: '.action',
        text: 'Start',
        rect: { x: 0, y: 0, width: 50, height: 20 },
      }).text,
    ],
    ['hook', hookExcerpt({ hook: 'pre-commit', exitCode: 1, tail: 'check ```text\nfailed' })],
    ['check', checkExcerpt({ number: 3, check: 'lint' })],
    ['check', checkExcerpt({ number: 3, check: 'lint', text: 'bad indent' })],
    ['comment', commentExcerpt({ number: 3, comment: { kind: 'line', author: 'a', path: 'file.ts', line: 3, body: 'Keep these words' } })],
    [
      'file',
      quoteDraft({
        contextKey: 'test',
        file: { root: 'r', path: 'file.pdf', name: 'file.pdf', size: 10, mtime: 0, etag: 'v1' },
        excerpt: { page: 2, text: 'A\nB' },
      }).text.trimEnd(),
    ],
    ['handoff', quotedExcerpt('handoff', 'done\n\nready')],
    ['board', quotedExcerpt('board', 'from project')],
    ['side', quotedExcerpt('side', 'answer')],
    ['carried', carriedText('', [{ title: 'First run', reply: 'ready', files: [] }]).trimEnd()],
  ] as const
  const result = sources(['开始', ...records.map(([, block]) => block), '结束'].join('\n\n'))
  expect(result.kinds).toEqual(records.map(([kind]) => kind))
  expect(result.blocks).toEqual(records.map(([, block]) => block))
})

it('keeps ordinary Markdown, examples inside a larger code fence and damaged excerpt headers literal', () => {
  const valid = hookExcerpt({ tail: 'error' })
  const ordinary = [
    '> plain quote',
    '````md',
    valid,
    '````',
    '交回结果：',
    'ordinary',
    '> 上次成果「fake」：',
    '> not a carried result',
    'PR #7 的检查 lint 失败：',
    '```js',
    'x',
    '```',
  ]
  expect(sources(ordinary.join('\n')).kinds).toEqual([])
})
