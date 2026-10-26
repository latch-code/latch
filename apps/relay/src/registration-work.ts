import { scrypt } from 'node:crypto'
import { z } from 'zod'
import { REGISTRATION_WORK, workDigestMeetsBits } from '@latch/link-wire'

export const REGISTRATION_WORK_MEMORY = REGISTRATION_WORK.maxMemory
export const registrationWorkSchema = z
  .object({
    softRoutesPerPrefix: z.number().int().min(1).max(2048),
    minBits: z.number().int().min(0).max(REGISTRATION_WORK.maxBits),
    maxBits: z.number().int().min(0).max(REGISTRATION_WORK.maxBits),
    maxConcurrent: z.number().int().min(1).max(32),
  })
  .strict()
  .refine(value => value.minBits <= value.maxBits)
export type RegistrationWorkPolicy = z.infer<typeof registrationWorkSchema>
export interface RegistrationWorkInput {
  input: Uint8Array
  salt: Uint8Array
  bits: number
}
export type RegistrationWorkResult = boolean | 'overloaded' | 'timeout'
type Derive = (input: Uint8Array, salt: Uint8Array, callback: (error: Error | null, digest?: Uint8Array) => void) => void
const derive: Derive = (input, salt, callback) => {
  scrypt(
    input,
    salt,
    REGISTRATION_WORK.keyLength,
    { N: REGISTRATION_WORK.N, r: REGISTRATION_WORK.r, p: REGISTRATION_WORK.p, maxmem: REGISTRATION_WORK_MEMORY },
    callback,
  )
}

/** The libuv job keeps its slot until its callback, including after client timeout or disconnect. */
export class RegistrationWorkPool {
  private readonly jobs = new Set<Promise<void>>()
  private readonly derive: Derive
  private readonly limit: number
  private closed = false
  private accepted = 0
  private rejected = 0
  private overloaded = 0
  private timedOut = 0
  constructor(policy: RegistrationWorkPolicy, compute: Derive = derive) {
    this.limit = registrationWorkSchema.parse(policy).maxConcurrent
    this.derive = compute
  }
  verify(request: RegistrationWorkInput): Promise<RegistrationWorkResult> {
    if (
      this.closed
      || !(request.input instanceof Uint8Array)
      || request.input.length < 16
      || request.input.length > 512
      || !(request.salt instanceof Uint8Array)
      || request.salt.length !== 32
      || !Number.isInteger(request.bits)
      || request.bits < 0
      || request.bits > REGISTRATION_WORK.maxBits
    )
      return Promise.resolve(false)
    if (this.jobs.size >= this.limit) {
      this.overloaded++
      return Promise.resolve('overloaded')
    }
    const bits = request.bits
    let finishJob!: () => void
    const job = new Promise<void>(resolve => {
      finishJob = resolve
    })
    this.jobs.add(job)
    return new Promise<RegistrationWorkResult>(resolve => {
      let settled = false,
        finished = false
      const settle = (result: RegistrationWorkResult) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const timer = setTimeout(() => {
        this.timedOut++
        settle('timeout')
      }, 2000)
      timer.unref()
      const done = (error: Error | null, digest?: Uint8Array) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        this.jobs.delete(job)
        finishJob()
        if (!settled) {
          const valid = !this.closed && !error && digest?.length === 32 && workDigestMeetsBits(digest, bits)
          if (valid) this.accepted++
          else this.rejected++
          settle(valid)
        }
      }
      try {
        this.derive(request.input.slice(), request.salt.slice(), done)
      } catch {
        done(new Error('Registration work failed'))
      }
    })
  }
  status(): { active: number; accepted: number; rejected: number; overloaded: number; timedOut: number } {
    return {
      active: this.jobs.size,
      accepted: this.accepted,
      rejected: this.rejected,
      overloaded: this.overloaded,
      timedOut: this.timedOut,
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.jobs)
  }
}
