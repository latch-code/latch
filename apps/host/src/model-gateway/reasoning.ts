import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { ModelWire } from '@latch/protocol'
import { invalidReply, type GatewayReasoning } from './ir.ts'

const MAX_TEXT = 1024 * 1024
const MAX_JSON = 8 * MAX_TEXT
const MAX_SEAL = 16 * MAX_TEXT
const sealedSchema = z.discriminatedUnion('wire', [
  z.object({ wire: z.literal('chat-completions'), text: z.string().max(MAX_TEXT) }).strict(),
  z
    .object({
      wire: z.literal('anthropic-messages'),
      block: z.discriminatedUnion('type', [
        z
          .object({
            type: z.literal('thinking'),
            thinking: z.string().max(MAX_TEXT),
            signature: z
              .string()
              .min(1)
              .max(4 * MAX_TEXT),
          })
          .strict(),
        z
          .object({
            type: z.literal('redacted_thinking'),
            data: z
              .string()
              .min(1)
              .max(4 * MAX_TEXT),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      wire: z.literal('responses'),
      item: z
        .object({
          type: z.literal('reasoning'),
          id: z.string().min(1).max(1024),
          encrypted_content: z
            .string()
            .min(1)
            .max(4 * MAX_TEXT),
          summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string().max(MAX_TEXT) }).strict()).max(128),
          content: z
            .array(z.object({ type: z.literal('reasoning_text'), text: z.string().max(MAX_TEXT) }).strict())
            .max(128)
            .optional(),
          status: z.enum(['completed', 'incomplete']).optional(),
        })
        .strict(),
    })
    .strict(),
])
export interface ReasoningScope {
  providerId: string
  model: string
  wire: ModelWire
}

/** A Host-lifetime authenticity envelope, not encryption. No credentials or signing key are persisted in it. */
export class ReasoningSeals {
  private readonly key = randomBytes(32)

  seal(scope: ReasoningScope, state: GatewayReasoning, redact: (text: string) => string = text => text): string {
    const checked = sealedSchema.safeParse(state)
    if (!checked.success || checked.data.wire !== scope.wire) throw invalidReply('思考状态与上游协议不一致')
    let clean: GatewayReasoning
    if (checked.data.wire === 'chat-completions') clean = { ...checked.data, text: redact(checked.data.text) }
    else if (checked.data.wire === 'anthropic-messages') {
      // The native signature authenticates the entire thinking block, including its readable text.
      if (Object.values(checked.data.block).some(value => redact(value) !== value))
        throw invalidReply('模型思考状态包含敏感内容，不能安全回放')
      clean = checked.data
    } else {
      const { item } = checked.data
      // Rewriting an opaque state would invalidate it. Reject a secret-bearing state before wrapping it in base64.
      if (redact(item.id) !== item.id || redact(item.encrypted_content) !== item.encrypted_content)
        throw invalidReply('模型思考状态包含敏感内容，不能安全回放')
      clean = {
        ...checked.data,
        item: {
          ...item,
          summary: item.summary.map(part => ({ ...part, text: redact(part.text) })),
          ...(item.content ? { content: item.content.map(part => ({ ...part, text: redact(part.text) })) } : {}),
        },
      }
    }
    if (!sealedSchema.safeParse(clean).success) throw invalidReply('模型思考超出回放大小限制')
    const json = JSON.stringify(clean)
    if (json.length > MAX_JSON) throw invalidReply('模型思考超出回放大小限制')
    const payload = Buffer.from(json).toString('base64url')
    const signature = this.sign(scope, payload).toString('base64url')
    const value = `latch2.${payload}.${signature}`
    if (value.length > MAX_SEAL) throw invalidReply('模型思考超出回放大小限制')
    return value
  }

  open(scope: ReasoningScope, value: string): GatewayReasoning | undefined {
    if (value.length > MAX_SEAL) return undefined
    const match = /^latch2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(value)
    if (!match) return undefined
    const actual = Buffer.from(match[2]!, 'base64url')
    const expected = this.sign(scope, match[1]!)
    if (actual.length !== expected.length || actual.toString('base64url') !== match[2] || !timingSafeEqual(actual, expected))
      return undefined
    try {
      const parsed = sealedSchema.safeParse(JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')))
      if (parsed.success && parsed.data.wire === scope.wire) return parsed.data
    } catch {
      /* Invalid or foreign envelopes are omitted, never treated as readable reasoning. */
    }
    return undefined
  }

  private sign(scope: ReasoningScope, payload: string): Buffer {
    // Bind identifiers in the MAC, rather than exposing arbitrary service/model strings inside a base64 payload.
    return createHmac('sha256', this.key)
      .update(JSON.stringify([scope.providerId, scope.model, scope.wire, payload]))
      .digest()
  }
}
