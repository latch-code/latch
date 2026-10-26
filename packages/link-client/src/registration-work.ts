import { Worker } from 'node:worker_threads'
import { REGISTRATION_WORK, registrationWorkInput } from '@latch/link-wire'

const LIMIT = 2
let active = 0
// This is a constant ES module, independent of source/bundle paths. Request fields are cloned through workerData, never interpolated here.
const PROGRAM = `
import { parentPort, workerData } from 'node:worker_threads';
import { scryptSync } from 'node:crypto';
const input = Buffer.from(workerData.input), salt = Buffer.from(workerData.salt), bits = workerData.bits;
if (input.length !== 261 || salt.length !== 32 || !Number.isInteger(bits) || bits < 0 || bits > 22) throw new Error('Invalid work');
const whole = Math.floor(bits / 8), remaining = bits % 8;
for (let solution = 0n; solution <= 0xffffffffffffffffn; solution++) {
  input.writeBigUInt64BE(solution, input.length - 8);
  const hash = scryptSync(input, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 33554432 });
  let matches = true;
  for (let index = 0; index < whole; index++) if (hash[index] !== 0) matches = false;
  if (matches && (remaining === 0 || hash[whole] >>> (8 - remaining) === 0)) {
    parentPort.postMessage(new Uint8Array(input.subarray(input.length - 8)));
    parentPort.close();
    break;
  }
}
`
const MODULE = new URL(`data:text/javascript;base64,${Buffer.from(PROGRAM).toString('base64')}`)
export async function solveRegistrationWork(input: {
  relayId: Uint8Array
  helloNonce: Uint8Array
  workNonce: Uint8Array
  register: Uint8Array
  bits: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  const transcript = registrationWorkInput(input.relayId, input.helloNonce, input.workNonce, input.register, new Uint8Array(8))
  if (!Number.isInteger(input.bits) || input.bits < 0 || input.bits > REGISTRATION_WORK.maxBits || input.signal.aborted)
    throw new Error('Relay registration work unavailable')
  if (active >= LIMIT) throw new Error('Relay registration work busy')
  active++
  let worker: Worker
  try {
    worker = new Worker(MODULE, {
      name: 'latch-registration-work',
      workerData: { input: transcript, salt: new Uint8Array(input.workNonce), bits: input.bits },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
    })
  } catch {
    active--
    throw new Error('Relay registration work unavailable')
  }
  worker.stdout?.resume()
  worker.stderr?.resume()
  return new Promise((resolve, reject) => {
    let answer: Uint8Array | undefined,
      failed = false
    const stop = () => {
      failed = true
      void worker.terminate().catch(() => {})
    }
    const timer = setTimeout(stop, 2000)
    timer.unref()
    input.signal.addEventListener('abort', stop, { once: true })
    worker.once('message', (value: unknown) => {
      if (!(value instanceof Uint8Array) || value.byteLength !== 8 || answer) {
        stop()
        return
      }
      answer = new Uint8Array(value)
    })
    worker.once('error', () => {
      failed = true
    })
    worker.once('exit', code => {
      active--
      clearTimeout(timer)
      input.signal.removeEventListener('abort', stop)
      if (failed || input.signal.aborted || code !== 0 || !answer) reject(new Error('Relay registration work unavailable'))
      else resolve(answer)
    })
    if (input.signal.aborted) stop()
  })
}
