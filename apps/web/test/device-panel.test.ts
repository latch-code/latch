import { describe, expect, it } from 'vitest'
import {
  appendLines,
  chooseDevice,
  clock,
  deviceLabel,
  panelShortcut,
  parseApps,
  parseCatalog,
  parseOrientation,
  parseRecording,
  parseSimulators,
  shotName,
  sortDevices,
  typesFor,
} from '../src/panel/device/model.ts'
import {
  annotatedName,
  arrowHead,
  begin,
  draw,
  extend,
  kept,
  lineWidth,
  toImagePoint,
  type Pen,
  type Shape,
} from '../src/panel/device/annotate.ts'
import { fitScale, parseZoom, screenSize, zoomIn, zoomLabel, zoomOut } from '../src/panel/device/zoom.ts'
import { panelChoices } from '../src/panel/panelTabs.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('设备 panel', () => {
  it('reads the Host’s list, leaving out anything malformed', () => {
    expect(
      parseSimulators({
        xcode: true,
        agentUnnamed: true,
        devices: [
          { udid: A, name: 'latch-test', os: 'iOS 27.2', state: 'shutdown', ours: false },
          { udid: B, name: 'iPhone 18 Pro', os: 'iOS 27.2', state: 'booted', ours: true, shown: true, agent: true },
          { udid: 'booted', name: 'x', os: 'iOS', state: 'booted' },
          { udid: 'abcdef00-1111-4111-8111-111111111111', name: 'x', os: 'iOS', state: 'booted' },
          { udid: A, name: 'x', os: 'iOS', state: 'exploded' },
        ],
      }),
    ).toEqual({
      xcode: true,
      agentUnnamed: true,
      abilities: { rotate: false, record: false, logs: false },
      devices: [
        { udid: A, name: 'latch-test', os: 'iOS 27.2', state: 'shutdown', ours: false },
        { udid: B, name: 'iPhone 18 Pro', os: 'iOS 27.2', state: 'booted', ours: true, shown: true, agent: true },
      ],
    })
    expect(parseSimulators(null)).toEqual({ xcode: false, devices: [], abilities: { rotate: false, record: false, logs: false } })
    expect(parseSimulators({ xcode: true, devices: [], abilities: { rotate: true, record: 'yes', logs: true } }).abilities).toEqual({
      rotate: true,
      record: false,
      logs: true,
    })
  })

  it('shows the chosen device, else a running one, and never picks one that would need booting', () => {
    const list = parseSimulators({
      xcode: true,
      devices: [
        { udid: A, name: 'b', os: 'iOS 27.2', state: 'shutdown' },
        { udid: B, name: 'a', os: 'iOS 27.2', state: 'shutdown' },
      ],
    }).devices
    expect(chooseDevice(list, undefined)).toBeUndefined()
    expect(chooseDevice(list, A)?.udid).toBe(A)
    expect(
      chooseDevice(
        [...list, { udid: '33333333-3333-4333-8333-333333333333', name: 'c', os: 'iOS', state: 'booted', ours: false }],
        undefined,
      )?.name,
    ).toBe('c')
    expect(sortDevices(list).map(device => device.name)).toEqual(['a', 'b'])
    expect(deviceLabel({ name: 'iPhone 18', os: 'iOS 27.2' })).toBe('iPhone 18 · iOS 27.2')
    expect(shotName({ name: 'iPhone/18' }, new Date(2026, 10, 16, 9, 5, 7))).toBe('iPhone18-20261116-090507.png')
  })

  it('is offered after 浏览器 with the letter V, only when the Host offers it', () => {
    expect(panelChoices({ browser: true, device: true, terminal: true }).map(choice => [choice.key, choice.letter])).toEqual([
      ['browser', 'B'],
      ['device', 'V'],
      ['terminal', 'T'],
    ])
    expect(panelChoices({ browser: true }).some(choice => choice.key === 'device')).toBe(false)
  })

  it('reads the Host’s other answers defensively', () => {
    expect(parseOrientation({ supported: true, orientation: 'landscapeLeft' })).toEqual({ supported: true, orientation: 'landscapeLeft' })
    expect(parseOrientation({ supported: 'yes', orientation: 'sideways' })).toEqual({ supported: false, orientation: null })
    expect(
      parseApps({
        apps: [
          { bundleId: 'com.apple.mobilesafari', name: 'Safari', kind: 'system' },
          { bundleId: '-x', name: 'bad', kind: 'user' },
          { bundleId: 'com.example.app', name: 'Mine', kind: 'user' },
        ],
      }),
    ).toEqual([
      { bundleId: 'com.apple.mobilesafari', name: 'Safari', kind: 'system' },
      { bundleId: 'com.example.app', name: 'Mine', kind: 'user' },
    ])
    expect(parseRecording({ state: 'ready', seconds: 4, ended: 'size' })).toEqual({ state: 'ready', seconds: 4, ended: 'size' })
    expect(parseRecording({ state: 'gone' })).toEqual({ state: 'none' })
    const catalog = parseCatalog({
      deviceTypes: [
        { id: 'ipad', name: 'iPad Pro', family: 'iPad' },
        { id: 'b', name: 'iPhone B', family: 'iPhone' },
        { id: 'a', name: 'iPhone A', family: 'iPhone' },
        { id: 'tv', name: 'Apple TV', family: 'Apple TV' },
      ],
      runtimes: [{ id: 'ios', name: 'iOS 27.2', deviceTypes: ['tv', 'ipad', 'a', 'b', 7] }],
    })
    expect(typesFor(catalog, 'ios').map(type => type.id)).toEqual(['a', 'b', 'ipad', 'tv'])
    expect(typesFor(catalog, 'none')).toEqual([])
    expect(shotName({ name: 'x' }, new Date(2026, 0, 2, 3, 4, 5), 'mp4')).toBe('x-20260102-030405.mp4')
    expect(clock(67.9)).toBe('1:07')
  })

  it('keeps the newest thousand log lines, each at most a thousand characters', () => {
    const many = Array.from({ length: 1200 }, (_, index) => String(index))
    const kept = appendLines(['old'], many)
    expect(kept).toHaveLength(1000)
    expect(kept[0]).toBe('200')
    expect(appendLines([], ['y'.repeat(2000)])[0]).toHaveLength(1000)
  })

  it('zooms between fit, 1:1 and steps, never below fit', () => {
    const natural = { width: 1206, height: 2622 }
    // A Retina screen: 1:1 is 603 × 1311 CSS pixels; a 400 × 655 box fits it at a half.
    const fit = fitScale(natural, { width: 400, height: 655.5 }, 2)
    expect(fit).toBeCloseTo(0.5, 3)
    expect(screenSize('fit', natural, { width: 400, height: 655.5 }, 2)).toEqual({ width: 302, height: 656 })
    expect(screenSize(1, natural, { width: 400, height: 655 }, 2)).toEqual({ width: 603, height: 1311 })
    expect(fitScale(natural, { width: 4000, height: 4000 }, 2)).toBe(1)
    expect(zoomIn('fit', fit)).toBe(0.67)
    expect(zoomIn(1, fit)).toBe(1.25)
    expect(zoomIn(2, fit)).toBe(2)
    expect(zoomOut(1, fit)).toBe(0.75)
    expect(zoomOut(0.67, fit)).toBe('fit')
    expect(zoomOut('fit', fit)).toBe('fit')
    expect(zoomLabel('fit', fit)).toBe('适应 · 50%')
    expect(zoomLabel(1.25, fit)).toBe('125%')
    expect([parseZoom('1.5'), parseZoom('7'), parseZoom(null), parseZoom('fit')]).toEqual([1.5, 'fit', 'fit', 'fit'])
  })

  it('annotates in the picture’s own pixels, keeps only real marks, and draws them in one colour', () => {
    const natural = { width: 1206, height: 2622 }
    const rect = { left: 10, top: 20, width: 201, height: 437 }
    expect(toImagePoint({ x: 10, y: 20 }, rect, natural)).toEqual([0, 0])
    expect(toImagePoint({ x: 110.5, y: 238.5 }, rect, natural)).toEqual([603, 1311])
    // Outside the picture: kept at its edge.
    expect(toImagePoint({ x: 500, y: -5 }, rect, natural)).toEqual([1206, 0])
    let pen: Shape = begin('pen', [0, 0])
    pen = extend(pen, [1, 1])
    expect(kept(pen)).toBe(false)
    pen = extend(pen, [10, 10])
    expect(kept(pen)).toBe(true)
    expect(kept(begin('box', [5, 5]))).toBe(false)
    const arrow = extend(begin('arrow', [0, 0]), [100, 0])
    expect(kept(arrow)).toBe(true)
    const [left, right] = arrowHead([0, 0], [100, 0], 10)
    expect(left[0]).toBeLessThan(100)
    expect(left[1]).toBeCloseTo(-right[1], 6)
    expect(lineWidth(natural)).toBe(10)
    const calls: string[] = []
    const fake: Pen = {
      beginPath: () => calls.push('begin'),
      moveTo: (x, y) => calls.push(`move ${Math.round(x)},${Math.round(y)}`),
      lineTo: (x, y) => calls.push(`line ${Math.round(x)},${Math.round(y)}`),
      strokeRect: (x, y, w, h) => calls.push(`rect ${x},${y},${w},${h}`),
      stroke: () => calls.push('stroke'),
      lineWidth: 0,
      strokeStyle: '',
      lineCap: '',
      lineJoin: '',
    }
    draw(fake, [extend(begin('box', [50, 60]), [10, 20]), pen], '#2563eb', 6)
    expect(fake.strokeStyle).toBe('#2563eb')
    expect(fake.lineWidth).toBe(6)
    expect(calls).toEqual(['rect 10,20,40,40', 'begin', 'move 0,0', 'line 10,10', 'stroke'])
    expect(annotatedName('iPhone-20261117-101500.png', 'image/jpeg')).toBe('iPhone-20261117-101500-标注.jpg')
  })

  it('takes ⌘S, ⇧⌘R, ⌘← and ⌘→ only outside text fields, leaving ⌘R to the menu’s 重新载入', () => {
    const key = (key: string, extra: Partial<Parameters<typeof panelShortcut>[0]> = {}) =>
      panelShortcut({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, editable: false, ...extra })
    expect([key('s'), key('R', { shiftKey: true }), key('ArrowLeft'), key('ArrowRight')]).toEqual([
      'shot',
      'record',
      'rotate-left',
      'rotate-right',
    ])
    expect(key('r')).toBeUndefined()
    expect(key('s', { shiftKey: true })).toBeUndefined()
    expect(key('s', { editable: true })).toBeUndefined()
    expect(key('R', { shiftKey: true, altKey: true })).toBeUndefined()
    expect(key('s', { metaKey: false, ctrlKey: true })).toBeUndefined()
  })
})
