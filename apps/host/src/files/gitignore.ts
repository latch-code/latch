// A small .gitignore reader for the file search. It only decides which names are offered first: every name offered is
// still resolved and classified, so a wrong answer here can hide or demote a file but never reveal one.
//
// The rules come from the repository, so nothing here may hold the Host's event loop for long, whatever they hold.
// Parsing is one pass per line, and a `[...]` set is compiled into a lookup with at most MAX_SET_ITEMS items, so every
// counted step costs at most a bounded amount of work. Time is the backstop: while a verdict is worked out, the clock is
// read every CLOCK_STEPS steps, and once the walk has gone YIELD_MS without letting the event loop turn, the verdict is
// `undecided`. Callers treat `undecided` as ignored, never as kept, so a cut-short check cannot bring a hidden file
// forward. The same holds when a level's file was not kept whole (too long, a line over a cap) and when a `!` line
// matches at or below such a level.
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
/** Characters and ranges one `[...]` set may list; a longer set leaves its line out (the level is then not whole). */
const MAX_SET_ITEMS = 64
/** Set items one file may compile in all. */
const MAX_SET_ITEMS_PER_FILE = 8192
/** Counted steps one entry may cost across all levels, and one walk across all entries. */
export const ENTRY_STEPS = 200_000
export const WALK_STEPS = 20_000_000
/** Characters of ignore files one walk may parse. */
export const PARSE_CHARACTERS = 4 * 1024 * 1024
/** The longest a walk works without letting the event loop turn, and how often a verdict reads the clock. */
export const YIELD_MS = 8
const CLOCK_STEPS = 256

type CharSet = { negated: boolean; singles: Set<string>; ranges: Array<[string, string]> }
type Token = { kind: 'literal'; value: string } | { kind: 'any' } | { kind: 'star' } | { kind: 'set'; set: CharSet }
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
/**
 * What one walk may still spend: counted steps, characters of ignore files to parse, its deadline, and `since`, when
 * the walk last let the event loop turn (the walk sets it each time it yields).
 */
export interface MatchBudget {
  walk: number
  parse: number
  deadline: number
  since: number
}
export const matchBudget = (deadline = Number.POSITIVE_INFINITY): MatchBudget => ({
  walk: WALK_STEPS,
  parse: PARSE_CHARACTERS,
  deadline,
  since: performance.now(),
})
class Spent extends Error {}
const SPENT = new Spent()
type Meter = { left: number; budget?: MatchBudget }

/** Charges `cost` steps; every CLOCK_STEPS of them the clock is read against the walk's last turn and deadline. */
function charge(meter: Meter, cost: number): void {
  const before = meter.left
  meter.left -= cost
  if (meter.left < 0) throw SPENT
  const budget = meter.budget
  if (budget && Math.floor(before / CLOCK_STEPS) !== Math.floor(meter.left / CLOCK_STEPS)) {
    const now = performance.now()
    if (now - budget.since > YIELD_MS || now > budget.deadline) throw SPENT
  }
}

/**
 * The set starting at `start` (a `[`), or `unclosed` when no `]` follows in the segment, so the caller treats this and
 * every later `[` of the segment as a literal and the segment is read in one pass. `tooLarge` past MAX_SET_ITEMS.
 */
function setAt(text: string, start: number): { set: CharSet; end: number; items: number } | 'unclosed' | 'too-large' {
  let at = start + 1
  const negated = text[at] === '!' || text[at] === '^'
  if (negated) at++
  const singles = new Set<string>()
  const ranges: Array<[string, string]> = []
  let items = 0
  const first = at
  while (at < text.length && (text[at] !== ']' || at === first)) {
    let from = text[at]!
    if (from === '\\' && at + 1 < text.length) from = text[++at]!
    at++
    if (++items > MAX_SET_ITEMS) {
      // Only whether it closes still matters: one forward scan, then the line is left out.
      return text.indexOf(']', at) < 0 ? 'unclosed' : 'too-large'
    }
    if (text[at] === '-' && at + 1 < text.length && text[at + 1] !== ']') {
      let to = text[at + 1]!
      at += 2
      if (to === '\\' && at < text.length) to = text[at++]!
      if (from === to) singles.add(from)
      else ranges.push([from, to])
    } else singles.add(from)
  }
  if (text[at] !== ']') return 'unclosed'
  return { set: { negated, singles, ranges }, end: at + 1, items }
}

/** One segment's tokens in one pass, with how many set items it compiled; undefined when a set is over the cap. */
function compile(segment: string): { tokens: Token[]; items: number } | undefined {
  const tokens: Token[] = []
  let items = 0,
    closes = true
  for (let at = 0; at < segment.length;) {
    const character = segment[at]!
    if (character === '*') {
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' })
      at++
    } else if (character === '?') {
      tokens.push({ kind: 'any' })
      at++
    } else if (character === '[' && closes) {
      const found = setAt(segment, at)
      if (found === 'too-large') return undefined
      if (found === 'unclosed') {
        // No `]` after this one, so none after any later `[` either: they are all literals.
        closes = false
        tokens.push({ kind: 'literal', value: character })
        at++
      } else {
        tokens.push({ kind: 'set', set: found.set })
        items += found.items
        at = found.end
      }
    } else if (character === '\\' && at + 1 < segment.length) {
      tokens.push({ kind: 'literal', value: segment[at + 1]! })
      at += 2
    } else {
      tokens.push({ kind: 'literal', value: character })
      at++
    }
  }
  return { tokens, items }
}

export function parseGitignore(text: string): Pattern[] {
  return parseIgnoreFile(text).patterns
}

/**
 * The patterns of one file, and whether any line was left out by a cap. With a `budget`, the characters parsed are
 * charged to the walk; once it is spent the rest of the file is left out.
 */
export function parseIgnoreFile(text: string, budget?: MatchBudget): { patterns: Pattern[]; partial: boolean } {
  const patterns: Pattern[] = []
  let partial = false,
    setItems = 0
  if (budget) {
    if (budget.parse <= 0) return { patterns, partial: true }
    if (text.length > budget.parse) {
      text = text.slice(0, budget.parse)
      partial = true
    }
    budget.parse -= text.length
  }
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
    const segments: Segment[] = []
    for (const part of parts) {
      if (part === '**') {
        segments.push('globstar')
        continue
      }
      const compiled = compile(part)
      if (!compiled || setItems + compiled.items > MAX_SET_ITEMS_PER_FILE) break
      setItems += compiled.items
      segments.push(compiled.tokens)
    }
    if (segments.length !== parts.length) {
      partial = true
      continue
    }
    patterns.push({ negated, directoryOnly, anchored, segments })
  }
  return { patterns, partial }
}

/** Whether `token` takes `character`, charging what it really costs: one step, plus one per range of a set. */
function tokenMatches(token: Token, character: string, meter: Meter): boolean {
  if (token.kind === 'any') return true
  if (token.kind === 'literal') return token.value === character
  if (token.kind === 'set') {
    const { set } = token
    charge(meter, set.ranges.length)
    const inside = set.singles.has(character) || set.ranges.some(([from, to]) => from <= character && character <= to)
    return inside !== set.negated
  }
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
    charge(meter, 1)
    const current = tokens[token]
    if (current?.kind === 'star') {
      star = token++
      resume = at
    } else if (current && tokenMatches(current, text[at]!, meter)) {
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
    charge(meter, parts.length + 1)
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
  const meter: Meter = { left: allowed, ...(budget ? { budget } : {}) }
  // A level not kept whole, here or deeper, may have held a later line that decides otherwise.
  let partial = false
  try {
    if (budget && (allowed <= 0 || performance.now() - budget.since > YIELD_MS || performance.now() > budget.deadline)) return 'undecided'
    for (let level = rules; level; level = level.parent) {
      partial ||= level.partial === true
      const parts = (level.base ? relative.slice(level.base.length + 1) : relative).split('/')
      for (let at = level.patterns.length - 1; at >= 0; at--) {
        charge(meter, 1)
        if (!patternMatches(level.patterns[at]!, parts, directory, meter)) continue
        if (!level.patterns[at]!.negated) return 'ignored'
        return partial ? 'undecided' : 'kept'
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
export async function readIgnoreRules(
  directory: string,
  base: string,
  parent: IgnoreRules | undefined,
  budget?: MatchBudget,
): Promise<IgnoreRules | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(join(directory, '.gitignore'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await handle.stat()).isFile()) return parent
    const buffer = Buffer.alloc(MAX_FILE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES, 0)
    const parsed = parseIgnoreFile(buffer.toString('utf8', 0, bytesRead), budget)
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
