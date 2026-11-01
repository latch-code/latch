import { describe, expect, it } from 'vitest'
import {
  COLOURED_LINES,
  COLOURED_SPANS,
  colouredRowCount,
  outputGrammar,
  readOutputLanguage,
  sourceView,
} from '../src/components/toolOutputCode.ts'

const read = (tool: Record<string, unknown>, toolName = 'read_file') => readOutputLanguage({ toolName, tool: { kind: 'read', ...tool } })

describe('the language of a read', () => {
  it('comes from the file it read, with or without a line number', () => {
    expect(read({ input: JSON.stringify({ path: 'src/main.rs' }) })).toBe('rust')
    expect(read({ locations: ['/repo/src/main.rs:12'] })).toBe('rust')
    expect(read({ locations: ['/repo/page.html:3:9'], input: JSON.stringify({ file_path: 'page.html' }) })).toBe('html')
    expect(read({ locations: ['a.ts', 'b.ts'] })).toBe('typescript')
  })
  it('is unknown without one file type', () => {
    expect(read({})).toBeUndefined()
    expect(read({ locations: ['a.ts', 'b.py'] })).toBeUndefined()
    expect(read({ locations: ['a.ts', 'LICENSE'] })).toBeUndefined()
  })
  it('is never taken for what only names a file', () => {
    expect(readOutputLanguage({ toolName: 'shell', tool: { kind: 'execute', input: JSON.stringify({ path: 'a.ts' }) } })).toBeUndefined()
    expect(readOutputLanguage({ toolName: 'edit', tool: { kind: 'edit', locations: ['a.ts'] } })).toBeUndefined()
    expect(readOutputLanguage({ toolName: 'grep', tool: { kind: 'search', locations: ['a.ts'] } })).toBeUndefined()
  })
  it('is not guessed from a tool name', () => {
    const path = JSON.stringify({ path: 'a.rs' })
    for (const toolName of ['code_review', 'read_file', 'thread_view'])
      expect(readOutputLanguage({ toolName, tool: { input: path } }), toolName).toBeUndefined()
  })
  it("does not reach an agent's structured report", () => {
    expect(outputGrammar('{\n  "content": "fn main() {}"\n}', 'rust')).toBeUndefined()
    expect(outputGrammar('[1, 2]', 'typescript')).toBeUndefined()
    expect(outputGrammar('{\n  "a": 1\n}', 'json')).toBe('json')
    expect(outputGrammar('{\n  let a = 1;\n}', 'rust')).toBe('rust')
    expect(outputGrammar('fn main() {}', 'rust')).toBe('rust')
  })
  it('leaves a file that may hold a secret plain', () => {
    for (const path of ['credentials.json', '.aws/config.yaml', '/home/me/.ssh/config.toml', 'deploy\\.ssh\\keys.json', 'id_build.py'])
      expect(read({ locations: [path] }), path).toBeUndefined()
    expect(read({ locations: ['credentials.ts'] })).toBe('typescript')
  })
})

describe('the source in a read output', () => {
  it('is the whole text when nothing frames it', () => {
    const view = sourceView('fn main() {\r\n}\r\n')
    expect(view.text).toBe('fn main() {\n}\n')
    expect(view.body).toBe('fn main() {\n}\n')
    expect(view.rows.map(row => row.line)).toEqual([0, 1, 2])
  })
  it('leaves line numbers and wrapper lines out of the grammar and in the row', () => {
    for (const number of [
      (n: number) => `     ${n}→`,
      (n: number) => `     ${n}\t`,
      (n: number) => `0000${n}| `,
      (n: number) => `${n}: `,
    ]) {
      const output = `<file>\n${number(7)}fn main() {\n${number(8)}\n${number(9)}}\n\n(End of file)\n</file>`
      const view = sourceView(output)
      expect(view.body).toBe('fn main() {\n\n}')
      expect(view.rows.map(row => row.gutter + row.text).join('\n')).toBe(output.replace(/ $/u, ''))
      expect(view.rows[0]!.line).toBeUndefined()
      expect(view.rows[1]!.gutter).toBe(number(7))
    }
  })
  it('does not take text for numbered source when its numbers do not run on', () => {
    expect(sourceView('1: a\n3: b').body).toBe('1: a\n3: b')
    expect(sourceView('1: only one').body).toBe('1: only one')
    const long = `1: a\n2: b\n${'prose\n'.repeat(20)}`
    expect(sourceView(long).body).toBe(long)
  })
  it('leaves a fence out of the grammar', () => {
    const view = sourceView('```rust\nfn main() {}\n```\n')
    expect(view.body).toBe('fn main() {}')
    expect(view.rows.map(row => row.text).join('\n')).toBe('```rust\nfn main() {}\n```\n')
    expect(sourceView('```rust\nfn main() {}').body).toBe('```rust\nfn main() {}')
  })
  it('does not split what will never be coloured', () => {
    const large = 'x\n'.repeat(120_000)
    expect(sourceView(large)).toEqual({ text: large, rows: [], body: large })
  })
})

describe('the rows drawn as tokens', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, line) => ({ gutter: '', text: 'x', line }))
  const lines = (count: number, tokens: number) =>
    Array.from({ length: count }, () => Array.from({ length: tokens }, () => ({ text: 'x', role: 'plain' as const })))

  it('stop at the row limit when lines are short', () => {
    expect(colouredRowCount(rows(COLOURED_LINES + 5), lines(COLOURED_LINES + 5, 2))).toBe(COLOURED_LINES)
    expect(colouredRowCount(rows(3), lines(3, 2))).toBe(3)
  })
  it('stop at the span limit when lines are dense', () => {
    const count = colouredRowCount(rows(195), lines(195, 990))
    expect(count).toBe(Math.floor(COLOURED_SPANS / 990))
  })
  it('count a wrapper row as one', () => {
    expect(colouredRowCount([{ gutter: '', text: '<file>' }, ...rows(1)], lines(1, 2))).toBe(2)
  })
})
