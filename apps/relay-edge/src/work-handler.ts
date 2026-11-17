import type { EdgeRequest, EdgeResponse, EdgeSubtle } from './platform.ts'
import { checkWork } from './scrypt.ts'

/**
 * The registration-work verifier: a separate stateless Worker with no route of its own, reached only by the node's
 * service binding. One scrypt per request, so the node object's thread never computes one. Answers one byte, 1 or 0.
 */
export function createWorkHandler(subtle: EdgeSubtle, respond: (status: number, body: Uint8Array | null) => EdgeResponse) {
  return {
    async fetch(request: EdgeRequest): Promise<EdgeResponse> {
      if (request.method !== 'POST' || !/^https:\/\/work\/verify$/u.test(request.url)) return respond(404, null)
      const length = Number(request.headers.get('content-length') ?? '0')
      if (!Number.isInteger(length) || length > 1 + 32 + 512) return respond(400, null)
      const body = new Uint8Array(await request.arrayBuffer())
      return respond(200, Uint8Array.of((await checkWork(subtle, body)) ? 1 : 0))
    },
  }
}
