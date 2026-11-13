import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type clipboardLease, ClipboardProof, publicClipboardMarker } from './iosClipboardLease.ts'

const CONTROL_MS = 5000
const OFF_MS = 10_000
const MANUAL_MS = 45_000
const exec = promisify(execFile)
export async function clipboardGui(): Promise<{ kind: 'closed' } | { kind: 'open'; pid: number } | { kind: 'invalid' }> {
  let output: string
  try {
    output = (await exec('/usr/bin/pgrep', ['-lx', 'Simulator|DeviceHub'], { timeout: 1000, maxBuffer: 4096 })).stdout
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 1) return { kind: 'closed' }
    throw new Error('Could not verify Simulator GUI processes', { cause })
  }
  const lines = output.trim().split('\n')
  const match = lines.length === 1 ? /^(\d+) DeviceHub$/u.exec(lines[0]) : undefined
  return match ? { kind: 'open', pid: Number(match[1]) } : { kind: 'invalid' }
}
type ClipboardIo = {
  device: string
  clipboard(): ReturnType<typeof clipboardLease>
  hold: string
  /** Exactly one Device Hub, and no legacy Simulator; undefined otherwise. */
  guiPid(): Promise<number | undefined>
  guiClosed(): Promise<boolean>
  readDevice(): Promise<string>
  writeDevice(value: string): Promise<void>
  stage(text: string): Promise<void>
}

/** Explicit manual acceptance only: CUA operates the official menu and the product's real PasteButton. */
export async function validateGuiPairing(
  io: ClipboardIo,
  code: () => Promise<string>,
  consumed: () => boolean,
  invalidate: () => Promise<void>,
): Promise<void> {
  const pid = await io.guiPid()
  if (!pid) throw new Error('GUI clipboard validation needs exactly one Device Hub')
  const proof = new ClipboardProof(pid, io.device)
  const lease = io.clipboard()
  let restored = false
  let failure: unknown
  const stable = async () => {
    if ((await io.guiPid()) !== pid || existsSync(io.hold)) throw new Error('GUI clipboard validation interrupted')
    await lease.request({ op: 'check' })
  }
  const manual = async (kind: 'on' | 'off') => {
    const ack = `${io.hold}.clipboard-${kind}`
    await rm(ack, { force: true })
    await io.stage(
      `Public markers only. Select simulator ${io.device}; set Edit > Use Shared Clipboard ${kind.toUpperCase()}, then touch ${ack}`,
    )
    const deadline = performance.now() + MANUAL_MS
    while (!existsSync(ack)) {
      await stable()
      if (performance.now() >= deadline) throw new Error('Clipboard menu confirmation expired')
      await pause(100)
    }
    await rm(ack, { force: true })
    await stable()
  }
  try {
    await lease.request({ op: 'capture', milliseconds: 180_000 })
    // Capture the person's formats before putting anything on either end of an unknown sharing setting.
    const first = publicClipboardMarker()
    await lease.request({ op: 'write', marker: first })
    await lease.request({ op: 'expect-remote', marker: first })
    await io.writeDevice(first)
    await manual('on')

    const fromDevice = publicClipboardMarker()
    await lease.request({ op: 'expect-remote', marker: fromDevice })
    await io.writeDevice(fromDevice)
    let deviceToHost = false
    const deviceDeadline = performance.now() + CONTROL_MS
    while (performance.now() < deviceDeadline) {
      await stable()
      if ((await lease.request({ op: 'check' })).remoteSeen) {
        deviceToHost = true
        break
      }
      const value = await io.readDevice()
      if (value !== fromDevice) throw new Error('Simulator clipboard changed during validation')
      await pause(100)
    }
    const fromHost = publicClipboardMarker()
    await lease.request({ op: 'write', marker: fromHost })
    let hostToDevice = false
    const hostDeadline = performance.now() + CONTROL_MS
    while (performance.now() < hostDeadline) {
      await stable()
      const value = await io.readDevice()
      if (value === fromHost) {
        hostToDevice = true
        break
      }
      if (value !== fromDevice) throw new Error('Simulator clipboard changed during validation')
      await pause(100)
    }
    proof.on(hostToDevice, deviceToHost)
    await manual('off')

    const stopped = publicClipboardMarker()
    await lease.request({ op: 'track', marker: stopped })
    await io.writeDevice(stopped)
    // OFF observes both directions with the very same string type and options used by the ON positive control.
    const negative = async () => {
      const deadline = performance.now() + OFF_MS
      while (performance.now() < deadline) {
        await stable()
        if ((await io.readDevice()) !== stopped) throw new Error('Clipboard sharing did not stay off')
        await pause(100)
      }
    }
    await negative()
    await lease.request({ op: 'write', marker: publicClipboardMarker() })
    await negative()
    proof.off(false, false, performance.now())
    proof.take((await io.guiPid()) ?? -1, io.device, performance.now())
    await stable()
    // The invitation is created only after both controls. It is never a public marker or helper command.
    let payload: string
    try {
      payload = await code()
    } catch {
      throw new Error('Could not create the temporary invitation')
    }
    proof.check((await io.guiPid()) ?? -1, io.device, performance.now(), !lease.failure)
    await io.writeDevice(payload)
    await io.stage('Clipboard controls passed. Activate the product Paste button now; this one-use window lasts at most 10 seconds.')
    for (;;) {
      await stable()
      proof.check((await io.guiPid()) ?? -1, io.device, performance.now(), !lease.failure)
      if (consumed()) {
        proof.consumed()
        break
      }
      const value = await io.readDevice()
      if (value !== payload && value !== '') throw new Error('Simulator clipboard changed before pairing')
      await pause(100)
    }
    await io.writeDevice('')
    await io.stage(
      'Pairing code consumed. Use Device Hub > Quit and Keep Simulators Running to restore the original Mac clipboard; the App stays connected.',
    )
    const restoreDeadline = performance.now() + MANUAL_MS
    while (!(await io.guiClosed())) {
      if (performance.now() >= restoreDeadline) throw new Error('Simulator GUI did not close before restoring the clipboard')
      await pause(100)
    }
    restored = (await lease.request({ op: 'restore' })).restored === true
    if (!restored) throw new Error('Original clipboard could not be restored')
  } catch (cause) {
    failure = cause
    // Revoke the temporary invitation before waiting for manual GUI cleanup, not forty-five seconds later.
    try {
      await invalidate()
    } catch {
      failure = new Error('Could not close the temporary pairing Host')
    }
  }
  try {
    // Restoration always waits for the GUI, including a failure after OFF was proved. Announce that wait too.
    if (!(await io.guiClosed())) {
      await io.stage(
        'Validation stopped. Use Device Hub > Quit and Keep Simulators Running; clipboard cleanup waits for both GUIs to exit.',
      )
      const deadline = performance.now() + MANUAL_MS
      while (!(await io.guiClosed())) {
        if (performance.now() >= deadline) throw new Error('Simulator GUI did not close for clipboard cleanup')
        await pause(100)
      }
    }
    await io.writeDevice('')
  } catch (cause) {
    failure ??= cause
  }
  try {
    const receipt = await lease.close()
    if (!restored && receipt.restored !== true && receipt.reason !== 'external-change')
      throw new Error('Clipboard cleanup has no restoration receipt')
  } catch (cause) {
    failure ??= cause
  }
  await Promise.all(['on', 'off'].map(kind => rm(`${io.hold}.clipboard-${kind}`, { force: true })))
  if (failure !== undefined) throw failure
  await io.stage(
    'Pairing code consumed and simulator clipboard cleared. Original Mac clipboard formats restored locally; Device Hub may be reopened.',
  )
}
