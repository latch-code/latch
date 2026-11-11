import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'

const manifest = z.strictObject({ file: z.literal('runtime.html'), scriptHash: z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/u) })

/**
 * The plugin page frame's policy: an opaque origin (no `allow-same-origin`), the runtime's one inline script by hash and
 * page code only from the Blob the runtime made after checking its hash; no network, workers, subframes, forms or
 * navigation targets. `ancestors`: who may frame it (`'self'` on the Host, `latch://app` in the desktop app).
 */
export function appFrameCsp(scriptHash: string, ancestors = "'self'"): string {
  return `sandbox allow-scripts; default-src 'none'; script-src '${scriptHash}' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${ancestors}`
}

/** The fixed page runtime (`app-frame/runtime.html` in the built UI) with its script hash, checked against the file. */
export async function readAppFrame(uiDir: string): Promise<{ data: Buffer; hash: string; csp: string }> {
  try {
    const directory = join(uiDir, 'app-frame')
    const metaFile = join(directory, 'runtime.json')
    const file = join(directory, 'runtime.html')
    if ((await stat(metaFile)).size > 1024 || (await stat(file)).size > 16 * 1024 * 1024) throw new Error('oversized')
    const meta = manifest.parse(JSON.parse(await readFile(metaFile, 'utf8')))
    const data = await readFile(file)
    const scripts = [...data.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/gu)]
    if (scripts.length !== 1 || `sha256-${createHash('sha256').update(scripts[0]![1]!).digest('base64')}` !== meta.scriptHash)
      throw new Error('mismatch')
    return { data, hash: meta.scriptHash, csp: appFrameCsp(meta.scriptHash) }
  } catch {
    throw new AppError(404, 'app-frame-unavailable', '插件页面运行环境不可用，请重新构建 Latch')
  }
}
