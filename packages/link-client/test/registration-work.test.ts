import { readFile } from 'node:fs/promises'
import { scryptSync } from 'node:crypto'
import { expect, it } from 'vitest'
import { unhex, registrationWorkInput, REGISTRATION_WORK, workDigestMeetsBits } from '@latch/link-wire'
import { solveRegistrationWork } from '../src/registration-work.ts'
async function fixture() {
  const vectors = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    registrationWork: { relayId: string; helloNonce: string; workNonce: string; register: string; digest: string }
  }
  const v = vectors.registrationWork
  return {
    relayId: unhex(v.relayId),
    helloNonce: unhex(v.helloNonce),
    workNonce: unhex(v.workNonce),
    register: unhex(v.register),
    bits: 0,
    signal: new AbortController().signal,
  }
}
it('performs the fixed memory computation in a separate worker even for zero difficulty', async () => {
  const input = await fixture()
  const promise = solveRegistrationWork(input)
  let yielded = false
  await new Promise<void>(resolve =>
    setImmediate(() => {
      yielded = true
      resolve()
    }),
  )
  expect(yielded).toBe(true)
  const solution = await promise
  expect(solution).toEqual(new Uint8Array(8))
  const hash = scryptSync(
    registrationWorkInput(input.relayId, input.helloNonce, input.workNonce, input.register, solution),
    input.workNonce,
    32,
    { N: REGISTRATION_WORK.N, r: REGISTRATION_WORK.r, p: REGISTRATION_WORK.p, maxmem: REGISTRATION_WORK.maxMemory },
  )
  expect(workDigestMeetsBits(hash, input.bits)).toBe(true)
})
it('bounds solver concurrency, cancels actual workers before releasing slots, and then accepts fresh work', async () => {
  const input = await fixture(),
    first = new AbortController(),
    second = new AbortController()
  const a = solveRegistrationWork({ ...input, bits: 22, signal: first.signal }),
    b = solveRegistrationWork({ ...input, bits: 22, signal: second.signal })
  const rejectedA = expect(a).rejects.toThrow('unavailable'),
    rejectedB = expect(b).rejects.toThrow('unavailable')
  await expect(solveRegistrationWork(input)).rejects.toThrow('busy')
  first.abort()
  second.abort()
  await rejectedA
  await rejectedB
  expect(await solveRegistrationWork(input)).toHaveLength(8)
})
it('rejects excessive difficulty and pre-cancelled requests without starting work', async () => {
  const input = await fixture(),
    stopped = new AbortController()
  stopped.abort()
  await expect(solveRegistrationWork({ ...input, bits: 23 })).rejects.toThrow('unavailable')
  await expect(solveRegistrationWork({ ...input, signal: stopped.signal })).rejects.toThrow('unavailable')
})
it('searches beyond an invalid zero solution and returns a proof meeting the fixed leading-bit target', async () => {
  const input = await fixture(),
    solution = await solveRegistrationWork({ ...input, bits: 3 })
  expect(solution).not.toEqual(new Uint8Array(8))
  const digest = scryptSync(
    registrationWorkInput(input.relayId, input.helloNonce, input.workNonce, input.register, solution),
    input.workNonce,
    32,
    { N: REGISTRATION_WORK.N, r: REGISTRATION_WORK.r, p: REGISTRATION_WORK.p, maxmem: REGISTRATION_WORK.maxMemory },
  )
  expect(workDigestMeetsBits(digest, 3)).toBe(true)
})
