import { describe, expect, it } from 'vitest'
import { chooseDevice, deviceLabel, parseSimulators, shotName, sortDevices } from '../src/panel/device/model.ts'
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
      devices: [
        { udid: A, name: 'latch-test', os: 'iOS 27.2', state: 'shutdown', ours: false },
        { udid: B, name: 'iPhone 18 Pro', os: 'iOS 27.2', state: 'booted', ours: true, shown: true, agent: true },
      ],
    })
    expect(parseSimulators(null)).toEqual({ xcode: false, devices: [] })
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
})
