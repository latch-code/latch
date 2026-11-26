import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@latch/protocol'
import { MessageContent } from '../src/MessageContent.tsx'
import { KnownFiles, KnownFilesContext, toolFileTargets } from '../src/components/FileReferences.tsx'
import { ToolCard } from '../src/components/ToolCard.tsx'
import type { FileKnownResult } from '../src/core/shell.ts'
import { codePathCandidate } from '../src/fileReference.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** A store whose main answers that `files` are files, recording every batch it was asked about. */
function store(files: string[], answer?: (batch: string[]) => FileKnownResult) {
  const batches: string[][] = []
  const known = new KnownFiles('task-1', async (_sessionId, paths) => {
    batches.push(paths)
    return answer?.(paths) ?? { status: 'ok', known: paths.filter(path => files.includes(path)) }
  })
  return { known, batches }
}

const within = (known: KnownFiles, element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(KnownFilesContext.Provider, { value: known }, element))

describe('references that are not links', () => {
  it.each([
    ['deck.pptx', 'deck.pptx'],
    ['out/deck.pptx', 'out/deck.pptx'],
    ['src/app.ts:12', 'src/app.ts:12'],
    ['main.py:42:5', 'main.py:42:5'],
    ['site/logo.png', 'site/logo.png'],
    ['/Users/me/acme/report.md', '/Users/me/acme/report.md'],
    ['package.json', 'package.json'],
    ['archive.7z', 'archive.7z'],
    ['npm run build', undefined],
    ['v1.2.3', undefined],
    ['e.g.', undefined],
    ['@latch/ui', undefined],
    ['Makefile', undefined],
    ['*.pptx', undefined],
    ['foo(bar.ts)', undefined],
    ['https://example.com/a.png', undefined],
    ['a.b', 'a.b'],
  ])('inline code %j asks about %j', (text, expected) => {
    expect(codePathCandidate(text)).toBe(expected)
  })

  it("names a tool's files from its locations, its path argument and its diffs, only for tools that touch files", () => {
    const tool = (fields: Partial<Message>): Message => ({ id: 't', role: 'tool', text: '', ...fields })
    expect(
      toolFileTargets(
        tool({
          tool: {
            kind: 'edit',
            locations: ['/Users/me/acme/out/deck.pptx', '/Users/me/acme/out/deck.pptx'],
            input: '{"path":"out/data.xlsx","content":"…"}',
            diffs: [{ path: 'site/index.html', newText: 'x' }],
          },
        }),
      ),
    ).toEqual(['/Users/me/acme/out/deck.pptx', 'out/data.xlsx', 'site/index.html'])
    expect(toolFileTargets(tool({ toolName: 'read_file', tool: { input: '{"path":"report.md"}' } }))).toEqual(['report.md'])
    expect(toolFileTargets(tool({ tool: { kind: 'execute', input: '{"command":"ls","path":"x.md"}' } }))).toEqual([])
    expect(toolFileTargets(tool({ tool: { kind: 'search', locations: ['a.md'] } }))).toEqual([])
  })
})

describe('folder-qualified references', () => {
  it('batches by frozen root identity and never reuses the primary answer for another folder', async () => {
    vi.useFakeTimers()
    const batches: Array<{ paths: string[]; root?: string }> = []
    const known = new KnownFiles('task-1', async (_session, paths, root) => {
      batches.push({ paths, root })
      return { status: 'ok', known: root === 'web' ? paths : [] }
    })
    known.want('report.md', 'api')
    known.want('report.md', 'web')
    await vi.runAllTimersAsync()
    expect(batches).toEqual([
      { paths: ['report.md'], root: 'api' },
      { paths: ['report.md'], root: 'web' },
    ])
    expect(known.isFile('report.md', 'api')).toBe(false)
    expect(known.isFile('report.md', 'web')).toBe(true)
    expect(known.isFile('report.md')).toBe(false)
    known.close()
  })
})

describe('asking main which references are files', () => {
  it('rechecks folders when a turn removes one or replaces it with an extensionless file', async () => {
    vi.useFakeTimers()
    let first = true
    const known = new KnownFiles('task-1', async () =>
      first
        ? {
            status: 'ok',
            known: [],
            folders: new Map([
              ['latch', { kind: 'folder', directory: { root: 'default', path: 'latch' } }],
              ['old', { kind: 'folder' }],
            ]),
          }
        : { status: 'ok', known: ['latch'] },
    )
    known.want('latch')
    known.want('old')
    await vi.runAllTimersAsync()
    expect(known.answer('latch')).toEqual({ kind: 'folder', directory: { root: 'default', path: 'latch' } })
    const changes = vi.fn()
    known.subscribe(changes)
    first = false
    known.recheck()
    await vi.runAllTimersAsync()
    expect(known.isFile('latch')).toBe(true)
    expect(known.answer('old')).toBe('unavailable')
    expect(changes).toHaveBeenCalledOnce()
    first = true
    known.recheck(true)
    await vi.runAllTimersAsync()
    expect(known.answer('latch')).toMatchObject({ kind: 'folder' })
    known.close()
  })

  it('asks once for everything gathered together, never twice for the same reference, 64 at a time', async () => {
    vi.useFakeTimers()
    const { known, batches } = store(['deck.pptx'])
    const paths = ['deck.pptx', 'missing.ts', ...Array.from({ length: 70 }, (_, index) => `f${index}.md`)]
    for (const path of paths) known.want(path)
    known.want('deck.pptx')
    await vi.advanceTimersByTimeAsync(500)
    expect(batches.map(batch => batch.length)).toEqual([64, 8])
    expect(known.isFile('deck.pptx')).toBe(true)
    expect(known.isFile('missing.ts')).toBe(false)
    known.want('missing.ts')
    await vi.advanceTimersByTimeAsync(500)
    expect(batches).toHaveLength(2)
  })

  it('asks again about what named no file once a turn settles, retries while main is busy, and stops once closed', async () => {
    vi.useFakeTimers()
    const files: string[] = []
    let busy = 1
    const { known, batches } = store(files, paths =>
      busy-- > 0 ? { status: 'busy' } : { status: 'ok', known: paths.filter(path => files.includes(path)) },
    )
    const changes = vi.fn()
    known.subscribe(changes)
    known.want('out/deck.pptx')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(batches).toEqual([['out/deck.pptx'], ['out/deck.pptx']])
    expect(known.isFile('out/deck.pptx')).toBe(false)
    expect(changes).not.toHaveBeenCalled()
    // The agent wrote it later in the turn.
    files.push('out/deck.pptx')
    known.recheck()
    await vi.advanceTimersByTimeAsync(500)
    expect(known.isFile('out/deck.pptx')).toBe(true)
    expect(changes).toHaveBeenCalledTimes(1)
    known.close()
    known.want('later.md')
    await vi.advanceTimersByTimeAsync(500)
    expect(batches).toHaveLength(3)
  })

  it('draws a chip for inline code the Host says is a file, and leaves other code and a streaming reply as code', async () => {
    vi.useFakeTimers()
    const { known } = store(['out/deck.pptx'])
    known.want('out/deck.pptx')
    known.want('missing.ts')
    await vi.runAllTimersAsync()
    const html = within(known, createElement(MessageContent, { text: '已写入 `out/deck.pptx`，见 `missing.ts` 与 `npm run build`。' }))
    expect(html).toContain('data-file-chip=""')
    expect(html).toContain('<span class="file-chip-folders">out/</span><span class="file-chip-name">deck.pptx</span>')
    expect(html).toContain('<code>missing.ts</code>')
    expect(html).toContain('<code>npm run build</code>')
    const linked = within(known, createElement(MessageContent, { text: '[见 `out/deck.pptx`](https://example.com/docs)' }))
    expect(linked).toContain('href="https://example.com/docs"')
    expect(linked).toContain('<code>out/deck.pptx</code>')
    expect(linked).not.toContain('data-file-chip')
    // Fenced code is never a chip.
    expect(within(known, createElement(MessageContent, { text: '```\nout/deck.pptx\n```' }))).not.toContain('data-file-chip')
    // Without the desktop app's answers every reference stays code.
    expect(renderToStaticMarkup(createElement(MessageContent, { text: '`out/deck.pptx`' }))).toContain('<code>out/deck.pptx</code>')
  })

  it("asks about a finished tool's files only, and draws its chips only once the row is opened", async () => {
    vi.useFakeTimers()
    const { known } = store(['out/deck.pptx'])
    known.want('out/deck.pptx')
    await vi.runAllTimersAsync()
    const message: Message = {
      id: 'tool:c1',
      role: 'tool',
      text: '',
      toolName: 'write_file',
      state: 'failed',
      tool: { kind: 'edit', input: '{"path":"out/deck.pptx"}', output: '写入后校验失败' },
    }
    const html = within(known, createElement(ToolCard, { message }))
    expect(html).not.toContain('tool-files')
    expect(html).toContain('tool-failure')
    const running = within(known, createElement(ToolCard, { message: { ...message, state: 'running' } }))
    expect(running).not.toContain('tool-files')
  })
})
