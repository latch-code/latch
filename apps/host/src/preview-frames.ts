import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'

const manifest = z
  .object({ file: z.enum(['office.html', 'diagram.html']), scriptHash: z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/u) })
  .strict()
export const WORKER_CSP = "default-src 'none'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'"

/** A renderer gets one fixed application bootstrap, never arbitrary HTML from the workspace. */
export async function readPreviewFrame(uiDir: string, name: string): Promise<{ data: Buffer; hash: string; csp: string }> {
  if (name !== 'office' && name !== 'diagram') throw new AppError(404, 'preview-unavailable', '没有这个文档预览器')
  try {
    const directory = join(uiDir, 'preview-frame')
    const metaFile = join(directory, `${name}.json`)
    const file = join(directory, `${name}.html`)
    if ((await stat(metaFile)).size > 1024 || (await stat(file)).size > 32 * 1024 * 1024) throw new Error('oversized')
    const meta = manifest.parse(JSON.parse(await readFile(metaFile, 'utf8')))
    if (meta.file !== `${name}.html`) throw new Error('mismatch')
    const data = await readFile(file)
    const source = data.toString('utf8')
    const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
    if (scripts.length !== 1 || `sha256-${createHash('sha256').update(scripts[0]![1]!).digest('base64')}` !== meta.scriptHash)
      throw new Error('mismatch')
    const csp = `sandbox allow-scripts; default-src 'none'; script-src '${meta.scriptHash}'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; worker-src 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`
    return { data, hash: meta.scriptHash, csp }
  } catch {
    throw new AppError(404, 'preview-unavailable', '文档预览器不可用，请重新构建 Latch')
  }
}
