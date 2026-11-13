import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClipboardError, writeClipboard } from '@latch/ui'
import {
  api,
  ApiError,
  ApiTimeoutError,
  ClientError,
  errorMessage,
  isUncertain,
  MessageError,
  NoAnswerError,
  setErrorComputer,
} from '../src/core/api.ts'
import { readPluginBundle } from '../src/settings/pluginAssets.ts'
import { readTreeFile } from '../src/preview/treeFiles.ts'
import { hostIsOlder, oldHostWords } from '../src/core/build.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setErrorComputer('Mac')
})

describe('errorMessage', () => {
  it('keeps the Host’s and the page’s own words', () => {
    expect(errorMessage(new ApiError(409, 'conflict', '会话已在运行。'))).toBe('会话已在运行。')
    expect(errorMessage(new ApiTimeoutError())).toBe(new ApiTimeoutError().message)
    expect(errorMessage(new ClientError('确认被拒绝。', 'denied'))).toBe('确认被拒绝。')
    expect(errorMessage(new ClipboardError())).toBe('复制不可用，请手动选择')
  })

  it('shows the page’s own words for the person as they are, and keeps a write behind them unknown', async () => {
    const thrown = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        return error
      }
      return undefined
    }
    const bundle = thrown(() => readPluginBundle('not json'))
    expect(bundle).toBeInstanceOf(MessageError)
    expect(errorMessage(bundle)).toBe('请选择有效的 .latch-plugin.json 文件，文件总大小不超过 8 MiB。')
    const tree = await readTreeFile({ kind: 'session', sessionId: 's' } as never, {} as never, new AbortController().signal).catch(
      (error: unknown) => error,
    )
    expect(errorMessage(tree)).toBe('文件引用无效。')
    const wrapped = new MessageError('没有保存。', { cause: new ApiError(409, 'conflict', '冲突') })
    expect(errorMessage(wrapped)).toBe('没有保存。')
    expect(wrapped.cause).toBeInstanceOf(ApiError)
    expect(isUncertain(wrapped)).toBe(true)
  })

  it('names the computer only when a request got no answer', () => {
    setErrorComputer('这台 Mac')
    expect(errorMessage(new NoAnswerError())).toBe('连不上 这台 Mac 上的 Latch')
  })

  it('calls a bug in the page a bug, with its name, and logs it once', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')")
    expect(errorMessage(bug)).toBe('页面出错了（TypeError）· 刷新')
    expect(errorMessage(bug)).toBe('页面出错了（TypeError）· 刷新')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![1]).toBe(bug)
    expect(errorMessage(new RangeError('x'))).toBe('页面出错了（RangeError）· 刷新')
    expect(errorMessage('text')).toBe('页面出错了（Error）· 刷新')
    expect(errorMessage(new DOMException('aborted', 'AbortError'))).toBe('已取消')
  })

  it('turns only fetch’s own failure into no answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(api('snapshot')).rejects.toBeInstanceOf(NoAnswerError)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    )
    const thrown = await api('snapshot', {
      onHeaders: () => {
        throw new TypeError('bug in a caller')
      },
    }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(TypeError)
    expect(thrown).not.toBeInstanceOf(NoAnswerError)
    // A request the page got wrong never leaves it, and is the page's error, not a lost connection.
    const send = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', send)
    const invalid = await api('tasks', { method: 'POST', confirmation: '确认' }).catch((error: unknown) => error)
    expect(invalid).toBeInstanceOf(TypeError)
    expect(invalid).not.toBeInstanceOf(NoAnswerError)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('writeClipboard', () => {
  function page(copied: boolean | 'throws') {
    const written: string[] = []
    const area = {
      value: '',
      readOnly: false,
      tabIndex: 0,
      style: {},
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    }
    const focus = vi.fn()
    const document = {
      body: { append: vi.fn() },
      activeElement: { focus, closest: () => null },
      getSelection: () => ({ rangeCount: 0 }),
      createElement: () => area,
      execCommand: vi.fn((command: string) => {
        if (copied === 'throws') throw new Error('denied')
        if (command === 'copy' && copied) written.push(area.value)
        return copied
      }),
    }
    vi.stubGlobal('document', document)
    return { written, area, focus, document }
  }

  it('uses the Clipboard API when the page has it', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { document } = page(true)
    await writeClipboard('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  it('copies through a hidden selection where the API is missing, as on http://<LAN IP>', async () => {
    vi.stubGlobal('navigator', {})
    const { written, area, focus } = page(true)
    await writeClipboard('hello')
    expect(written).toEqual(['hello'])
    expect(area.select).toHaveBeenCalled()
    expect(area.remove).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
  })

  it('falls back when the API refuses, and fails only when both ways fail', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new DOMException('denied', 'NotAllowedError')
        },
      },
    })
    const ok = page(true)
    await writeClipboard('again')
    expect(ok.written).toEqual(['again'])
    page(false)
    await expect(writeClipboard('again')).rejects.toBeInstanceOf(ClipboardError)
    vi.stubGlobal('navigator', {})
    page('throws')
    await expect(writeClipboard('again')).rejects.toBeInstanceOf(ClipboardError)
  })
})

describe('old Host notice', () => {
  const page = '20261113T101500Z-abcdef'
  it('shows when the Host started before this page was built, or reports no build', () => {
    expect(hostIsOlder('20261107T080000Z-123456', page)).toBe(true)
    expect(hostIsOlder(undefined, page)).toBe(true)
    expect(hostIsOlder(page, page)).toBe(false)
    // A tab left open across a restart is older than its Host, not the other way round.
    expect(hostIsOlder('20261114T000000Z-123456', page)).toBe(false)
    // The development server and tests have no build.
    expect(hostIsOlder(undefined, '')).toBe(false)
    const words = oldHostWords('这台 Mac')
    expect(`${words.title} · ${words.label}`).toBe('这台 Mac 上的 Latch 还是旧版本 · 重启 Latch 后才能用新功能')
  })
})
