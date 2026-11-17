// A small .gitignore reader for the file search. It only decides which names are offered first: every name offered is
// still resolved and classified, so a wrong answer here can hide or demote a file but never reveal one.
//
// Matching is bounded, because the rules come from the repository: every character comparison is counted against a
// budget per entry and per walk, and the deadline is looked at as patterns are tried. When the budget or the time runs
// out, or a level's file was not kept whole (too long, too many lines, over the total), the answer is `undecided`, which
// callers treat as ignored: never as "not ignored", so a cut-short check cannot bring a hidden file forward.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_FILE_BYTES = 64 * 1024
const MAX_PATTERNS = 1000
const MAX_LINE = 1024
/** Patterns all levels of one path may hold together; a deeper file past it is not kept whole. */
const MAX_TOTAL_PATTERNS = 2000
/** A pattern with more path segments or more `**` than this is not kept (the level is then not whole). */
const MAX_SEGMENTS = 32
const MAX_GLOBSTARS = 4
/** Character comparisons one entry may cost across all levels, and one walk across all entries. */
export const ENTRY_STEPS = 200_000
export const WALK_STEPS = 20_000_000

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
  /** Lines of this level's file were left out (cut at a cap): what its kept lines do not match is undecided. */
  partial?: true
  /** Patterns of this level and all above it. */
  total?: number
}
/** What the ignore rules say about one entry; `undecided` when the check was cut short or a level is not whole. */
export type IgnoreVerdict = 'ignored' | 'kept' | 'undecided'
/** The work one walk may still spend on matching, and when it must stop. */
export interface MatchBudget {
  walk: number
  deadline: number
}
export const matchBudget = (deadline = Number.POSITIVE_INFINITY): MatchBudget => ({ walk: WALK_STEPS, deadline })
class Spent extends Error {}
const SPENT = new Spent()
type Meter = { left: number }

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
  return parseIgnoreFile(text).patterns
}

/** The patterns of one file, and whether any line was left out by a cap. */
export function parseIgnoreFile(text: string): { patterns: Pattern[]; partial: boolean } {
  const patterns: Pattern[] = []
  let partial = false
  for (const raw of text.replace(/^﻿/u, '').split('\n')) {
    if (patterns.length >= MAX_PATTERNS) {
      partial = true
      break
    }
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length > MAX_LINE) {
      partial = true
      continue
    }
    while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1)
    if (!line || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)
    const directoryOnly = line.endsWith('/')
    if (directoryOnly) line = line.slice(0, -1)
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (!line) continue
    const parts = line.split('/')
    if (parts.length > MAX_SEGMENTS || parts.filter(part => part === '**').length > MAX_GLOBSTARS) {
      partial = true
      continue
    }
    patterns.push({
      negated,
      directoryOnly,
      anchored,
      segments: parts.map(part => (part === '**' ? 'globstar' : compile(part))),
    })
  }
  return { patterns, partial }
}

function tokenMatches(token: Token, character: string): boolean {
  if (token.kind === 'any') return true
  if (token.kind === 'literal') return token.value === character
  if (token.kind === 'set') return token.items.some(item => item.from <= character && character <= item.to) !== token.negated
  return false
}

/**
 * The two-pointer wildcard match with one backtrack point (the last `*`): no recursion, and at most tokens × characters
 * steps (O(n·m), O(n + m) when the pattern has no `*` after the first mismatch). Each step is counted on `meter`.
 */
function segmentMatches(tokens: Token[], text: string, meter: Meter): boolean {
  let token = 0,
    at = 0,
    star = -1,
    resume = 0
  while (at < text.length) {
    if (--meter.left < 0) throw SPENT
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

function pathMatches(segments: Segment[], parts: string[], meter: Meter): boolean {
  let reachable = Array.from({ length: parts.length + 1 }, (_, index) => index === 0)
  segments.forEach((segment, index) => {
    meter.left -= parts.length + 1
    if (meter.left < 0) throw SPENT
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
    } else for (let at = 0; at < parts.length; at++) next[at + 1] = reachable[at]! && segmentMatches(segment, parts[at]!, meter)
    reachable = next
  })
  return reachable[parts.length]!
}

function patternMatches(pattern: Pattern, parts: string[], directory: boolean, meter: Meter): boolean {
  if (pattern.directoryOnly && !directory) return false
  if (pattern.anchored) return pathMatches(pattern.segments, parts, meter)
  const segment = pattern.segments[0]!
  return segment === 'globstar' ? true : segmentMatches(segment, parts.at(-1)!, meter)
}

/**
 * The deepest file with a matching line decides, and inside a file the last matching line does, as git does. With a
 * `budget`, one call spends at most `ENTRY_STEPS` (and what is left of the walk's) and stops at the deadline.
 */
export function ignoreVerdict(rules: IgnoreRules | undefined, relative: string, directory: boolean, budget?: MatchBudget): IgnoreVerdict {
  const allowed = budget ? Math.min(ENTRY_STEPS, budget.walk) : ENTRY_STEPS
  const meter: Meter = { left: allowed }
  let partial = false
  try {
    for (let level = rules; level; level = level.parent) {
      partial ||= level.partial === true
      const parts = (level.base ? relative.slice(level.base.length + 1) : relative).split('/')
      for (let at = level.patterns.length - 1; at >= 0; at--) {
        if (budget && (at & 63) === 0 && performance.now() > budget.deadline) return 'undecided'
        if (patternMatches(level.patterns[at]!, parts, directory, meter)) return level.patterns[at]!.negated ? 'kept' : 'ignored'
      }
    }
    return partial ? 'undecided' : 'kept'
  } catch (cause) {
    if (cause === SPENT) return 'undecided'
    throw cause
  } finally {
    if (budget) budget.walk -= allowed - Math.max(0, meter.left)
  }
}

/** `ignoreVerdict` as a yes or no: undecided counts as ignored. */
export function isGitignored(rules: IgnoreRules | undefined, relative: string, directory: boolean, budget?: MatchBudget): boolean {
  return ignoreVerdict(rules, relative, directory, budget) !== 'kept'
}

/** The rules a directory's children follow. A missing or unreadable file adds nothing; a long one is read up to the cap. */
export async function readIgnoreRules(directory: string, base: string, parent: IgnoreRules | undefined): Promise<IgnoreRules | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(join(directory, '.gitignore'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await handle.stat()).isFile()) return parent
    const buffer = Buffer.alloc(MAX_FILE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES, 0)
    const parsed = parseIgnoreFile(buffer.toString('utf8', 0, bytesRead))
    // A file longer than the cap is read in part: what its lines past the cap would say is unknown.
    const truncated = bytesRead === MAX_FILE_BYTES && (await handle.stat()).size > MAX_FILE_BYTES
    const above = parent?.total ?? 0
    const room = Math.max(0, MAX_TOTAL_PATTERNS - above)
    const patterns = parsed.patterns.slice(0, room)
    const partial = parsed.partial || truncated || patterns.length < parsed.patterns.length
    if (!patterns.length && !partial) return parent
    return { base, patterns, total: above + patterns.length, ...(partial ? { partial: true as const } : {}), ...(parent ? { parent } : {}) }
  } catch {
    return parent
  } finally {
    await handle?.close().catch(() => {})
  }
}
