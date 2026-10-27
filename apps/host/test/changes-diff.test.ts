import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { countChanges, decodeText, diffLines, patchHunks, splitText, toHunks } from '../src/changes/diff.ts'

const git = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git', '/usr/bin/git'].find(path =>
  existsSync(path),
)
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

describe('line diffs for changes', () => {
  it.skipIf(!git)('writes patches that git apply turns back into the new text, with CR lines and missing final newlines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-changes-diff-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const words = ['a', 'b', 'c', 'd', 'e', 'f\r', '', 'g']
    for (let round = 0; round < 150; round++) {
      const lines = Array.from({ length: random(30) }, () => words[random(words.length)]!)
      const changed = lines.slice()
      for (let edit = random(8); edit > 0; edit--) {
        const at = random(changed.length + 1),
          kind = random(3)
        if (kind === 0) changed.splice(at, 0, words[random(words.length)]!)
        else if (kind === 1) changed.splice(at, 1)
        else changed[at] = words[random(words.length)]!
      }
      const before = lines.join('\n') + (random(2) ? '\n' : ''),
        after = changed.join('\n') + (random(2) ? '\n' : '')
      const [a, b] = [splitText(before), splitText(after)]
      const hunks = patchHunks(diffLines(a, b), a, b)
      await writeFile(join(directory, 'f.txt'), before)
      if (hunks) {
        await writeFile(join(directory, 'p.diff'), `diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n${hunks}`)
        execFileSync(git!, ['apply', 'p.diff'], { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory } })
      }
      expect(await readFile(join(directory, 'f.txt'), 'utf8')).toBe(after)
    }
  })

  it('numbers lines, puts removals first, merges close changes and shows text without CR', () => {
    const ops = diffLines(splitText('a\nb\nc\n'), splitText('a\nB\r\nc\nd'))
    expect(countChanges(ops)).toEqual({ add: 2, del: 1 })
    expect(toHunks(ops, 1)).toEqual([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [
          { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
          { kind: 'remove', text: 'b', oldLine: 2 },
          { kind: 'add', text: 'B', newLine: 2 },
          { kind: 'context', text: 'c', oldLine: 3, newLine: 3 },
          { kind: 'add', text: 'd', newLine: 4 },
        ],
      },
    ])
    const far = diffLines(splitText(`x\n${'k\n'.repeat(20)}y\n`), splitText(`X\n${'k\n'.repeat(20)}Y\n`))
    expect(toHunks(far, 3)).toHaveLength(2)
    expect(toHunks(far, Infinity)).toHaveLength(1)
  })

  it('bounds the work: a reversed 30,000-line file becomes a full replacement in well under a second', () => {
    const lines = Array.from({ length: 30_000 }, (_, index) => `line ${index}`)
    const started = performance.now()
    const ops = diffLines(splitText(lines.join('\n')), splitText(lines.toReversed().join('\n')))
    expect(performance.now() - started).toBeLessThan(1000)
    expect(countChanges(ops).add + countChanges(ops).del).toBeGreaterThan(30_000)
    const few = lines.slice()
    for (let index = 0; index < 300; index++) few[(index * 97) % few.length] = `changed ${index}`
    expect(countChanges(diffLines(splitText(lines.join('\n')), splitText(few.join('\n'))))).toEqual({ add: 300, del: 300 })
  })

  it('treats NUL bytes and invalid UTF-8 as binary and keeps a byte-order mark', () => {
    expect(decodeText(new Uint8Array([0x61, 0x00, 0x62]))).toBeUndefined()
    expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeUndefined()
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a')
  })
})
