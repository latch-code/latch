// A small .gitignore reader for the file search. It only decides which names are offered first: every name offered is
// still resolved and classified, so a wrong answer here can hide or demote a file but never reveal one.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_FILE_BYTES = 64 * 1024
const MAX_PATTERNS = 1000
const MAX_LINE = 1024

type Token = { kind: 'literal'; value: string } | { kind: 'any' } | { kind: 'star' } | { kind: 'set'; negated: boolean; items: SetItem[] }
type SetItem = { from: string; to: string }
type Segment = 'globstar' | Token[]
interface Pattern {
  negated: boolean
  directoryOnly: boolean
  anchored: boolean
  segments: Segment[]
}
export interface IgnoreRules {
  parent?: IgnoreRules
  /** The directory the file sits in, relative to the root; '' at the root. */
  base: string
  patterns: Pattern[]
}

function setAt(text: string, start: number): { token: Token; end: number } | undefined {
  let at = start + 1
  const negated = text[at] === '!' || text[at] === '^'
  if (negated) at++
  const items: SetItem[] = []
  const first = at
  while (at < text.length && (text[at] !== ']' || at === first)) {
    let from = text[at]!
    if (from === '\\' && at + 1 < text.length) from = text[++at]!
    at++
    if (text[at] === '-' && at + 1 < text.length && text[at + 1] !== ']') {
      let to = text[at + 1]!
      at += 2
      if (to === '\\' && at < text.length) to = text[at++]!
      items.push({ from, to })
    } else items.push({ from, to: from })
  }
  if (text[at] !== ']') return
  return { token: { kind: 'set', negated, items }, end: at + 1 }
}

function compile(segment: string): Token[] {
  const tokens: Token[] = []
  for (let at = 0; at < segment.length;) {
    const character = segment[at]!
    if (character === '*') {
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' })
      at++
    } else if (character === '?') {
      tokens.push({ kind: 'any' })
      at++
    } else if (character === '[') {
      const set = setAt(segment, at)
      if (set) {
        tokens.push(set.token)
        at = set.end
      } else {
        tokens.push({ kind: 'literal', value: character })
        at++
      }
    } else if (character === '\\' && at + 1 < segment.length) {
      tokens.push({ kind: 'literal', value: segment[at + 1]! })
      at += 2
    } else {
      tokens.push({ kind: 'literal', value: character })
      at++
    }
  }
  return tokens
}

export function parseGitignore(text: string): Pattern[] {
  const patterns: Pattern[] = []
  for (const raw of text.replace(/^﻿/u, '').split('\n')) {
    if (patterns.length >= MAX_PATTERNS) break
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length > MAX_LINE) continue
    while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1)
    if (!line || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)
    const directoryOnly = line.endsWith('/')
    if (directoryOnly) line = line.slice(0, -1)
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (!line) continue
    patterns.push({
      negated,
      directoryOnly,
      anchored,
      segments: line.split('/').map(part => (part === '**' ? 'globstar' : compile(part))),
    })
  }
  return patterns
}

function tokenMatches(token: Token, character: string): boolean {
  if (token.kind === 'any') return true
  if (token.kind === 'literal') return token.value === character
  if (token.kind === 'set') return token.items.some(item => item.from <= character && character <= item.to) !== token.negated
  return false
}

/** Iterative, so a pattern of many stars costs at most tokens × characters. */
function segmentMatches(tokens: Token[], text: string): boolean {
  let token = 0,
    at = 0,
    star = -1,
    resume = 0
  while (at < text.length) {
    const current = tokens[token]
    if (current?.kind === 'star') {
      star = token++
      resume = at
    } else if (current && tokenMatches(current, text[at]!)) {
      token++
      at++
    } else if (star >= 0) {
      token = star + 1
      at = ++resume
    } else return false
  }
  while (tokens[token]?.kind === 'star') token++
  return token === tokens.length
}

function pathMatches(segments: Segment[], parts: string[]): boolean {
  let reachable = Array.from({ length: parts.length + 1 }, (_, index) => index === 0)
  segments.forEach((segment, index) => {
    const next = Array.from<boolean>({ length: parts.length + 1 }).fill(false)
    if (segment === 'globstar') {
      // A trailing /** needs something inside the directory; elsewhere it may match nothing.
      const last = index === segments.length - 1
      let seen = false
      for (let at = 0; at <= parts.length; at++) {
        if (last) next[at] = seen
        seen ||= reachable[at]!
        if (!last) next[at] = seen
      }
    } else for (let at = 0; at < parts.length; at++) next[at + 1] = reachable[at]! && segmentMatches(segment, parts[at]!)
    reachable = next
  })
  return reachable[parts.length]!
}

function patternMatches(pattern: Pattern, parts: string[], directory: boolean): boolean {
  if (pattern.directoryOnly && !directory) return false
  if (pattern.anchored) return pathMatches(pattern.segments, parts)
  const segment = pattern.segments[0]!
  return segment === 'globstar' ? true : segmentMatches(segment, parts.at(-1)!)
}

/** The deepest file with a matching line decides, and inside a file the last matching line does, as git does. */
export function isGitignored(rules: IgnoreRules | undefined, relative: string, directory: boolean): boolean {
  for (let level = rules; level; level = level.parent) {
    const parts = (level.base ? relative.slice(level.base.length + 1) : relative).split('/')
    for (let at = level.patterns.length - 1; at >= 0; at--)
      if (patternMatches(level.patterns[at]!, parts, directory)) return !level.patterns[at]!.negated
  }
  return false
}

/** The rules a directory's children follow. A missing or unreadable file adds nothing; a long one is read up to the cap. */
export async function readIgnoreRules(directory: string, base: string, parent: IgnoreRules | undefined): Promise<IgnoreRules | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(join(directory, '.gitignore'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await handle.stat()).isFile()) return parent
    const buffer = Buffer.alloc(MAX_FILE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES, 0)
    const patterns = parseGitignore(buffer.toString('utf8', 0, bytesRead))
    return patterns.length ? { base, patterns, ...(parent ? { parent } : {}) } : parent
  } catch {
    return parent
  } finally {
    await handle?.close().catch(() => {})
  }
}
