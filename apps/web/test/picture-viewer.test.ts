// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InlineMedia } from '../src/components/InlineMedia.tsx'
import { PictureGroup } from '../src/components/PictureViewer.tsx'
import {
  fitScale,
  inReadingOrder,
  openViewer,
  returnTarget,
  stepViewer,
  swipeOutcome,
  toggleZoom,
  zoomable,
  type ViewerPicture,
} from '../src/components/pictureViewer.ts'
import { mediaBytes } from '../src/preview/fileImages.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HANDLE = 'A'.repeat(22)
const url = (n: number) => `/link/api/files/${String(n).repeat(22).slice(0, 22)}?v=${'a'.repeat(32)}`

function picture(id: string, element: HTMLElement | null, overrides: Partial<ViewerPicture> = {}): ViewerPicture {
  return { id, url: `/link/api/files/${id.padEnd(22, 'x')}`, name: id, download: false, element: () => element, ...overrides }
}

describe('the picture viewer’s state', () => {
  it('orders a turn’s pictures as they stand on the page, whatever order they registered in', () => {
    const list = document.createElement('div')
    const [a, b, c] = [0, 1, 2].map(() => list.appendChild(document.createElement('button')))
    const ordered = inReadingOrder([picture('c', c!), picture('a', a!), picture('gone', null), picture('b', b!)])
    expect(ordered.map(item => item.id)).toEqual(['a', 'b', 'c', 'gone'])
  })

  it('opens on the pressed picture, and the same file drawn twice is one stop', () => {
    const same = { url: url(1) }
    const pictures = [picture('link', null, same), picture('markdown', null, same), picture('other', null, { url: url(2) })]
    const state = openViewer(pictures, 'markdown')!
    expect(state.pictures.map(item => item.id)).toEqual(['markdown', 'other'])
    expect(state.index).toBe(0)
    expect(state.zoomed).toBe(false)
    expect(openViewer(pictures, 'missing')).toBeUndefined()
  })

  it('steps forward and back, stays at either end, and shows each new picture fitted', () => {
    const state = { ...openViewer([picture('a', null), picture('b', null), picture('c', null)], 'a')!, zoomed: true }
    const second = stepViewer(state, 1)
    expect([second.index, second.zoomed]).toEqual([1, false])
    expect(stepViewer(stepViewer(second, 1), 1).index).toBe(2)
    expect(stepViewer(state, -1)).toBe(state)
  })

  it('fits without cropping and never past the natural size, and zooms only what is larger than the room', () => {
    const room = { width: 1000, height: 600 }
    expect(fitScale({ width: 2000, height: 1000 }, room)).toBe(0.5)
    expect(fitScale({ width: 800, height: 1200 }, room)).toBe(0.5)
    expect(fitScale({ width: 400, height: 300 }, room)).toBe(1)
    expect(zoomable({ width: 400, height: 300 }, room)).toBe(false)
    const state = openViewer([picture('a', null)], 'a')!
    expect(toggleZoom(state, { width: 400, height: 300 }, room)).toBe(state)
    const zoomed = toggleZoom(state, { width: 2000, height: 1000 }, room)
    expect(zoomed.zoomed).toBe(true)
    // Back to fit even when the room grew meanwhile.
    expect(toggleZoom(zoomed, { width: 400, height: 300 }, room).zoomed).toBe(false)
  })

  it('gives focus back to the picture last shown, else to the one pressed', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const [first, second] = [0, 1].map(() => host.appendChild(document.createElement('button')))
    const state = stepViewer(openViewer([picture('a', first!), picture('b', second!)], 'a')!, 1)
    expect(returnTarget(state, first!)).toBe(second)
    second!.remove()
    expect(returnTarget(state, first!)).toBe(first)
    host.remove()
  })

  it('reads a finished swipe: across steps, down closes, a short drag snaps back', () => {
    expect(swipeOutcome(-120, 10, 300)).toBe('next')
    expect(swipeOutcome(120, -10, 300)).toBe('previous')
    expect(swipeOutcome(-30, 0, 40)).toBe('next')
    expect(swipeOutcome(10, 140, 400)).toBe('close')
    expect(swipeOutcome(0, -140, 400)).toBe('none')
    expect(swipeOutcome(20, 30, 600)).toBe('none')
  })

  it('downloads only through the authorized handle it draws from', async () => {
    const asked: Array<[string, string | null]> = []
    vi.stubGlobal('fetch', async (target: string, init?: RequestInit) => {
      asked.push([target, new Headers(init?.headers).get('if-match')])
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    })
    try {
      const here = 'https://latch.test/link/'
      expect((await mediaBytes(`/link/api/files/${HANDLE}?v=${'b'.repeat(32)}`, here)).byteLength).toBe(3)
      await mediaBytes(`/link/api/attachments/${HANDLE}/content`, here)
      await expect(mediaBytes('https://evil.test/x.png', here)).rejects.toThrow()
      expect(asked).toEqual([
        [`/link/api/files/${HANDLE}`, `"${'b'.repeat(32)}"`],
        [`/link/api/attachments/${HANDLE}/content`, null],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('pressing a picture in a message', () => {
  let root: Root | undefined
  let host: HTMLElement | undefined
  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = undefined
  })

  function mount(openInFiles: () => void) {
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    const media = (n: number, label: string) =>
      createElement(InlineMedia, {
        key: label,
        media: { kind: 'image', url: url(n), width: 960, height: 600, name: `${label}.png`, download: true },
        label,
        openInFiles,
      })
    act(() => root!.render(createElement(PictureGroup, null, createElement(Fragment, null, media(1, '销量图'), media(2, '趋势图')))))
    return [...host.querySelectorAll<HTMLButtonElement>('button.inline-media-open')]
  }
  const viewer = () => document.querySelector<HTMLDialogElement>('dialog.picture-viewer')

  it('shows it large over the page instead of opening the file pane, steps, and gives focus back on close', () => {
    const openInFiles = vi.fn()
    const [first, second] = mount(openInFiles)
    expect(first!.getAttribute('aria-label')).toBe('预览图片：销量图')
    first!.focus()
    act(() => first!.click())
    expect(openInFiles).not.toHaveBeenCalled()
    const dialog = viewer()!
    expect(dialog.getAttribute('aria-label')).toBe('销量图')
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe(url(1))
    expect(dialog.querySelector('.picture-viewer-count')!.textContent).toBe('1 / 2')
    expect(dialog.contains(document.activeElement)).toBe(true)
    // ← → step through the turn's pictures.
    act(() => {
      dialog.querySelector('.picture-viewer-stage')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(viewer()!.getAttribute('aria-label')).toBe('趋势图')
    expect(viewer()!.querySelector('.picture-viewer-count')!.textContent).toBe('2 / 2')
    act(() => viewer()!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click())
    expect(viewer()).toBeNull()
    // The picture last shown takes focus back.
    expect(document.activeElement).toBe(second)
  })

  it('opens the file pane only from the viewer’s 在文件中打开, and closes the viewer', () => {
    const openInFiles = vi.fn()
    const [first] = mount(openInFiles)
    act(() => first!.click())
    act(() => viewer()!.querySelector<HTMLButtonElement>('button[aria-label="在文件中打开"]')!.click())
    expect(openInFiles).toHaveBeenCalledTimes(1)
    expect(viewer()).toBeNull()
  })
})
