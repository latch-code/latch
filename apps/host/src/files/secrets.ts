// Files likely to hold a secret. Kept apart from the write-protection list (risk.ts): this one decides what Latch will
// not hand to another program or show, not what an agent may write. A match by name or by content counts.
import { containsSecret } from '@latch/core/node-kit'
import { isSecretPathName } from '@latch/protocol'
import { matchesFamily } from './sniff.ts'

/**
 * By path, relative to the folder the file is in. A `.key` file is a secret unless it is a Keynote document (a ZIP), so
 * `head` is the file's first bytes.
 */
export function isSecretPath(relativePath: string, head: Uint8Array): boolean {
  if (isSecretPathName(relativePath)) return true
  return relativePath.toLowerCase().endsWith('.key') && !matchesFamily('zip', head)
}

/** By content: a text file whose first bytes hold a credential itself (a private key, a service key, Latch's own). */
export function hasSecretContent(head: Uint8Array): boolean {
  if (!matchesFamily('text', head)) return false
  const encoding = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8'
  return containsSecret(new TextDecoder(encoding, { fatal: false }).decode(head))
}
