import type { EdgeResponse, EdgeSubtle } from './platform.ts'
import { createWorkHandler } from './work-handler.ts'

/** The work Worker's deploy entry (`main` in deploy/work.wrangler.jsonc): only the runtime's globals are read here. */
interface RuntimeGlobals {
  crypto: { subtle: EdgeSubtle }
  Response: new (body: Uint8Array | null, init: { status: number; headers?: Record<string, string> }) => EdgeResponse
}
const runtime = globalThis as unknown as RuntimeGlobals
export default createWorkHandler(runtime.crypto.subtle, (status, body) => new runtime.Response(body, { status }))
