import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSummary } from '@latch/protocol'
import { TerminalLink, type TerminalSink } from '../src/panel/terminal/link.ts'
import {
  draftText,
  endedText,
  fromBase64,
  INPUT_CHUNK_BYTES,
  inputChunks,
  keepActive,
  keyLeavesTerminal,
  nameTabs,
  serviceLabel,
  streamPath,
  toBase64,
} from '../src/panel/terminal/model.ts'

const summary = (id: string, createdAt: string, patch: Partial<TerminalSummary & { sessionId: string }> = {}): TerminalSummary => ({
  id,
  sessionId: 's',
  shell: 'zsh',
  folder: 'latch',
  cols: 80,
  rows: 24,
  status: 'running',
  busy: false,
  services: [],
  sizeOwner: true,
  createdAt,
  ...patch,
})

describe('terminal tabs', () => {
  it('numbers terminals in the order the Host opened them and keeps each number while it lives', () => {
    const first = nameTabs([], [summary('b', '2026-11-12T00:00:02Z'), summary('a', '2026-11-12T00:00:01Z')])
    expect(first.map(tab => [tab.id, tab.number])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    // 终端 1 closes: 终端 2 keeps its name, and the next one takes the free 1.
    const after = nameTabs(first, [summary('b', '2026-11-12T00:00:02Z'), summary('c', '2026-11-12T00:00:03Z')])
    expect(after.map(tab => [tab.id, tab.number])).toEqual([
      ['c', 1],
      ['b', 2],
    ])
    // A page that loads again names them from 1.
    expect(
      nameTabs(
        [],
        after.map(tab => tab.summary),
      ).map(tab => tab.number),
    ).toEqual([1, 2])
  })

  it('gives a reopened terminal the name of the one it replaced, when that is free', () => {
    const tabs = nameTabs([], [summary('a', '1'), summary('b', '2')])
    const reopened = nameTabs(
      tabs.filter(tab => tab.id !== 'b'),
      [summary('a', '1'), summary('c', '3')],
      new Map([['c', 2]]),
    )
    expect(reopened.map(tab => [tab.id, tab.number])).toEqual([
      ['a', 1],
      ['c', 2],
    ])
  })

  it('keeps the selected tab, or moves to the next one after it, when one goes', () => {
    const tabs = nameTabs([], [summary('a', '1'), summary('b', '2'), summary('c', '3')])
    expect(keepActive(tabs, 'b')).toBe('b')
    const without = tabs.filter(tab => tab.id !== 'b')
    expect(keepActive(without, 'b', tabs)).toBe('c')
    expect(keepActive(tabs.slice(0, 2), 'c', tabs)).toBe('b')
    expect(keepActive([], 'a', tabs)).toBeUndefined()
    expect(keepActive(tabs, undefined)).toBe('a')
  })

  it('says how a terminal ended: the exit code, the signal or a failure', () => {
    expect(endedText(summary('a', '1'))).toBeUndefined()
    expect(endedText(summary('a', '1', { status: 'exited', exitCode: 0 }))).toBe('已退出 · 代码 0')
    expect(endedText(summary('a', '1', { status: 'exited', exitCode: 127 }))).toBe('已退出 · 代码 127')
    expect(endedText(summary('a', '1', { status: 'exited', exitSignal: 'SIGHUP' }))).toBe('已结束 · SIGHUP')
    expect(endedText(summary('a', '1', { status: 'failed' }))).toBe('终端意外结束')
  })

  it('names a local service by its host and port', () => {
    expect(serviceLabel({ origin: 'http://localhost:5173', port: 5173 })).toBe('localhost:5173')
    expect(serviceLabel({ origin: 'https://[::1]:8443', port: 8443 })).toBe('[::1]:8443')
  })
})

describe('terminal input and keys', () => {
  it('splits a long paste into calls the Host accepts, byte for byte and in order', () => {
    const paste = `\u001b[200~${'界'.repeat(30_000)}\u001b[201~`
    const chunks = inputChunks(paste)
    expect(chunks.length).toBe(2)
    expect(chunks.every(chunk => chunk.length <= INPUT_CHUNK_BYTES)).toBe(true)
    const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) {
      joined.set(chunk, at)
      at += chunk.length
    }
    expect(new TextDecoder().decode(joined)).toBe(paste)
    expect(new TextDecoder().decode(fromBase64(toBase64(chunks[0]!)))).toBe(new TextDecoder().decode(chunks[0]))
    expect(inputChunks('')).toEqual([])
  })

  it('keeps every key but ⌘ chords in the terminal', () => {
    const key = (patch: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) => ({
      key: 'a',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...patch,
    })
    expect(keyLeavesTerminal(key({ key: 'k', metaKey: true }))).toBe(true)
    expect(keyLeavesTerminal(key({ key: 'c', ctrlKey: true }))).toBe(false)
    expect(keyLeavesTerminal(key({ key: 'b', altKey: true }))).toBe(false)
    expect(keyLeavesTerminal(key({ key: 'Escape' }))).toBe(false)
  })

  it('puts the extract into the draft in a fence that its own backticks cannot close', () => {
    const text = draftText('终端 1', { text: 'run ```x```\nok\n', lines: 2, truncated: true, redacted: false, mayContainSecret: false })
    expect(text).toBe('终端 1（较早的输出未包含）\n````text\nrun ```x```\nok\n````')
    expect(draftText('终端 2', { text: 'ls', lines: 1, truncated: false, redacted: false, mayContainSecret: false })).toBe(
      '终端 2\n```text\nls\n```',
    )
  })
})

/** A Host stream that sends `frames`, then ends (cut) unless the last is `closed`. */
function sse(frames: Array<[string, unknown]>): Response {
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function recorder() {
  const record = { output: '', resets: 0, summaries: [] as TerminalSummary[], closed: 0, states: [] as string[], failures: [] as string[] }
  const sink: TerminalSink = {
    write: bytes => {
      record.output += new TextDecoder().decode(bytes)
    },
    reset: () => {
      record.resets++
      record.output = ''
    },
    summary: next => record.summaries.push(next),
    closed: () => record.closed++,
    connection: state => record.states.push(state),
    inputFailed: text => record.failures.push(text),
  }
  return { record, sink }
}

const b64 = (text: string) => Buffer.from(text).toString('base64')

describe('terminal stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replays first, then reconnects after a cut from the last offset, and stops at closed', async () => {
    const urls: string[] = []
    const answers = [
      sse([
        ['terminal', summary('t', '1')],
        ['output', { offset: 10, data: b64('$ ls\r\n') }],
      ]),
      sse([
        ['terminal', summary('t', '1', { busy: true, foreground: 'vim' })],
        ['output', { offset: 16, data: b64('a.txt\r\n') }],
        ['closed', {}],
      ]),
    ]
    const fetch = vi.fn(async (url: string) => {
      urls.push(url)
      return answers.shift() ?? new Response(null, { status: 500 })
    })
    const { record, sink } = recorder()
    const link = new TerminalLink('s', 't', sink, { fetch: fetch as unknown as typeof globalThis.fetch, initialDelayMs: 1, maxDelayMs: 1 })
    link.start()
    await vi.waitFor(() => expect(record.closed).toBe(1))
    expect(urls).toEqual(['/link/api/tasks/s/terminals/t/stream', '/link/api/tasks/s/terminals/t/stream?from=16'])
    expect(record.output).toBe('$ ls\r\na.txt\r\n')
    expect(link.offset).toBe(23)
    expect(record.summaries.at(-1)).toMatchObject({ busy: true, foreground: 'vim' })
    expect(record.states).toEqual(['live', 'reconnecting', 'live'])
    link.close()
  })

  it('clears the screen on reset and continues from where the Host still has output', async () => {
    const answers = [
      sse([
        ['reset', { offset: 900 }],
        ['output', { offset: 900, data: b64('later\r\n') }],
        ['closed', {}],
      ]),
    ]
    const { record, sink } = recorder()
    const link = new TerminalLink('s', 't', sink, { fetch: (async () => answers.shift()!) as unknown as typeof fetch })
    link.offset = 12
    link.start()
    await vi.waitFor(() => expect(record.closed).toBe(1))
    expect(record.resets).toBe(1)
    expect(record.output).toBe('later\r\n')
    expect(link.offset).toBe(907)
  })

  it('treats a terminal the Host no longer knows as closed, without retrying', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'terminal-not-found' }, { status: 404 }))
    const { record, sink } = recorder()
    new TerminalLink('s', 't', sink, { fetch: fetch as unknown as typeof globalThis.fetch, initialDelayMs: 1 }).start()
    await vi.waitFor(() => expect(record.closed).toBe(1))
    await new Promise(done => setTimeout(done, 20))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('holds the stream while the screen has not parsed what it was given', async () => {
    const big = 'x'.repeat(200 * 1024)
    let release: () => void = () => {}
    const parsed = new Promise<void>(resolve => {
      release = resolve
    })
    let pulled = 0
    const frames = [
      `event: output\ndata: ${JSON.stringify({ offset: 0, data: b64(big) })}\n\n`,
      `event: output\ndata: ${JSON.stringify({ offset: big.length, data: b64(big) })}\n\n`,
      `event: output\ndata: ${JSON.stringify({ offset: big.length * 2, data: b64('end') })}\n\n`,
      'event: closed\ndata: {}\n\n',
    ]
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = frames.shift()
          if (next === undefined) controller.close()
          else {
            pulled++
            controller.enqueue(new TextEncoder().encode(next))
          }
        },
      },
      { highWaterMark: 0 },
    )
    const { record, sink } = recorder()
    sink.write = bytes => {
      record.output += new TextDecoder().decode(bytes)
      return parsed
    }
    const link = new TerminalLink('s', 't', sink, { fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch })
    link.start()
    await vi.waitFor(() => expect(record.output.length).toBe(big.length * 2))
    await new Promise(done => setTimeout(done, 30))
    // Past the high-water mark the third frame is not read until the screen catches up.
    expect(pulled).toBe(2)
    release()
    await vi.waitFor(() => expect(record.closed).toBe(1))
    expect(record.output.endsWith('end')).toBe(true)
  })

  it('sends input one call at a time, in order, and retries a call the Host refused for now', async () => {
    const bodies: string[] = []
    let busy = 1
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { data } = JSON.parse(String(init.body)) as { data: string }
        if (busy-- > 0) return Response.json({ error: 'terminal-input-busy', message: '稍后' }, { status: 429 })
        bodies.push(Buffer.from(data, 'base64').toString())
        return Response.json({ accepted: true })
      }),
    )
    const { record, sink } = recorder()
    const link = new TerminalLink('s', 't', sink, { busyDelayMs: 1 })
    link.send('l')
    link.send('s')
    link.send('\r')
    await vi.waitFor(() => expect(bodies).toEqual(['l', 's', '\r']))
    expect(record.failures).toEqual([])
  })

  it('drops the rest of the queue when an input call fails, and says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network')
      }),
    )
    const { record, sink } = recorder()
    const link = new TerminalLink('s', 't', sink)
    link.send('a')
    link.send('b')
    await vi.waitFor(() => expect(record.failures).toHaveLength(1))
    expect(record.failures[0]).toBe('输入可能没有送达终端')
  })

  it('builds the stream path with the offset to continue from', () => {
    expect(streamPath('s 1', 't/2')).toBe('tasks/s%201/terminals/t%2F2/stream')
    expect(streamPath('s', 't', 0)).toBe('tasks/s/terminals/t/stream?from=0')
  })
})
