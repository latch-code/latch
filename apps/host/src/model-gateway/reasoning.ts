import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const MAX_TEXT = 1024 * 1024
const MAX_SEAL = 8 * MAX_TEXT + 1024
const sealedSchema = z.object({ text: z.string().max(MAX_TEXT) }).strict()
export interface ReasoningScope {
  providerId: string
  model: string
}

/** A Host-lifetime authenticity envelope, not encryption. No credentials or signing key are persisted in it. */
export class ReasoningSeals {
  private readonly key = randomBytes(32)

  seal(scope: ReasoningScope, text: string): string {
    const checked = sealedSchema.parse({ text })
    const payload = Buffer.from(JSON.stringify(checked)).toString('base64url')
    const signature = this.sign(scope, payload).toString('base64url')
    return `latch1.${payload}.${signature}`
  }

  open(scope: ReasoningScope, value: string): string | undefined {
    if (value.length > MAX_SEAL) return undefined
    const match = /^latch1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(value)
    if (!match) return undefined
    const actual = Buffer.from(match[2]!, 'base64url')
    const expected = this.sign(scope, match[1]!)
    if (actual.length !== expected.length || actual.toString('base64url') !== match[2] || !timingSafeEqual(actual, expected))
      return undefined
    try {
      const parsed = sealedSchema.safeParse(JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')))
      if (parsed.success) return parsed.data.text
    } catch {
      /* Invalid or foreign envelopes are omitted, never treated as readable reasoning. */
    }
    return undefined
  }

  private sign(scope: ReasoningScope, payload: string): Buffer {
    // Bind identifiers in the MAC, rather than exposing arbitrary service/model strings inside a base64 payload.
    return createHmac('sha256', this.key)
      .update(JSON.stringify([scope.providerId, scope.model, payload]))
      .digest()
  }
}
