export const SYNTAX_ROLES = ['plain', 'keyword', 'string', 'comment', 'number', 'function', 'constant', 'punctuation'] as const
export type SyntaxRole = (typeof SYNTAX_ROLES)[number]
export type SyntaxToken = { text: string; role: SyntaxRole }
export type SyntaxLines = SyntaxToken[][]
/**
 * A whole block, the next complete lines of a stream (`stream` with `from`, the index of their first line), or the end
 * of a stream. A stream keeps its grammar state in the worker, so its lines cost what they add.
 */
export type HighlightRequest = { id: number; code: string; language: string; stream?: number; from?: number } | { release: number }
/** `restart`: the worker does not hold this stream at `from`, and needs its lines from the start. */
export type HighlightResponse = { id: number; lines?: unknown; restart?: boolean }
export function canHighlight(code: string): boolean {
  return code.length <= 200_000 && new TextEncoder().encode(code).length <= 200_000 && code.split('\n').every(line => line.length <= 1000)
}
export function isSyntaxLines(value: unknown, code: string): value is SyntaxLines {
  if (!Array.isArray(value) || value.length > 100_001) return false
  let count = 0
  if (
    !value.every(
      line =>
        Array.isArray(line)
        && line.every(token => {
          if (++count > 200_000 || token === null || typeof token !== 'object') return false
          const item = token as Record<string, unknown>
          return (
            Object.keys(item).every(key => key === 'text' || key === 'role')
            && typeof item.text === 'string'
            && !item.text.includes('\n')
            && SYNTAX_ROLES.includes(item.role as SyntaxRole)
          )
        }),
    )
  )
    return false
  return (value as SyntaxLines).map(line => line.map(token => token.text).join('')).join('\n') === code
}
const extensions: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'jsonc',
  py: 'python',
  sh: 'shellscript',
  zsh: 'shellscript',
  bash: 'bash',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  xml: 'xml',
  vue: 'vue',
  diff: 'diff',
  patch: 'diff',
}
export function languageForPath(path: string): string | undefined {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  return name === 'dockerfile' ? 'dockerfile' : extensions[name.split('.').at(-1) ?? '']
}
