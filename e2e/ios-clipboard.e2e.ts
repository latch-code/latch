import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { validateGuiPairing } from './helpers/iosClipboardValidation.ts'
import {
  clipboardLease,
  ClipboardProof,
  compileClipboardLease,
  PAIR_CLIPBOARD_MS,
  publicClipboardMarker,
} from './helpers/iosClipboardLease.ts'

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

  it.each([true, false])('runs the real guard protocol with a named clipboard and working synchronization=%s', async working => {
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
          } else if (text.startsWith('Clipboard controls passed.')) used = true
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
    if (working) {
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
