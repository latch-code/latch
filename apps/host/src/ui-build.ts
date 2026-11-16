import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const buildFile = z.object({ build: z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/u) })
/** The file is one short JSON object; anything larger is not one the page build wrote. */
const MAX_BYTES = 1024

/**
 * The build ID of the page in `uiDir` (`build.json`, written by the page's build), read once when the Host starts: it
 * stays what this Host started beside, so a page rebuilt later can tell that the Host is older. Undefined without one,
 * or when it is not a small regular file.
 */
export async function readUiBuild(uiDir: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(join(uiDir, 'build.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_BYTES) return undefined
    const parsed = buildFile.safeParse(JSON.parse(await handle.readFile('utf8')))
    return parsed.success ? parsed.data.build : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * The build of the code a Host starts from: SHA-256 over the start script's bytes and the page's build ID beside it.
 * The Host takes it once at start (host-info's `build`); the desktop launcher takes it again from the files on disk, and a
 * difference means a rebuild since that Host started. `pnpm build:host` changes the script, `pnpm build:web` the page.
 * Undefined when the script cannot be read.
 */
export async function readCodeBuild(script: string, uiDir: string): Promise<string | undefined> {
  let bytes: Buffer
  try {
    bytes = await readFile(script)
  } catch {
    return undefined
  }
  return createHash('sha256')
    .update(bytes)
    .update('\0')
    .update((await readUiBuild(uiDir)) ?? '')
    .digest('hex')
}
