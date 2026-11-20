import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFileMetadata, type FileMetadata } from '@latch/protocol'
import { MessageContent } from '../src/MessageContent.tsx'
import { InlineMedia, inlineImageWidth } from '../src/components/InlineMedia.tsx'
import { MessageAttachments } from '../src/components/MessageAttachments.tsx'
import { drawableMedia, mediaFromAnswer, mediaTypeOf, resolveFileMedia, trustedMediaUrl } from '../src/preview/fileImages.ts'
import { FileBreadcrumb, writtenPlace } from '../src/preview/FileBreadcrumb.tsx'

const HERE = 'https://latch.test/link/'
const HANDLE = 'A'.repeat(22)
const metadata = (overrides: Partial<FileMetadata> = {}): FileMetadata => ({
  handle: HANDLE,
  name: 'chart.png',
  root: 'default',
  path: 'out/chart.png',
  ext: 'png',
  kind: 'image',
  mime: 'image/png',
  size: 2048,
  mtime: 1,
  etag: `"${'a'.repeat(32)}"`,
  limit: 20 * 1024 * 1024,
  secret: false,
  width: 1536,
  height: 1024,
  actions: { reveal: false, quicklook: false, open: false, download: true, preview: true },
  ...overrides,
})

describe('inline media in a reply', () => {
  it('asks the Host only about references whose extension suggests a picture, video or sound', () => {
    expect(mediaTypeOf('out/chart.PNG')).toBe('image')
    expect(mediaTypeOf('/Users/me/clip.webm')).toBe('video')
    expect(mediaTypeOf('voice.m4a')).toBe('audio')
    expect(mediaTypeOf('diagram.svg')).toBeUndefined()
    expect(mediaTypeOf('report.pdf')).toBeUndefined()
    expect(mediaTypeOf('.png')).toBeUndefined()
  })

  it('draws only a same-origin file or attachment handle, whatever a resolver answers', () => {
    expect(trustedMediaUrl(`/link/api/files/${HANDLE}?v=${'a'.repeat(32)}`, HERE)).toBe(true)
    expect(trustedMediaUrl(`/link/api/attachments/${HANDLE}/content`, HERE)).toBe(true)
    expect(trustedMediaUrl(`https://evil.test/link/api/files/${HANDLE}`, HERE)).toBe(false)
    expect(trustedMediaUrl(`/link/api/files/${HANDLE}?path=/etc/passwd`, HERE)).toBe(false)
    expect(trustedMediaUrl(`/link/api/files/${HANDLE}#x`, HERE)).toBe(false)
    expect(trustedMediaUrl('/link/api/files/short', HERE)).toBe(false)
    expect(trustedMediaUrl('file:///Users/me/.codex/generated_images/a.png', HERE)).toBe(false)
    expect(trustedMediaUrl('data:image/png;base64,AAAA', HERE)).toBe(false)
    expect(drawableMedia({ kind: 'image', url: `/link/api/files/${HANDLE}` }, HERE)).toBe(false)
    expect(drawableMedia({ kind: 'video', url: `/link/api/files/${HANDLE}` }, HERE)).toBe(true)
  })

  it('takes the Host’s word from the file’s bytes: secrets, refused previews and other kinds stay chips', () => {
    expect(mediaFromAnswer({ status: 'ok', file: metadata() })).toEqual({
      kind: 'image',
      url: `/link/api/files/${HANDLE}?v=${'a'.repeat(32)}`,
      width: 1536,
      height: 1024,
      name: 'chart.png',
      download: true,
    })
    expect(
      mediaFromAnswer({ status: 'ok', file: metadata({ kind: 'video', mime: 'video/mp4', width: undefined, height: undefined }) })?.kind,
    ).toBe('video')
    expect(mediaFromAnswer({ status: 'ok', file: metadata({ kind: 'audio', mime: 'audio/mpeg' }) })?.kind).toBe('audio')
    expect(mediaFromAnswer({ status: 'ok', file: metadata({ secret: true }) })).toBeUndefined()
    expect(mediaFromAnswer({ status: 'ok', file: metadata({ actions: { ...metadata().actions, preview: false } }) })).toBeUndefined()
    expect(mediaFromAnswer({ status: 'ok', file: metadata({ width: undefined }) })).toBeUndefined()
    expect(mediaFromAnswer({ status: 'ok', file: metadata({ kind: 'svg', mime: 'image/svg+xml' }) })).toBeUndefined()
    expect(mediaFromAnswer({ status: 'ok', file: metadata({ kind: 'video', mime: 'application/octet-stream' }) })).toBeUndefined()
    expect(mediaFromAnswer({ status: 'outside-roots' })).toBeUndefined()
    expect(mediaFromAnswer({ status: 'ok', file: { ...metadata(), handle: '../x' } })).toBeUndefined()
  })

  it('reserves a picture’s shape from its size and keeps a tall one within the height cap', () => {
    const html = renderToStaticMarkup(
      createElement(InlineMedia, { media: { kind: 'image', url: '/x', width: 1536, height: 1024 }, label: '图表' }),
    )
    expect(html).toContain('width="1536"')
    expect(html).toContain('height="1024"')
    expect(html).toContain('aria-label="预览图片：图表"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toMatch(/^<button type="button" class="inline-media inline-media-open"/u)
    expect(inlineImageWidth(1536, 1024)).toBe('min(100%, 720px)')
    expect(inlineImageWidth(1024, 1536)).toBe('min(100%, 320px)')
    expect(inlineImageWidth(64, 40)).toBe('min(100%, 64px)')
  })

  it('plays video and sound with the browser’s own controls, loading only their metadata first', () => {
    const video = renderToStaticMarkup(createElement(InlineMedia, { media: { kind: 'video', url: '/v' }, label: 'clip.webm' }))
    expect(video).toMatch(/<video[^>]* controls=""[^>]* preload="metadata"[^>]* playsInline=""/u)
    const audio = renderToStaticMarkup(createElement(InlineMedia, { media: { kind: 'audio', url: '/a' }, label: 'voice.m4a' }))
    expect(audio).toMatch(/<audio[^>]* controls=""[^>]* preload="metadata"/u)
  })

  it('leaves a linked picture its path chip until the Host has authorized it, and never draws a path by itself', () => {
    for (const text of [
      '[下载 PNG 原图](/Users/me/.codex/generated_images/ig_1.png)',
      '看看 [chart.png](out/chart.png)',
      '[clip](out/clip.mp4)',
    ]) {
      const html = renderToStaticMarkup(createElement(MessageContent, { text }))
      expect(html).toContain('file-chip')
      expect(html).not.toMatch(/<(img|video|audio)\b/u)
    }
  })

  it('draws an agent’s picture as a tile until a session can authorize it', () => {
    const html = renderToStaticMarkup(
      createElement(MessageAttachments, {
        attachments: [
          {
            id: HANDLE,
            name: 'Agent-image.png',
            mime: 'image/png',
            kind: 'image',
            size: 2048,
            sha256: 'b'.repeat(64),
            width: 96,
            height: 64,
          },
        ],
        output: true,
        inline: true,
      }),
    )
    expect(html).toContain('data-inline=""')
    expect(html).toContain('attachment-tile')
    expect(html).not.toContain('<img')
  })
})

describe('a picture the conversation names outside the session folders', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const generated = '/Users/me/.codex/generated_images/ig_1/ig_1.png'
  const outside = metadata({
    root: `outside-${'b'.repeat(24)}`,
    path: 'ig_1.png',
    name: 'ig_1.png',
    folder: '/Users/me/.codex/generated_images/ig_1',
  })

  it('asks the Host about the path exactly as written and draws the handle it answers', async () => {
    const asked: unknown[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      asked.push([url, JSON.parse(String(init?.body))])
      return new Response(JSON.stringify({ files: [{ status: 'ok', file: outside }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const media = await resolveFileMedia('session-1', generated, 'primary', new AbortController().signal)
    expect(asked).toEqual([['/link/api/tasks/session-1/files/resolve', { paths: [generated], rootId: 'primary' }]])
    expect(media).toEqual({
      kind: 'image',
      url: `/link/api/files/${HANDLE}?v=${'a'.repeat(32)}`,
      width: 1536,
      height: 1024,
      name: 'ig_1.png',
      download: true,
    })
    expect(drawableMedia(media, HERE)).toBe(true)
  })

  it('keeps an outside answer to a whole folder path; a relative one is not a file’s answer', () => {
    expect(isFileMetadata(outside)).toBe(true)
    expect(isFileMetadata({ ...outside, folder: 'generated_images' })).toBe(false)
    expect(mediaFromAnswer({ status: 'not-referenced' })).toBeUndefined()
    expect(mediaFromAnswer({ status: 'protected' })).toBeUndefined()
  })

  it('names its folder plainly in the file pane, never as a session folder to walk', () => {
    expect(writtenPlace(generated)).toEqual({ folder: '/Users/me/.codex/generated_images/ig_1', name: 'ig_1.png' })
    expect(writtenPlace(`file://${generated}`)?.folder).toBe('/Users/me/.codex/generated_images/ig_1')
    expect(writtenPlace('~/Desktop/a.png')).toEqual({ folder: '~/Desktop', name: 'a.png' })
    expect(writtenPlace('out/chart.png')).toBeUndefined()
    const html = renderToStaticMarkup(
      createElement(FileBreadcrumb, {
        context: { kind: 'session', sessionId: 's' },
        rootName: '会话文件夹',
        path: 'ig_1.png',
        name: 'ig_1.png',
        folder: '/Users/me/.codex/generated_images/ig_1',
        attachment: false,
        browsable: true,
        onOpen: () => {},
      }),
    )
    expect(html).toContain('/Users/me/.codex/generated_images/ig_1')
    expect(html).not.toContain('会话文件夹')
    expect(html).not.toContain('aria-haspopup')
  })
})
