// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAvatar as Avatar } from '@latch/protocol'
import { AgentAvatar } from '../src/agents/AgentAvatar.tsx'
import { AVATAR_FILE_BYTES, AVATAR_PROBLEM_WORDS, centreSquare, preparePicture, sniffPicture } from '../src/agents/avatarImage.ts'
import { hostProblem, PictureRow, type PictureUpload } from '../src/agents/AvatarPicture.tsx'
import { BRACKET_PATHS } from '../src/agents/avatarFace.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bytes = (text: string) => Uint8Array.from(text, letter => letter.charCodeAt(0))
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
function pngHeader(width: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(33)
  header.set(PNG)
  header.set(bytes('IHDR'), 12)
  const fields = new DataView(header.buffer)
  fields.setUint32(16, width)
  fields.setUint32(20, 24)
  header.set([8, 2], 24)
  return header
}
function jpegHeader(width: number): Uint8Array<ArrayBuffer> {
  const header = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 24, 0, 0, 1, 1, 0x11, 0)
  new DataView(header.buffer).setUint16(9, width)
  return header
}
function webpHeader(width: number): Uint8Array<ArrayBuffer> {
  const header = bytes(
    'RIFF\u0016\u0000\u0000\u0000WEBPVP8X\u000a\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0017\u0000\u0000',
  )
  new DataView(header.buffer).setUint16(24, width - 1, true)
  return header
}
const row = (upload: PictureUpload, extra: { hasPicture?: boolean; disabled?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(PictureRow, {
      hasPicture: extra.hasPicture ?? false,
      upload,
      disabled: extra.disabled ?? false,
      onChoose: () => {},
      onRetry: () => {},
      onClear: () => {},
      onReload: () => {},
    }),
  )
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>(?:<[^>]+>)*([^<]*)/gu)].map(match => ({ tag: match[0], disabled: match[0].includes('disabled') }))

describe('a chosen picture, before any of it is decoded', () => {
  it('is known by its first bytes, never by its name or the type the browser reports', () => {
    expect(sniffPicture(PNG)).toBe('png')
    expect(sniffPicture(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1]))).toBe('jpeg')
    expect(sniffPicture(bytes('RIFF\u0000\u0000\u0000\u0000WEBPVP8L'))).toBe('webp')
    for (const other of [
      'MZ\u0090\u0000',
      '#!/bin/sh',
      '<svg xmlns="http://www.w3.org/2000/svg">',
      'GIF89a',
      'RIFF\u0000\u0000\u0000\u0000WAVE',
      '%PDF-1.7',
      '',
    ])
      expect(sniffPicture(bytes(other))).toBeUndefined()
  })

  it('says one of three things: too large, wrong type, could not read', async () => {
    const oversized = new Blob()
    Object.defineProperty(oversized, 'size', { value: AVATAR_FILE_BYTES + 1 })
    const read = vi.spyOn(oversized, 'arrayBuffer')
    expect(await preparePicture(oversized)).toEqual({ problem: 'too-large' })
    expect(read).not.toHaveBeenCalled()
    expect(await preparePicture(new Blob([bytes('MZ\u0090\u0000')]))).toEqual({ problem: 'wrong-type' })
    expect(await preparePicture(new Blob(['<svg>']))).toEqual({ problem: 'wrong-type' })
    expect(await preparePicture(new Blob())).toEqual({ problem: 'unreadable' })
    expect(AVATAR_PROBLEM_WORDS).toEqual({
      'too-large': '图片太大',
      'wrong-type': '只能用 PNG、JPEG 或 WebP',
      unreadable: '读不了这张图片',
    })
    // The Host's refusals read as the same three.
    expect(hostProblem('agent-avatar-too-large')).toBe('too-large')
    expect(hostProblem('agent-avatar-type')).toBe('wrong-type')
    expect(hostProblem('agent-avatar-convert')).toBe('wrong-type')
    expect(hostProblem('agent-avatar-unreadable')).toBe('unreadable')
    expect(hostProblem('agent-scope-required')).toBeUndefined()
  })

  it('takes the centre square', () => {
    expect(centreSquare(300, 200)).toEqual({ x: 50, y: 0, side: 200 })
    expect(centreSquare(200, 301)).toEqual({ x: 0, y: 50, side: 200 })
    expect(centreSquare(64, 64)).toEqual({ x: 0, y: 0, side: 64 })
  })

  it.each([
    ['PNG', pngHeader, 22],
    ['JPEG', jpegHeader, 8],
    ['WebP', webpHeader, 28],
  ] as const)('bounds %s from its header before calling the image decoder', async (_kind, header, truncated) => {
    const decode = vi.fn().mockRejectedValue(new Error('The fixture stops after the header'))
    vi.stubGlobal('createImageBitmap', decode)
    try {
      const allowed = new Blob([header(48)])
      const tooLarge = new Blob([header(9000)])
      const incomplete = new Blob([header(48).slice(0, truncated)])
      expect(await preparePicture(allowed)).toEqual({ problem: 'unreadable' })
      expect(decode).toHaveBeenCalledExactlyOnceWith(allowed)
      decode.mockClear()
      const rejected = await Promise.all([preparePicture(tooLarge), preparePicture(incomplete)])
      expect(rejected).toEqual([{ problem: 'too-large' }, { problem: 'unreadable' }])
      expect(decode).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('an Agent with a picture', () => {
  const pictured = { kind: 'image', image: 'a'.repeat(64), bracket: 'curly', eyes: 'arc', hue: 'plum' } satisfies Avatar
  let host: HTMLDivElement | undefined
  let root: Root | undefined
  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host?.remove()
    host = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const show = (...hashes: string[]) => {
    if (!root) {
      host = document.body.appendChild(document.createElement('div'))
      root = createRoot(host)
    }
    return act(async () =>
      root!.render(
        hashes.map((hash, index) =>
          createElement(AgentAvatar, { key: index, avatar: { ...pictured, image: hash }, still: true, size: 40 }),
        ),
      ),
    )
  }
  const pictures = () => [...host!.querySelectorAll('image')].map(element => element.getAttribute('href'))

  it('is its face until this page has read the picture, and whenever it cannot: never a broken image, never a data URL', () => {
    const html = renderToStaticMarkup(createElement(AgentAvatar, { avatar: pictured, size: 40 }))
    for (const d of BRACKET_PATHS.curly) expect(html).toContain(`d="${d}"`)
    expect(html).toContain('data-hue="plum"')
    expect(html).not.toContain('<image')
    expect(html).not.toContain('data:')
    expect(html).not.toContain('data-picture')
  })

  it('reads only well-formed hashes', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await show('../../etc/passwd', 'A'.repeat(64), '')
    expect(fetch).not.toHaveBeenCalled()
    expect(pictures()).toEqual([])
  })

  it('shares a picture while it is used, revokes replaced URLs, and checks permission on a later mount', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', fetch)
    let number = 0
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:avatar-${++number}`)
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    await show(pictured.image, pictured.image)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(pictures()).toEqual(['blob:avatar-1', 'blob:avatar-1'])
    await show(pictured.image)
    expect(revoke).not.toHaveBeenCalled()
    expect(pictures()).toEqual(['blob:avatar-1'])
    for (let index = 0; index < 24; index++) {
      await show(index.toString(16).padStart(64, '0'))
      expect(revoke).toHaveBeenLastCalledWith(`blob:avatar-${index + 1}`)
      expect(pictures()).toEqual([`blob:avatar-${index + 2}`])
    }
    await show()
    expect(revoke.mock.calls).toEqual(create.mock.calls.map((_, index) => [`blob:avatar-${index + 1}`]))

    fetch.mockResolvedValueOnce(new Response('{}', { status: 403 }))
    await show(pictured.image)
    expect(fetch).toHaveBeenCalledTimes(26)
    expect(pictures()).toEqual([])
    await show()
    await show(pictured.image)
    expect(fetch).toHaveBeenCalledTimes(27)
    expect(pictures()).toEqual(['blob:avatar-26'])
  })

  it('aborts an unfinished read after its last avatar leaves and ignores a late response', async () => {
    const reads: Array<{ signal: AbortSignal; finish: (response: Response) => void }> = []
    vi.stubGlobal(
      'fetch',
      (_target: string, init: RequestInit) =>
        new Promise<Response>(finish => {
          reads.push({ signal: init.signal!, finish })
        }),
    )
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar')
    await show(pictured.image, pictured.image)
    const [first] = reads
    await show(pictured.image)
    expect(first!.signal.aborted).toBe(false)
    await show()
    expect(first!.signal.aborted).toBe(true)
    await show(pictured.image)
    expect(reads).toHaveLength(2)
    await act(async () => first!.finish(new Response(new Uint8Array([1]))))
    expect(create).not.toHaveBeenCalled()
    await act(async () => reads[1]!.finish(new Response(new Uint8Array([2]))))
    expect(pictures()).toEqual(['blob:avatar'])
  })
})

describe('图片, the picker’s last row', () => {
  it('offers 上传 for a face, and 换一张 and 清除 for a picture', () => {
    const face = row({ phase: 'idle' })
    expect(face).toContain('图片')
    expect(face).toContain('上传')
    expect(face).not.toContain('清除')
    expect(face).toContain('accept="image/png,image/jpeg,image/webp"')
    const picture = row({ phase: 'idle' }, { hasPicture: true })
    expect(picture).toContain('换一张')
    expect(picture).toContain('清除')
    expect(buttons(picture).every(button => !button.disabled)).toBe(true)
  })

  it('says what the upload is doing, with its progress, and holds its buttons meanwhile', () => {
    const preparing = row({ phase: 'preparing' }, { hasPicture: true })
    expect(preparing).toContain('正在处理')
    expect(preparing).toContain('aria-busy="true"')
    expect(buttons(preparing).every(button => button.disabled)).toBe(true)
    const uploading = row({ phase: 'uploading', loaded: 30, total: 120, requestId: 'request-1234' })
    expect(uploading).toContain('上传 25%')
    expect(uploading).toContain('aria-busy="true"')
    expect(buttons(uploading).every(button => button.disabled)).toBe(true)
    expect(row({ phase: 'uploading', loaded: 0, total: 0, requestId: 'request-1234' })).toContain('上传 0%')
  })

  it('names each honest failure in its own words, and lets the person choose again', () => {
    for (const problem of ['too-large', 'wrong-type', 'unreadable'] as const) {
      const html = row({ phase: 'refused', problem })
      expect(html).toContain(AVATAR_PROBLEM_WORDS[problem])
      expect(html).toContain('data-tone="failed"')
      expect(html).toContain('role="alert"')
      expect(buttons(html).every(button => !button.disabled)).toBe(true)
    }
    expect(row({ phase: 'refused', message: 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。' })).toContain(
      '请先在电脑上允许这台设备使用',
    )
  })

  it('keeps an unknown result with its request for a retry, and a conflict with a reload', () => {
    const unknown = row({ phase: 'unknown', message: '上传连接中断，Mac 可能已经保存。', requestId: 'request-1234' }, { hasPicture: true })
    expect(unknown).toContain('结果未知')
    expect(unknown).toContain('重试同一请求')
    expect(unknown).toContain('request-1234')
    // Nothing else of the picture changes until that request is settled.
    const [choose, clear] = buttons(unknown)
    expect(choose!.disabled && clear!.disabled).toBe(true)
    const conflict = row({ phase: 'conflict', message: '这项记录已更新，请刷新后再修改。' })
    expect(conflict).toContain('已在别处修改')
    expect(conflict).toContain('载入最新')
    expect(buttons(row({ phase: 'idle' }, { disabled: true })).every(button => button.disabled)).toBe(true)
  })
})
