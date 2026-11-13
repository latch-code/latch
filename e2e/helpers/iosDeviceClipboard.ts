import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TYPE = 'public.utf8-plain-text'

function args(operation: 'copy' | 'paste', device: string, timeoutMs: number): string[] {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(device) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000)
    throw new Error('Invalid simulator clipboard request')
  return [
    'devicectl',
    'device',
    'pasteboard',
    operation,
    '--device',
    device,
    '--type',
    TYPE,
    '--quiet',
    '--timeout',
    String(timeoutMs / 1000),
  ]
}

/** Payloads travel only over stdin; command output and errors cannot expose a code or clipboard contents. */
export function writeDeviceClipboard(device: string, payload: string, timeoutMs = 5000): Promise<void> {
  const command = args('copy', device, timeoutMs)
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/xcrun', command, { stdio: ['pipe', 'ignore', 'ignore'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdin.on('error', () => reject(new Error('Simulator clipboard input closed')))
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('Could not start simulator clipboard writer'))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('Simulator clipboard write did not complete'))
    })
    child.stdin.end(payload)
  })
}

export async function readDeviceClipboard(device: string, timeoutMs = 5000): Promise<string> {
  try {
    return (await run('/usr/bin/xcrun', args('paste', device, timeoutMs), { timeout: timeoutMs, maxBuffer: 32_768 })).stdout
  } catch {
    throw new Error('Could not verify simulator clipboard')
  }
}
