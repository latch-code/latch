import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LocalServiceDetector } from '../src/terminal/localhost.ts'
import { Scrollback } from '../src/terminal/scrollback.ts'
import {
  ATTACH_CHARACTER_LIMIT,
  LINE_CHARACTER_LIMIT,
  attachmentText,
  plainLines,
  stripEscapes,
  fromFirstWholeLine,
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

const armour = (edge: string) => [`-----${edge}`, 'OPENSSH PRIVATE', 'KEY-----'].join(' ')

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
    expect(attachmentText(output, 2)).toEqual({ text: 'line\nline', lines: 2, truncated: true, redacted: false, mayContainSecret: false })
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

  it('keeps the gap or the break a cursor movement leaves, so nothing glues onto a key', () => {
    const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
    const moves = ['\x1b[11X\x1b[11C', '\x1b[1C', '\x1b[3a', '\x0b', '\x0c', '\x1bE', '\x1bD', '\x1bM', '\u0084', '\u0085', '\u008d']
    moves.push('\x1b[2;1H', '\x1b[2;9f', '\x1b[1A', '\x1b[1B', '\x1b[1E', '\x1b[1F', '\x1b[2d', '\x1b[2J', '\x1b8', '\x1b[u', '\x1bc')
    for (const move of moves) {
      for (const secret of [modelKey, awsKey]) {
        const text = attachmentText(`word${move}${secret}\r\n`)
        expect(text.redacted, JSON.stringify(move)).toBe(true)
        expect(text.text.includes(secret.slice(-8)), JSON.stringify(move)).toBe(false)
      }
    }
    expect(plainLines('a\x1b[2Cb')).toEqual(['a  b'])
    expect(plainLines('ab\x1b[1Dc')).toEqual(['ac'])
    expect(plainLines('abcd\x1b[2Gz')).toEqual(['azcd'])
    expect(plainLines('abc\x1b[2;5Hd')).toEqual(['abc', '    d'])
    expect(plainLines('abcdef\x1b[3D\x1b[2Xz')).toEqual(['abcz f'])
    expect(plainLines('abcdef\x1b[3D\x1b[9Xz')).toEqual(['abcz'])
    expect(plainLines('a\x1b[?25lb')).toEqual(['ab'])
    expect(plainLines('a\x0bb')).toEqual(['a', ' b'])
    expect(plainLines('a\x1bEb')).toEqual(['a', 'b'])
  })

  it('stays linear on crafted cursor movements', () => {
    const wide = 'x'.repeat(4000)
    const crafted = [
      '\x1b[9999Cx\n'.repeat(30_000),
      '\x1b[9999Cx'.repeat(30_000),
      `${wide}\x1b[1G${'\x1b[2000X'.repeat(30_000)}`,
      '\x1b[1;4000Hx'.repeat(20_000),
    ]
    for (const text of crafted) {
      const started = performance.now()
      const lines = plainLines(text)
      expect(performance.now() - started).toBeLessThan(500)
      expect(lines.reduce((total, line) => total + line.length, 0)).toBeLessThan(1024 * 1024)
    }
  })

  describe('secrets across lines', () => {
    const body = Array.from({ length: 6 }, (_, row) => `${'b3Bl'.repeat(16)}Az${row}+`)
    const pem = [armour('BEGIN'), ...body, armour('END')].join('\r\n')
    const held = (text: string) => body.some(row => text.includes(row.slice(4, 20))) || text.includes('PRIVATE')

    it('redacts a private key from BEGIN through END, also outside the lines asked for', () => {
      const all = attachmentText(`$ cat key\r\n${pem}\r\n$ next\r\n`)
      expect(all).toMatchObject({ text: '$ cat key\n[redacted]\n$ next', redacted: true })
      expect(attachmentText(`${pem}\r\nlast\r\n`, 1)).toMatchObject({ text: 'last', redacted: true })
      const open = attachmentText(`before\r\n${armour('BEGIN')}\r\n${body[0]}\r\nmore\r\n`)
      expect(open).toMatchObject({ text: 'before\n[redacted]\nmore', redacted: true })
      // An encrypted key's headers are part of the block.
      const headed = attachmentText(`${armour('BEGIN')}\r\nProc-Type: 4,ENCRYPTED\r\n\r\n${body[0]}\r\n${armour('END')}\r\nok\r\n`)
      expect(headed.text).toBe('[redacted]\nok')
    })

    it('redacts the body lines before an END whose BEGIN a cut removed', () => {
      const tail = attachmentText(`${body.slice(3).join('\r\n')}\r\n${armour('END')}\r\nafter\r\n`)
      expect(held(tail.text)).toBe(false)
      expect(tail).toMatchObject({ text: '[redacted]\nafter', redacted: true })
    })

    it('does not let one mention of the armour take the output after it', () => {
      const mention = `src/x.ts:12:  if (s.includes('${armour('BEGIN')}')) {`
      const text = attachmentText(`${mention}\r\nsrc/y.ts:3: other\r\n42 tests passed\r\n$ ls\r\n`)
      expect(text.text).toBe('[redacted]\nsrc/y.ts:3: other\n42 tests passed\n$ ls')
    })

    it('leaves ordinary lines that only resemble key bodies alone', () => {
      const text = [
        'done',
        'a'.repeat(64),
        'da39a3ee5e6b4b0d3255bfef95601890afd80709',
        'c3499c2729730a7f807efb8676a92dcb6f8a3f8f',
        'ThisIsAnOrdinaryLongCamelCaseNameWithoutDigitsInIt',
        '/Users/Alice/Projects/Latch2/Packages/Core/Src',
        'Done',
        'com/Example/Foo/Bar/Baz/MyVeryLongClassName2',
        'MyVeryLongIdentifierNameWithADigit2InTheMiddleOfIt',
        'see /usr/local/share/some/long/path/to/a/file/name',
      ].join('\n')
      expect(attachmentText(text)).toMatchObject({ text, lines: 10, truncated: false, redacted: false })
    })

    it('redacts a key a program wrapped across lines, with every line it touched', () => {
      const long = `sk-proj-${'a1B2'.repeat(14)}`
      const first = attachmentText(`${long.slice(0, 40)}\r\n${long.slice(40)}        \r\ndone\r\n`)
      expect(first).toMatchObject({ text: '[redacted]\n[redacted]\ndone', redacted: true })
      const short = attachmentText(`KEY=${long.slice(0, 16)}\r\n${long.slice(16)}\r\ndone\r\n`)
      expect(short).toMatchObject({ text: '[redacted]\ndone', redacted: true })
      const boxed = attachmentText(`│ ${long.slice(0, 16)} │\r\n│ ${long.slice(16)} │\r\ndone\r\n`)
      expect(boxed).toMatchObject({ text: '[redacted]\ndone', redacted: true })
      const rows = long.match(/.{1,6}/gu) ?? []
      const many = attachmentText(`${rows.join('\r\n')}\r\ndone\r\n`)
      expect(many).toMatchObject({ text: '[redacted]\ndone', redacted: true })
      const aws = attachmentText(`${['AKIA', 'ABCDEFGH'].join('')}\r\nIJKLMNOP tail\r\n`)
      expect(aws).toMatchObject({ text: '[redacted]', redacted: true })
    })

    it('takes the wrap width from the second row, joins from one character, and takes a last row with text after the key', () => {
      const long = `sk-proj-${'a1B2'.repeat(39)}`
      const indented = attachmentText(
        `  KEY: ${long.slice(0, 38)}\r\n${long.slice(38, 78)}\r\n${long.slice(78, 118)}\r\n${long.slice(118)}\r\ndone\r\n`,
      )
      expect(indented.text.includes('a1B2')).toBe(false)
      expect(indented.text.endsWith('\ndone')).toBe(true)
      for (const cut of [1, 2]) {
        const text = attachmentText(`KEY=${long.slice(0, cut)}\r\n${long.slice(cut)}\r\n`)
        expect(text.text.includes('a1B2'), `cut after ${cut}`).toBe(false)
      }
      const trailing = attachmentText(`KEY=${long.slice(0, 60)}\r\n${long.slice(60)} rest\r\n`)
      expect(trailing.text.includes('a1B2')).toBe(false)
    })

    it('does not take the lines after a whole key for part of it', () => {
      const text = attachmentText(`KEY=${modelKey}\r\ndone\r\nREADME.md\r\ncompiled_successfully\r\n`)
      expect(text.text).toBe('KEY=[redacted]\ndone\nREADME.md\ncompiled_successfully')
    })

    it('stays linear on many lines that look like wrapped keys', () => {
      const started = performance.now()
      attachmentText(`${'Ab1-'.repeat(10)}\n`.repeat(6000))
      attachmentText(`${' '.repeat(100_000)}x\n${'a'.repeat(100_000)} \n`)
      attachmentText(`sk-${'a'.repeat(30)}\n`.repeat(7000))
      expect(performance.now() - started).toBeLessThan(1000)
    })

    it('stays linear on one line of thousands of distinct keys at the size cap', () => {
      const line = Array.from({ length: 12_000 }, (_, n) => `AKIA${String(n).padStart(16, 'A')}`).join(' ')
      expect(line.length).toBeGreaterThan(250_000)
      expect(line.length).toBeLessThanOrEqual(256 * 1024)
      for (const raw of [line, `${line}\r\n`, `${line}\rX\r\n`]) {
        const started = performance.now()
        expect(attachmentText(raw).redacted).toBe(true)
        expect(performance.now() - started).toBeLessThan(500)
      }
    })
  })

  describe('mayContainSecret', () => {
    const random = createHash('sha512').update('terminal').digest('base64')

    it('is set when something was redacted, or the text still looks risky', () => {
      const risky = [
        `OPENAI_API_KEY=${modelKey}`,
        'sk-proj-abc',
        ['ghp', 'abc'].join('_'),
        ['AKIA', 'ABCD'].join(''),
        armour('BEGIN').slice(0, 11),
        'the PRIVATE KEY is here',
        random,
        `XXX${random.slice(0, 40)}`,
      ]
      for (const text of risky) expect(attachmentText(text).mayContainSecret, text).toBe(true)
    })

    it('stays false for ordinary output', () => {
      const ordinary = [
        '$ pnpm test --project @latch/host',
        'task-management-system risk-free',
        'da39a3ee5e6b4b0d3255bfef95601890afd80709',
        '123e4567-e89b-12d3-a456-426614174000',
        '/Users/Alice/Projects/Latch2/Packages/Core/Src',
        'MyVeryLongIdentifierNameWithADigit2InTheMiddleOfIt',
        '42 tests passed in 3.1 s',
      ]
      for (const text of ordinary) expect(attachmentText(text).mayContainSecret, text).toBe(false)
    })

    it('stays linear at the size cap', () => {
      const started = performance.now()
      attachmentText('Ab1+'.repeat(64 * 1024))
      attachmentText('Ab1+ '.repeat(52 * 1024))
      expect(performance.now() - started).toBeLessThan(500)
    })
  })

  it('starts a cut window after its first whole line break', () => {
    expect(fromFirstWholeLine(Buffer.from('tail\r\nnext\r\n')).toString()).toBe('next\r\n')
    expect(fromFirstWholeLine(Buffer.from('tail\nnext')).toString()).toBe('next')
    expect(fromFirstWholeLine(Buffer.from('tail\rnext')).toString()).toBe('next')
    expect(fromFirstWholeLine(Buffer.from('no break'))).toHaveLength(0)
  })
})
