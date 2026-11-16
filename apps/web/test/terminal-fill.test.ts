import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSummary } from '@latch/protocol'
import { atPrompt, FILL_MAX_CHARS, fillCommand, fillRefusal, fillTab, isShellLanguage, pasteData } from '../src/panel/terminal/fill.ts'
import { DETACHED, TerminalFills } from '../src/panel/terminal/fills.ts'
import { TerminalLink, type TerminalSink } from '../src/panel/terminal/link.ts'
import { FillPlace } from '../src/panel/terminal/fills.ts'
import { MessageContent, ReasoningContent } from '../src/MessageContent.tsx'

const summary = (patch: Partial<TerminalSummary & { sessionId: string }> = {}): TerminalSummary => ({
  id: 't1',
  sessionId: 's',
  shell: 'zsh',
  folder: 'latch',
  cols: 80,
  rows: 24,
  status: 'running',
  busy: false,
  prompt: 1,
  services: [],
  sizeOwner: true,
  createdAt: '2026-11-16T00:00:00.000Z',
  ...patch,
})

describe('a command typed in at the prompt', () => {
  it('takes one plain line, the fence’s own line break aside, and nothing else', () => {
    expect(fillRefusal('pnpm test\n')).toBeUndefined()
    expect(fillCommand('pnpm test\n')).toBe('pnpm test')
    expect(fillRefusal('git log --oneline -5 | head -n 3 && echo "完成"')).toBeUndefined()
    expect(fillRefusal('pnpm test', true)).toBe('还在生成')
    expect(fillRefusal('')).toBe('没有命令')
    expect(fillRefusal('  \n')).toBe('没有命令')
    expect(fillRefusal('cd app\npnpm test')).toBe('多行命令，请复制')
    expect(fillRefusal('pnpm test\n\n')).toBe('多行命令，请复制')
    expect(fillRefusal('pnpm test\r')).toBe('多行命令，请复制')
    expect(fillRefusal('echo a\u2028rm -rf ~')).toBe('多行命令，请复制')
    expect(fillRefusal('curl https://example.test \\')).toBe('以反斜杠结尾，请复制')
    expect(fillRefusal('curl https://example.test \\  ')).toBe('以反斜杠结尾，请复制')
    expect(fillRefusal('x'.repeat(FILL_MAX_CHARS))).toBeUndefined()
    expect(fillRefusal('x'.repeat(FILL_MAX_CHARS + 1))).toBe('命令过长，请复制')
  })

  it('refuses control, invisible and direction-changing characters', () => {
    for (const hidden of [
      'echo hi\x1b[201~; rm -rf ~',
      'echo\thi',
      'echo hi\x00',
      'echo hi\x7f',
      'echo hi\x9b',
      'ls \u202egnp.exe',
      'ls\u200b -la',
      'rm\u2066 -rf\u2069 x',
      'echo \u{e0041}',
      'echo \ufeffhi',
    ])
      expect(fillRefusal(hidden), JSON.stringify(hidden)).toBe('含控制、不可见或改变方向的字符')
    // An emoji joined as it is drawn is no hidden character.
    expect(fillRefusal('echo 👩\u200d💻')).toBeUndefined()
  })

  it('never sends a line break: only the line between the paste brackets, and nothing for a refused one', () => {
    expect(pasteData('pnpm test\n')).toBe('\x1b[200~pnpm test\x1b[201~')
    const samples = ['pnpm test\n', 'npm i -g @scope/cli@latest', 'echo "a;b" && ls', 'x'.repeat(FILL_MAX_CHARS)]
    for (const sample of samples) {
      const data = pasteData(sample)!
      expect(data).toBeDefined()
      expect(data).not.toMatch(/[\r\n]/u)
      // The two brackets are the only escapes.
      expect(data.replace('\x1b[200~', '').replace('\x1b[201~', '')).not.toMatch(/[\p{Cc}]/u)
    }
    for (const refused of ['a\nb', 'a\r', 'a\x1b[201~\nb', 'a \\', 'a\u2029b', '', 'x'.repeat(FILL_MAX_CHARS + 1)])
      expect(pasteData(refused)).toBeUndefined()
  })

  it('goes only to a shell waiting at its prompt with bracketed paste on', () => {
    expect(atPrompt(summary())).toBe(true)
    expect(atPrompt(summary({ busy: true, foreground: 'vim' }))).toBe(false)
    const { prompt: _prompt, ...editing } = summary()
    expect(atPrompt(editing)).toBe(false)
    expect(atPrompt(summary({ status: 'exited', exitCode: 0 }))).toBe(false)
    expect(atPrompt(summary({ login: { harnessId: 'codex', name: 'Codex' } }))).toBe(false)
    const tabs = [
      { id: 'idle', number: 1, summary: summary({ id: 'idle' }) },
      { id: 'busy', number: 2, summary: summary({ id: 'busy', busy: true }) },
    ]
    expect(fillTab(tabs, 'idle')?.id).toBe('idle')
    // A program in the active tab is never typed into: a new terminal is opened instead.
    expect(fillTab(tabs, 'busy')).toBeUndefined()
    expect(fillTab(tabs, undefined)).toBeUndefined()
    // One command per prompt: a second waits for a new prompt, or goes to a new terminal.
    const filled = new Map([['idle', 1]])
    expect(atPrompt(summary({ id: 'idle' }), filled)).toBe(false)
    expect(fillTab(tabs, 'idle', filled)).toBeUndefined()
    expect(fillTab([{ id: 'idle', number: 1, summary: summary({ id: 'idle', prompt: 2 }) }], 'idle', filled)?.id).toBe('idle')
  })

  it('offers the action on shell code blocks only', () => {
    for (const language of ['sh', 'bash', 'zsh', 'fish', 'shell', 'Bash']) expect(isShellLanguage(language)).toBe(true)
    for (const language of [undefined, 'console', 'text', 'python', 'ps1', 'js']) expect(isShellLanguage(language)).toBe(false)
  })
})

describe('fill requests', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('waits for the surface of its place, which takes it once; a newer request replaces it, and the deadline ends it', async () => {
    vi.useFakeTimers()
    const fills = new TerminalFills(1000)
    const first = fills.request('s1', 'pnpm test')
    expect(fills.waiting('s2')).toBeUndefined()
    expect(fills.waiting(DETACHED)).toBeUndefined()
    const asked = fills.waiting('s1')!
    expect(asked.command).toBe('pnpm test')
    const second = fills.request('s1', 'pnpm build')
    await expect(first).rejects.toThrow('已换成新的命令')
    const taken = fills.waiting('s1')!
    fills.take(taken)
    expect(fills.waiting('s1')).toBeUndefined()
    taken.settle()
    await expect(second).resolves.toBeUndefined()
    const late = fills.request(DETACHED, 'npm i -g x')
    vi.advanceTimersByTime(1000)
    await expect(late).rejects.toThrow('终端没有准备好')
    expect(fills.waiting(DETACHED)).toBeUndefined()
  })

  it('types the paste in one input call behind earlier keys, and says when the Host turned it down', async () => {
    const bodies: string[] = []
    let refuse = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (refuse) return Response.json({ error: 'host-updating', message: '正在安装更新' }, { status: 409 })
        bodies.push(Buffer.from((JSON.parse(String(init.body)) as { data: string }).data, 'base64').toString('latin1'))
        return Response.json({ accepted: true })
      }),
    )
    const failures: string[] = []
    const sink: TerminalSink = {
      write: () => undefined,
      reset: () => undefined,
      summary: () => undefined,
      closed: () => undefined,
      connection: () => undefined,
      inputFailed: text => failures.push(text),
    }
    const link = new TerminalLink('s', 't', sink)
    link.send('l')
    await link.sendWhole(pasteData('pnpm test')!)
    expect(bodies).toEqual(['l', '\x1b[200~pnpm test\x1b[201~'])
    refuse = true
    await expect(link.sendWhole(pasteData('pnpm build')!)).rejects.toThrow('正在安装更新')
    expect(failures).toEqual(['正在安装更新'])
  })
})

describe('the action on a reply', () => {
  const inSession = (child: ReactNode) => renderToStaticMarkup(createElement(FillPlace.Provider, { value: 's1' }, child))
  const action = /aria-label="在终端里打开"[^>]*/u

  it('sits beside copy on a settled shell block, where this Mac has the session’s terminal', () => {
    const html = inSession(createElement(MessageContent, { text: '运行：\n\n```sh\npnpm test\n```\n' }))
    expect(html).toMatch(action)
    expect(html.match(action)![0]).not.toContain('aria-disabled')
    expect(html.indexOf('在终端里打开')).toBeLessThan(html.indexOf('复制代码'))
    // Anywhere else (another device, a file's preview), only copy remains; other languages have none.
    expect(renderToStaticMarkup(createElement(MessageContent, { text: '```sh\npnpm test\n```\n' }))).not.toContain('在终端里打开')
    expect(inSession(createElement(MessageContent, { text: '```sh\npnpm test\n```\n', path: 'docs/a.md' }))).not.toContain('在终端里打开')
    expect(inSession(createElement(MessageContent, { text: '```python\nprint(1)\n```\n' }))).not.toContain('在终端里打开')
  })

  it('is turned down, with its reason, for a block that is still arriving, has more lines or hides characters', () => {
    const streaming = inSession(createElement(MessageContent, { text: '```sh\npnpm te', streaming: true }))
    expect(streaming.match(action)![0]).toContain('aria-disabled="true"')
    expect(streaming).toContain('aria-description="还在生成"')
    expect(streaming).toMatch(/role="tooltip"[^>]*><span>还在生成<\/span>/u)
    const lines = inSession(createElement(MessageContent, { text: '```bash\ncd app\npnpm test\n```\n' }))
    expect(lines.match(action)![0]).toContain('aria-disabled="true"')
    const hidden = inSession(createElement(MessageContent, { text: '```sh\nls \u202egnp.exe\n```\n' }))
    expect(hidden.match(action)![0]).toContain('aria-disabled="true"')
    expect(hidden).toContain('含控制、不可见或改变方向的字符')
  })

  it('draws a shell block in reported reasoning as a code block with the action; any other fence stays text', () => {
    const html = inSession(createElement(ReasoningContent, { text: '先装依赖：\n\n```sh\npnpm install\n```\n\n```js\nalert(1)\n```' }))
    expect(html).toMatch(action)
    expect(html.match(/aria-label="在终端里打开"/gu)).toHaveLength(1)
    expect(html).toContain('```js')
  })
})
