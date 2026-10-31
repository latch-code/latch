import { createHighlighterCore, createCssVariablesTheme, type GrammarState } from '@shikijs/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { canHighlight, type SyntaxLines, type SyntaxRole } from './highlight-protocol.ts'
const languages = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  python: () => import('@shikijs/langs/python'),
  bash: () => import('@shikijs/langs/bash'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  sql: () => import('@shikijs/langs/sql'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  ruby: () => import('@shikijs/langs/ruby'),
  php: () => import('@shikijs/langs/php'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  diff: () => import('@shikijs/langs/diff'),
  xml: () => import('@shikijs/langs/xml'),
  vue: () => import('@shikijs/langs/vue'),
} as const
const aliases: Record<string, keyof typeof languages> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  cs: 'csharp',
  'c++': 'cpp',
  docker: 'dockerfile',
}
const highlighter = createHighlighterCore({
  themes: [createCssVariablesTheme({ name: 'latch', variablePrefix: '--syn-', fontStyle: false })],
  langs: [],
  engine: createJavaScriptRegexEngine(),
})
const role = (color?: string): SyntaxRole => {
  const name = /^var\(--syn-token-([a-z-]+)\)$/u.exec(color ?? '')?.[1]
  if (name === 'keyword') return 'keyword'
  // Two of the quiet hues: the diff view's green and red mean something else.
  if (name?.includes('string') || name === 'inserted') return 'string'
  if (name === 'deleted') return 'constant'
  if (name === 'comment') return 'comment'
  if (name === 'function') return 'function'
  if (name === 'constant') return 'constant'
  if (name === 'number') return 'number'
  if (name?.includes('punctuation') || name === 'operator') return 'punctuation'
  return 'plain'
}
/** Grammar state of the blocks still arriving, the oldest first. A forgotten one answers `restart`. */
const STREAMS = 32
const streams = new Map<number, { language: string; state: GrammarState | undefined; next: number; chars: number }>()
const toLines = (tokens: Array<Array<{ content: string; color?: string }>>): SyntaxLines =>
  tokens.map(line => line.map(token => ({ text: token.content, role: role(token.color) })))
let serial = Promise.resolve()
self.onmessage = event => {
  const input = event.data as Record<string, unknown>
  if (input && Number.isSafeInteger(input.release)) {
    const stream = input.release as number
    // After the lines in flight: a release overtaking them would make them answer `restart`.
    serial = serial.then(() => {
      streams.delete(stream)
    })
    return
  }
  if (
    !input
    || !Number.isSafeInteger(input.id)
    || typeof input.code !== 'string'
    || typeof input.language !== 'string'
    || !canHighlight(input.code)
  )
    return
  const id = input.id,
    code = input.code,
    sourceLanguage = input.language.toLowerCase(),
    language = aliases[sourceLanguage] ?? sourceLanguage
  serial = serial.then(async () => {
    if (!Object.hasOwn(languages, language)) {
      self.postMessage({ id, lines: null })
      return
    }
    try {
      const engine = await highlighter
      await engine.loadLanguage((await languages[language as keyof typeof languages]()).default)
      if (!Number.isSafeInteger(input.stream)) {
        self.postMessage({ id, lines: toLines(engine.codeToTokens(code, { lang: language, theme: 'latch' }).tokens) })
        return
      }
      const stream = input.stream as number,
        from = Number.isSafeInteger(input.from) ? (input.from as number) : -1,
        known = from === 0 ? undefined : streams.get(stream)
      if (from !== (known?.next ?? 0) || (known && known.language !== language)) {
        self.postMessage({ id, restart: true })
        return
      }
      const chars = (known?.chars ?? 0) + code.length + 1
      if (chars > 200_000) {
        streams.delete(stream)
        self.postMessage({ id, lines: null })
        return
      }
      const result = engine.codeToTokens(code, { lang: language, theme: 'latch', ...(known?.state ? { grammarState: known.state } : {}) })
      streams.delete(stream)
      streams.set(stream, { language, state: result.grammarState, next: from + result.tokens.length, chars })
      if (streams.size > STREAMS) streams.delete(streams.keys().next().value!)
      self.postMessage({ id, lines: toLines(result.tokens) })
    } catch {
      self.postMessage({ id, lines: null })
    }
  })
}
