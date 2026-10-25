import { createHighlighterCore, createCssVariablesTheme } from '@shikijs/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { canHighlight, type SyntaxLines, type SyntaxRole } from './highlight-protocol.ts'
const languages = {
  javascript: () => import('@shikijs/langs-precompiled/javascript'),
  typescript: () => import('@shikijs/langs-precompiled/typescript'),
  jsx: () => import('@shikijs/langs-precompiled/jsx'),
  tsx: () => import('@shikijs/langs-precompiled/tsx'),
  json: () => import('@shikijs/langs-precompiled/json'),
  jsonc: () => import('@shikijs/langs-precompiled/jsonc'),
  python: () => import('@shikijs/langs-precompiled/python'),
  bash: () => import('@shikijs/langs-precompiled/bash'),
  shellscript: () => import('@shikijs/langs-precompiled/shellscript'),
  html: () => import('@shikijs/langs-precompiled/html'),
  css: () => import('@shikijs/langs-precompiled/css'),
  scss: () => import('@shikijs/langs-precompiled/scss'),
  markdown: () => import('@shikijs/langs-precompiled/markdown'),
  yaml: () => import('@shikijs/langs-precompiled/yaml'),
  toml: () => import('@shikijs/langs-precompiled/toml'),
  sql: () => import('@shikijs/langs-precompiled/sql'),
  rust: () => import('@shikijs/langs-precompiled/rust'),
  go: () => import('@shikijs/langs-precompiled/go'),
  java: () => import('@shikijs/langs-precompiled/java'),
  kotlin: () => import('@shikijs/langs-precompiled/kotlin'),
  swift: () => import('@shikijs/langs-precompiled/swift'),
  c: () => import('@shikijs/langs-precompiled/c'),
  cpp: () => import('@shikijs/langs-precompiled/cpp'),
  csharp: () => import('@shikijs/langs-precompiled/csharp'),
  ruby: () => import('@shikijs/langs-precompiled/ruby'),
  php: () => import('@shikijs/langs-precompiled/php'),
  dockerfile: () => import('@shikijs/langs-precompiled/dockerfile'),
  diff: () => import('@shikijs/langs-precompiled/diff'),
  xml: () => import('@shikijs/langs-precompiled/xml'),
  vue: () => import('@shikijs/langs-precompiled/vue'),
} as const
const aliases: Record<string, keyof typeof languages> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'shellscript',
  zsh: 'shellscript',
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
  if (name?.includes('string')) return 'string'
  if (name === 'comment') return 'comment'
  if (name === 'function') return 'function'
  if (name === 'constant') return 'constant'
  if (name === 'number') return 'number'
  if (name?.includes('punctuation') || name === 'operator') return 'punctuation'
  return 'plain'
}
let serial = Promise.resolve()
self.onmessage = event => {
  const input = event.data as Record<string, unknown>
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
      const result = engine.codeToTokens(code, { lang: language, theme: 'latch' }),
        lines: SyntaxLines = result.tokens.map(line => line.map(token => ({ text: token.content, role: role(token.color) })))
      self.postMessage({ id, lines })
    } catch {
      self.postMessage({ id, lines: null })
    }
  })
}
