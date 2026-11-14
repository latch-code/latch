import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as pause } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { clipboardGui, validateGuiPairing } from './helpers/iosClipboardValidation.ts'
import { readDeviceClipboard, writeDeviceClipboard } from './helpers/iosDeviceClipboard.ts'
import {
  clipboardLease,
  ClipboardProof,
  compileClipboardLease,
  PAIR_CLIPBOARD_MS,
  publicClipboardMarker,
} from './helpers/iosClipboardLease.ts'

const clipboardDevice = process.env.LATCH_IOS_CLIPBOARD_TEST_DEVICE
it.skipIf(process.platform !== 'darwin' || !clipboardDevice)(
  'round trips a public marker and clears only the explicitly owned simulator with both GUIs closed',
  async () => {
    if (!clipboardDevice || (await clipboardGui()).kind !== 'closed') throw new Error('Owned simulator clipboard test needs closed GUIs')
    const result = await promisify(execFile)('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'], { timeout: 10_000 })
    const devices = JSON.parse(result.stdout) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> }
    const device = Object.values(devices.devices)
      .flat()
      .find(item => item.udid === clipboardDevice)
    if (!device?.name.startsWith('latch-live-root-') || device.state !== 'Booted')
      throw new Error('The selected device is not an owned test simulator')
    const marker = publicClipboardMarker()
    try {
      await writeDeviceClipboard(clipboardDevice, marker)
      // A failed read never prints arbitrary previous pasteboard content in an assertion diff.
      expect((await readDeviceClipboard(clipboardDevice)) === marker).toBe(true)
    } finally {
      await writeDeviceClipboard(clipboardDevice, '')
    }
    expect((await readDeviceClipboard(clipboardDevice)) === '').toBe(true)
  },
)

describe.skipIf(process.platform !== 'darwin')('clipboard restoration on an isolated named pasteboard', () => {
  let directory = '',
    binary = ''
  const boards = new Map<string, { driver: ReturnType<typeof clipboardLease>; probe?: string }>()
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-clipboard-'))
    binary = await compileClipboardLease(directory)
  })
  afterAll(async () => {
    for (const [id, { driver, probe }] of boards) {
      if (probe) await writeFile(probe, 'closed')
      await driver.close().catch(() => {})
      const reader = clipboardLease(binary, id)
      try {
        await reader.request({ op: 'fixture-destroy' })
      } finally {
        await reader.close()
      }
    }
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  async function fixture(probe?: string) {
    const id = randomUUID(),
      lease = clipboardLease(binary, id, probe)
    boards.set(id, { driver: lease, ...(probe ? { probe } : {}) })
    await lease.request({ op: 'fixture-seed' })
    return {
      id,
      lease,
      async inspect() {
        const reader = clipboardLease(binary, id)
        try {
          const state = await reader.request({ op: 'fixture-inspect' })
          await reader.request({ op: 'fixture-destroy' })
          boards.delete(id)
          return state
        } finally {
          await reader.close()
        }
      },
    }
  }

  it('never accepts an injected GUI probe for the general clipboard', () => {
    expect(() => clipboardLease(binary, undefined, join(directory, 'probe'))).toThrow('general clipboard cannot use')
  })

  it.each(['eof', 'signal', 'malformed', 'expiry'] as const)('restores every saved item and format after %s', async mode => {
    const f = await fixture()
    await f.lease.request({ op: 'capture', milliseconds: mode === 'expiry' ? 100 : 5000 })
    await f.lease.request({ op: 'write', marker: publicClipboardMarker() })
    const receipt =
      mode === 'signal'
        ? await f.lease.interrupt()
        : mode === 'malformed'
          ? await f.lease.malformed()
          : mode === 'expiry'
            ? await f.lease.ended()
            : await f.lease.close()
    expect(receipt?.restored).toBe(true)
    expect((await f.inspect()).originalMatches).toBe(true)
  })

  it('aborts on an external copy and never restores over its new content', async () => {
    const f = await fixture()
    await f.lease.request({ op: 'capture', milliseconds: 5000 })
    await f.lease.request({ op: 'write', marker: publicClipboardMarker() })
    await f.lease.request({ op: 'fixture-external' })
    const receipt = await f.lease.ended()
    expect(receipt).toMatchObject({ ok: false, reason: 'external-change', restored: false })
    expect((await f.inspect()).externalMatches).toBe(true)
  })

  it('refuses a promised resource before changing its clipboard ownership', async () => {
    const f = await fixture()
    await f.lease.request({ op: 'fixture-promise' })
    await expect(f.lease.request({ op: 'capture', milliseconds: 5000 })).rejects.toThrow('capture-refused')
    await f.lease.close()
    expect((await f.inspect()).promiseIntact).toBe(true)
  })

  it('restores an originally empty clipboard', async () => {
    const f = await fixture()
    await f.lease.request({ op: 'fixture-empty' })
    await f.lease.request({ op: 'capture', milliseconds: 5000 })
    await f.lease.request({ op: 'write', marker: publicClipboardMarker() })
    expect((await f.lease.close()).restored).toBe(true)
    expect((await f.inspect()).empty).toBe(true)
  })

  it('accepts only the announced public remote transfer before restoring the saved formats', async () => {
    const f = await fixture(),
      marker = publicClipboardMarker()
    await f.lease.request({ op: 'capture', milliseconds: 5000 })
    await f.lease.request({ op: 'write', marker: publicClipboardMarker() })
    await f.lease.request({ op: 'expect-remote', marker })
    await f.lease.request({ op: 'fixture-remote', marker })
    expect(await f.lease.request({ op: 'check' })).toMatchObject({ ok: true, remoteSeen: true })
    expect((await f.lease.close()).restored).toBe(true)
    expect((await f.inspect()).originalMatches).toBe(true)
  })

  it('rejects a registered test marker during OFF without mistaking it for a new user copy', async () => {
    const f = await fixture(),
      marker = publicClipboardMarker()
    await f.lease.request({ op: 'capture', milliseconds: 5000 })
    await f.lease.request({ op: 'write', marker: publicClipboardMarker() })
    await f.lease.request({ op: 'track', marker })
    await f.lease.request({ op: 'fixture-remote', marker })
    expect(await f.lease.ended()).toMatchObject({ ok: false, reason: 'unexpected-test-transfer', restored: true })
    expect((await f.inspect()).originalMatches).toBe(true)
  })

  it.each(['eof', 'signal', 'malformed', 'expiry', 'off-failure', 'disconnect'] as const)(
    'does not restore original formats while a GUI is open after %s',
    async mode => {
      const probe = join(directory, randomUUID() + '.gui')
      await writeFile(probe, 'open')
      const f = await fixture(probe)
      await f.lease.request({ op: 'capture', milliseconds: mode === 'expiry' ? 150 : 5000 })
      await f.lease.request({ op: 'write', marker: publicClipboardMarker() })
      if (mode === 'off-failure') {
        const marker = publicClipboardMarker()
        await f.lease.request({ op: 'track', marker })
        await f.lease.request({ op: 'fixture-remote', marker })
      }
      let finished = false
      const stopping = (
        mode === 'signal'
          ? f.lease.interrupt()
          : mode === 'malformed'
            ? f.lease.malformed()
            : mode === 'disconnect'
              ? f.lease.disconnect()
              : mode === 'expiry' || mode === 'off-failure'
                ? f.lease.ended()
                : f.lease.close()
      ).finally(() => {
        finished = true
      })
      try {
        if (mode === 'disconnect') await pause(250)
        else await expect.poll(() => finished || f.lease.waitingForGui, { timeout: 3000 }).toBe(true)
        expect(finished).toBe(false)
        const observer = clipboardLease(binary, f.id)
        try {
          expect((await observer.request({ op: 'fixture-inspect' })).originalMatches).toBe(false)
          expect((await observer.request({ op: 'fixture-marker-present' })).remoteSeen).toBe(true)
        } finally {
          await observer.close()
        }
      } finally {
        await writeFile(probe, 'closed')
        await stopping
      }
      expect((await f.inspect()).originalMatches).toBe(true)
    },
  )

  it('keeps ownership after clear succeeds but writing the marker fails', async () => {
    const probe = join(directory, randomUUID() + '.gui')
    await writeFile(probe, 'open')
    const f = await fixture(probe)
    await f.lease.request({ op: 'capture', milliseconds: 5000 })
    await f.lease.request({ op: 'fixture-fail-write' })
    await expect(f.lease.request({ op: 'write', marker: publicClipboardMarker() })).rejects.toThrow('write-failed')
    let finished = false
    const ending = f.lease.ended().finally(() => {
      finished = true
    })
    try {
      await expect.poll(() => finished || f.lease.waitingForGui).toBe(true)
      expect(finished).toBe(false)
      const observer = clipboardLease(binary, f.id)
      try {
        expect((await observer.request({ op: 'fixture-inspect' })).empty).toBe(true)
      } finally {
        await observer.close()
      }
    } finally {
      await writeFile(probe, 'closed')
    }
    expect(await ending).toMatchObject({ ok: false, reason: 'write-failed', restored: true })
    expect((await f.inspect()).originalMatches).toBe(true)
  })

  it.each([
    ['success', true, false],
    ['unavailable synchronization', false, false],
    ['interruption after OFF', true, true],
  ] as const)('runs the real guard protocol with a named clipboard: %s', async (_name, working, interrupted) => {
    const f = await fixture(),
      hold = join(directory, randomUUID()),
      device = randomUUID()
    let sharing = false,
      closed = false,
      deviceText = '',
      used = false,
      issued = 0,
      revoked = 0
    const driver = {
      ...f.lease,
      request: async (command: Parameters<typeof f.lease.request>[0]) => {
        const reply = await f.lease.request(command)
        if (working && sharing && command.op === 'write') deviceText = command.marker!
        return reply
      },
    }
    const result = validateGuiPairing(
      {
        device,
        hold,
        clipboard: () => driver,
        guiPid: async () => (closed ? undefined : 123),
        guiClosed: async () => closed,
        readDevice: async () => deviceText,
        writeDevice: async value => {
          deviceText = value
          if (working && sharing) await f.lease.request({ op: 'fixture-remote', marker: value })
        },
        stage: async text => {
          if (text.includes('Clipboard ON,')) {
            sharing = true
            await writeFile(`${hold}.clipboard-on`, '')
          } else if (text.includes('Clipboard OFF,')) {
            sharing = false
            await writeFile(`${hold}.clipboard-off`, '')
          } else if (text.startsWith('Validation stopped.') || text.startsWith('Pairing code consumed.')) {
            closed = true
            sharing = false
          } else if (text.startsWith('Clipboard controls passed.')) {
            if (interrupted) throw new Error('Public fixture interrupted after OFF')
            used = true
          }
        },
      },
      async () => {
        issued++
        return 'not-a-pairing-code'
      },
      () => used,
      async () => {
        revoked++
      },
    )
    if (interrupted) {
      await expect(result).rejects.toThrow('Public fixture interrupted after OFF')
      expect(issued).toBe(1)
      expect(revoked).toBe(1)
      expect(closed).toBe(true)
      expect(deviceText).toBe('')
    } else if (working) {
      await result
      expect(issued).toBe(1)
      expect(revoked).toBe(0)
      expect(deviceText).toBe('')
    } else {
      await expect(result).rejects.toThrow('no longer valid')
      expect(issued).toBe(0)
      expect(revoked).toBe(1)
    }
    expect((await f.inspect()).originalMatches).toBe(true)
  })

  it.each(['owned', 'external', 'external before close', 'copy during GUI check', 'target changed'] as const)(
    'cleans only owned simulator text after a late GUI exit: %s',
    async mode => {
      const probe = join(directory, randomUUID() + '.gui')
      await writeFile(probe, 'open')
      const f = await fixture(probe),
        hold = join(directory, randomUUID()),
        device = randomUUID()
      let closed = false,
        deviceText = '',
        finishing = false,
        clock = 0,
        writesWhileOpen = 0,
        target = device,
        closedChecks = 0
      const now = vi.spyOn(performance, 'now').mockImplementation(() => (finishing ? (clock += 60_000) : 0))
      try {
        await expect(
          validateGuiPairing(
            {
              get device() {
                return target
              },
              hold,
              clipboard: () => ({
                ...f.lease,
                close: async () => {
                  closed = true
                  if (mode === 'external') deviceText = 'new external simulator copy'
                  if (mode === 'target changed') target = randomUUID()
                  await writeFile(probe, 'closed')
                  return f.lease.close()
                },
              }),
              guiPid: async () => (closed ? undefined : 123),
              guiClosed: async () => {
                if (closed && mode === 'copy during GUI check' && ++closedChecks === 2) deviceText = 'new external simulator copy'
                return closed
              },
              readDevice: async () => deviceText,
              writeDevice: async text => {
                if (text === '' && !closed) writesWhileOpen++
                deviceText = text
              },
              stage: async text => {
                if (text.includes('Clipboard ON,')) throw new Error('Public fixture stopped before ON')
                if (text.startsWith('Validation stopped.')) {
                  if (mode === 'external before close') {
                    closed = true
                    deviceText = 'new external simulator copy'
                    await writeFile(probe, 'closed')
                  } else finishing = true
                }
              },
            },
            async () => {
              throw new Error('No invitation expected')
            },
            () => false,
            async () => {},
          ),
        ).rejects.toThrow('Public fixture stopped before ON')
        expect(writesWhileOpen).toBe(0)
        if (mode === 'target changed') expect(deviceText.startsWith('latch-public-clipboard-')).toBe(true)
        else expect(deviceText).toBe(mode.startsWith('external') || mode === 'copy during GUI check' ? 'new external simulator copy' : '')
        expect((await f.inspect()).originalMatches).toBe(true)
      } finally {
        now.mockRestore()
        await writeFile(probe, 'closed')
      }
    },
  )
})

describe('one-use GUI pairing proof', () => {
  const device = randomUUID()
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ] as const)('rejects incomplete ON evidence %s/%s', (host, sim) => {
    expect(() => new ClipboardProof(123, device).on(host, sim)).toThrow('no longer valid')
  })
  it('rejects OFF evidence without a successful ON control', () => {
    expect(() => new ClipboardProof(123, device).off(false, false, 1000)).toThrow('no longer valid')
  })
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ] as const)('rejects synchronizing OFF evidence %s/%s', (host, sim) => {
    const proof = new ClipboardProof(123, device)
    proof.on(true, true)
    expect(() => proof.off(host, sim, 1000)).toThrow('no longer valid')
  })
  it('expires after ten seconds and cannot be reused after consumption', () => {
    const proof = new ClipboardProof(123, device)
    proof.on(true, true)
    proof.off(false, false, 1000)
    proof.take(123, device, 1001)
    proof.check(123, device, 1002, true)
    proof.consumed()
    expect(() => proof.take(123, device, 1003)).toThrow('no longer valid')
    const expired = new ClipboardProof(123, device)
    expired.on(true, true)
    expired.off(false, false, 1000)
    expect(() => expired.take(123, device, 1000 + PAIR_CLIPBOARD_MS)).toThrow('no longer valid')
  })
  it.each(['pid', 'device', 'clipboard'] as const)('invalidates the held proof after a %s change', field => {
    const proof = new ClipboardProof(123, device)
    proof.on(true, true)
    proof.off(false, false, 1000)
    proof.take(123, device, 1001)
    expect(() => proof.check(field === 'pid' ? 456 : 123, field === 'device' ? randomUUID() : device, 1002, field !== 'clipboard')).toThrow(
      'no longer valid',
    )
  })
})
