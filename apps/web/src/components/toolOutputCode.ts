import { isSecretPathName, type Message } from '@latch/protocol'
import { canHighlight, languageForPath, type SyntaxLines } from '../preview/highlight-protocol.ts'
import { toolFileTargets } from './FileReferences.tsx'

/**
 * Rows and spans drawn as tokens; the rest stays one text node, to be found and selected. Both are needed: 200 KB of
 * short numbers is under the row limit and still close to 200,000 spans, enough to stall the page for a second.
 */
export const COLOURED_LINES = 1000
export const COLOURED_SPANS = 20_000
/** Lines an agent may put around numbered source: a path header, a closing tag, a note on where the file ended. */
const WRAPPER_LINES = 8

const NUMBERED = /^( *(\d{1,7})(?:→|\t|: ?|\| ?))(.*)$/su
const FENCE = /^(`{3,}|~{3,})[\w.+-]*$/u

/**
 * The language of a read's output: the file it read, by name. The output is that file's text only when the tool itself
 * says it reads, so a command's or a search's output is never coloured as a file, nor one whose name only looks like a
 * read (`code_review`); files in different languages or a name that may hold a secret stay plain.
 */
export function readOutputLanguage(message: Pick<Message, 'tool' | 'toolName'>): string | undefined {
  if (message.tool?.kind !== 'read') return undefined
  const paths = toolFileTargets(message).map(target => target.replace(/:\d+(?::\d+)?$/u, '').replaceAll('\\', '/'))
  if (paths.length === 0 || paths.some(isSecretPathName)) return undefined
  const languages = new Set(paths.map(languageForPath))
  return languages.size === 1 ? [...languages][0] : undefined
}

/** An agent that reports only structured output gets its JSON, which is not the file: a JSON file alone keeps its grammar. */
export function outputGrammar(output: string, language: string): string | undefined {
  if (language === 'json' || language === 'jsonc' || !/^\s*[{[]/u.test(output)) return language
  try {
    JSON.parse(output)
    return undefined
  } catch {
    return language
  }
}

interface SourceRow {
  /** What the agent put before the line, in the row's text but outside the grammar. */
  gutter: string
  text: string
  /** The line's index in `body`; a wrapper line has none. */
  line?: number
}

export interface SourceView {
  /** The output with one line ending. */
  text: string
  rows: SourceRow[]
  /** What the grammar reads: the file's lines without gutters and wrappers. */
  body: string
}

/** How many of the first rows are drawn as tokens. */
export function colouredRowCount(rows: SourceRow[], tokens: SyntaxLines): number {
  const limit = Math.min(rows.length, COLOURED_LINES)
  let spans = 0
  for (let index = 0; index < limit; index++) {
    const line = rows[index]!.line
    spans += (line === undefined ? undefined : tokens[line]?.length) ?? 1
    if (spans > COLOURED_SPANS) return index
  }
  return limit
}

function numberedRows(lines: string[]): SourceRow[] | undefined {
  const first = lines.findIndex(line => NUMBERED.test(line))
  if (first < 0 || first > WRAPPER_LINES) return undefined
  const rows: SourceRow[] = lines.slice(0, first).map(text => ({ gutter: '', text }))
  let expected: number | undefined
  let at = first
  for (; at < lines.length; at++) {
    const match = NUMBERED.exec(lines[at]!)
    const number = Number(match?.[2])
    if (!match || (expected !== undefined && number !== expected)) break
    rows.push({ gutter: match[1]!, text: match[3]!, line: at - first })
    expected = number + 1
  }
  // One numbered line says nothing, and text that carries on at length after them is not a file's wrapper.
  if (at - first < 2 || lines.length - at > WRAPPER_LINES) return undefined
  for (const text of lines.slice(at)) rows.push({ gutter: '', text })
  return rows
}

function fencedRows(lines: string[]): SourceRow[] | undefined {
  const fence = FENCE.exec(lines[0] ?? '')?.[1]
  const end = lines.at(-1) === '' ? lines.length - 2 : lines.length - 1
  if (!fence || end < 1 || lines[end] !== fence) return undefined
  return lines.map((text, index) => (index === 0 || index >= end ? { gutter: '', text } : { gutter: '', text, line: index - 1 }))
}

/** Separates a read's output into rows and the source a grammar should read; a file's text passes through whole. */
export function sourceView(output: string): SourceView {
  const text = output.replaceAll('\r\n', '\n')
  // Beyond the highlighter's limit nothing will be coloured, so nothing needs splitting.
  if (!canHighlight(text)) return { text, rows: [], body: text }
  const lines = text.split('\n')
  const rows = numberedRows(lines) ?? fencedRows(lines) ?? lines.map((line, index) => ({ gutter: '', text: line, line: index }))
  const body = rows.flatMap(row => (row.line === undefined ? [] : [row.text])).join('\n')
  return { text, rows, body }
}
