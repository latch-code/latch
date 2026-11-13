import { open, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { expect } from 'vitest'

/** Only the caller's new temporary tree; never follows symlinks into CLI or user storage. */
export async function assertNoGatewayCredentials(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await assertNoGatewayCredentials(path)
    else if (entry.isFile()) {
      const file = await open(path, 'r')
      try {
        const chunk = Buffer.alloc(64 * 1024)
        let tail = ''
        for (;;) {
          const { bytesRead } = await file.read(chunk)
          if (!bytesRead) break
          const text = tail + chunk.subarray(0, bytesRead).toString('latin1')
          expect(/lmg1\.[A-Za-z0-9_-]{43}/u.test(text), `a process credential was persisted in ${basename(path)}`).toBe(false)
          tail = text.slice(-64)
        }
      } finally {
        await file.close()
      }
    }
  }
}
