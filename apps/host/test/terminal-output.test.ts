import { describe, expect, it } from 'vitest'
import { LocalServiceDetector } from '../src/terminal/localhost.ts'
import { Scrollback } from '../src/terminal/scrollback.ts'
import {
  ATTACH_CHARACTER_LIMIT,
  LINE_CHARACTER_LIMIT,
  attachmentText,
  plainLines,
  stripEscapes,
  tailOfLines,
} from '../src/terminal/text.ts'

// Assembled at run time, so the source never holds a key-shaped line.
const modelKey = ['sk', 'proj', 'a1B2'.repeat(8)].join('-')
const credential = `ldc1.dev_${'A'.repeat(22)}.${'b'.repeat(43)}`

describe('scrollback', () => {
  it('keeps the newest bytes up to its capacity, addressed by offsets into all output', () => {
    const scrollback = new Scrollback(10)
    scrollback.append(Buffer.from('abcdef'))
    expect([scrollback.start, scrollback.end, scrollback.contents().toString()]).toEqual([0, 6, 'abcdef'])
    scrollback.append(Buffer.from('ghijkl'))
    expect([scrollback.start, scrollback.end, scrollback.contents().toString()]).toEqual([2, 12, 'cdefghijkl'])
    expect(scrollback.read(5, 4).toString()).toBe('fghi')
    expect(scrollback.read(12, 4)).toHaveLength(0)
    expect(() => scrollback.read(1, 4)).toThrow(RangeError)
    scrollback.append(Buffer.from('0123456789ABC'))
    expect([scrollback.start, scrollback.end, scrollback.contents().toString()]).toEqual([15, 25, '3456789ABC'])
  })

  it('grows only as output arrives, and never past its capacity', () => {
    const scrollback = new Scrollback(512 * 1024)
    for (let index = 0; index < 100; index++) scrollback.append(Buffer.alloc(16 * 1024, index))
    expect(scrollback.end).toBe(100 * 16 * 1024)
    expect(scrollback.contents()).toHaveLength(512 * 1024)
    expect(scrollback.read(scrollback.start, 1)[0]).toBe(100 - 32)
    expect(scrollback.read(scrollback.end - 1, 1)[0]).toBe(99)
  })

  it('starts a replay on a line once older output was dropped', () => {
    const scrollback = new Scrollback(16)
    scrollback.append(Buffer.from('first line\nsecond\nthird'))
    expect(scrollback.contents().toString()).toBe('ine\nsecond\nthird')
    expect(scrollback.read(scrollback.replayStart(), 64).toString()).toBe('second\nthird')
    expect(new Scrollback(64).replayStart()).toBe(0)
  })
})

describe('local services in terminal output', () => {
  it('finds the loopback origins dev servers print, colours and all', () => {
    const detector = new LocalServiceDetector()
    const vite = '\x1b[32m  ➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n'
    expect(detector.push(Buffer.from(vite))).toBe(true)
    expect(detector.services()).toEqual([{ origin: 'http://localhost:5173', port: 5173 }])
    expect(
      detector.push(
        Buffer.from('Listening on http://127.0.0.1:3000 and http://[::1]:8080/app\r\nServer at https://0.0.0.0:8443/?token=abc\r\n'),
      ),
    ).toBe(true)
    expect(detector.services()).toEqual([
      { origin: 'https://localhost:8443', port: 8443 },
      { origin: 'http://[::1]:8080', port: 8080 },
      { origin: 'http://127.0.0.1:3000', port: 3000 },
      { origin: 'http://localhost:5173', port: 5173 },
    ])
    // Announcing the newest again changes nothing.
    expect(detector.push(Buffer.from('again https://localhost:8443/\r\n'))).toBe(false)
  })

  it('keeps the eight newest of thousands of addresses in one chunk, in linear time', () => {
    const detector = new LocalServiceDetector()
    const many = `${Array.from({ length: 4000 }, (_, n) => `http://localhost:${1000 + n}`).join(' ')}\n`
    const started = performance.now()
    expect(detector.push(Buffer.from(many))).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
    expect(detector.services().map(service => service.port)).toEqual([4999, 4998, 4997, 4996, 4995, 4994, 4993, 4992])
    detector.clear()
    expect(detector.services()).toEqual([])
  })

  it('reads a URL split across chunks once its line is complete', () => {
    const detector = new LocalServiceDetector()
    expect(detector.push(Buffer.from('  Local: http://local'))).toBe(false)
    expect(detector.push(Buffer.from('host:4321/'))).toBe(false)
    expect(detector.push(Buffer.from('\r\n'))).toBe(true)
    expect(detector.services()).toEqual([{ origin: 'http://localhost:4321', port: 4321 }])
  })

  it('ignores other hosts, missing or impossible ports and look-alike names', () => {
    const detector = new LocalServiceDetector()
    const text = [
      'Network: http://192.168.1.5:5173/',
      'http://localhost/',
      'http://localhost:0/ http://localhost:65536/ http://localhost:123456/',
      'http://localhost.example.com:5173/ http://127.0.0.1.nip.io:3000/',
      'see localhost:5173 in the docs',
      '',
    ].join('\n')
    expect(detector.push(Buffer.from(text))).toBe(false)
    expect(detector.services()).toEqual([])
  })
})

describe('terminal text for 加入对话', () => {
  it('removes escape sequences and applies carriage returns, backspaces and line erases', () => {
    expect(stripEscapes('\x1b[1;31mred\x1b[0m \x1b]0;title\x07plain \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ \x1b(Bend')).toBe(
      'red plain link end',
    )
    expect(plainLines('progress 10%\rprogress 100%\nab\bc\nkeep\x1b[2K\rnew\nlong line\rshort\x1b[K\n\u009b31mx')).toEqual([
      'progress 100%',
      'ac',
      'new',
      'short',
      'x',
    ])
    // Erasing to the start keeps what follows the cursor; erasing the line keeps the cursor where it was.
    expect(plainLines('abcdef\x1b[1Kg\rxy')).toEqual(['xy    g'])
    expect(plainLines('abc\x1b[2Kd')).toEqual(['   d'])
  })

  it('stays linear on crafted erase sequences, and wraps a line at the limit', () => {
    const wide = 'x'.repeat(4000)
    for (const crafted of [
      `${wide}${'\x1b[2Ky'.repeat(50_000)}`,
      `${wide}${'\x1b[1K'.repeat(60_000)}`,
      `${wide}${'\x1b[1Kz\b'.repeat(40_000)}`,
    ]) {
      const started = performance.now()
      plainLines(crafted)
      expect(performance.now() - started).toBeLessThan(500)
    }
    expect(plainLines('a'.repeat(LINE_CHARACTER_LIMIT + 5)).map(line => line.length)).toEqual([LINE_CHARACTER_LIMIT + 5])
    expect(plainLines(`${'a'.repeat(LINE_CHARACTER_LIMIT + 2)}\x1b[2Kb`)).toEqual([`${'a'.repeat(LINE_CHARACTER_LIMIT)}  b`])
  })

  it('takes at most the last lines, trims blank ones, hides invisible characters and redacts secrets', () => {
    const output = `\n\n$ env\nOPENAI_API_KEY=${modelKey}\nDEVICE=${credential}\nsafe\u202etext\u200b\n${'line\n'.repeat(3)}\n\n`
    const all = attachmentText(output)
    expect(all.text).toBe('$ env\nOPENAI_API_KEY=[redacted]\nDEVICE=[redacted]\nsafetext\nline\nline\nline')
    expect(all).toMatchObject({ lines: 7, truncated: false, redacted: true })
    expect(attachmentText(output, 2)).toEqual({ text: 'line\nline', lines: 2, truncated: true, redacted: false })
    const wide = attachmentText(`${'x'.repeat(30_000)}\n${'y'.repeat(30_000)}\n`)
    expect(wide.truncated).toBe(true)
    expect(wide.text.length).toBeLessThanOrEqual(ATTACH_CHARACTER_LIMIT)
    // A long line stays one line, and the newest lines are the ones kept.
    expect(wide.text).toBe('y'.repeat(30_000))
  })

  it('redacts a secret that crosses the cursor wrap or the character cut', () => {
    const key = `sk-proj-${'Ab12'.repeat(8)}`
    const acrossWrap = attachmentText(`${'x'.repeat(LINE_CHARACTER_LIMIT - 7)} ${key}\n`)
    expect(acrossWrap.redacted).toBe(true)
    expect(acrossWrap.text).not.toContain('Ab12')
    const acrossCut = attachmentText(`${key} ${'z'.repeat(ATTACH_CHARACTER_LIMIT - 5)}\n`)
    expect(acrossCut).toMatchObject({ redacted: true, truncated: true })
    expect(acrossCut.text).not.toContain('Ab12')
  })

  it('decodes only the last lines of the raw output', () => {
    const raw = Buffer.from('one\ntwo\nthree\nfour\n')
    expect(tailOfLines(raw, 2).toString()).toBe('three\nfour\n')
    expect(tailOfLines(raw, 10).toString()).toBe('one\ntwo\nthree\nfour\n')
    expect(tailOfLines(Buffer.from('a\nb'), 1).toString()).toBe('b')
  })
})
