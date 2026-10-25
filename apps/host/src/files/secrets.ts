// Files likely to hold a secret. Kept apart from the write-protection list (risk.ts): this one decides what Latch will
// not hand to another program or show, not what an agent may write. A match by name or by content counts.
import { containsSecret } from '@latch/core/node-kit'
import { matchesFamily } from './sniff.ts'

const DOTENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template'])
const SECRET_NAMES = new Set(['.npmrc', '.pypirc', '.netrc', '.git-credentials'])
const SECRET_EXTENSIONS = ['.pem', '.p12', '.pfx', '.kdbx']

/**
 * By path, relative to the folder the file is in (`/`-separated): `.env` files except the example ones, SSH identities
 * (not `.pub`), key and certificate stores, package-manager and Git credentials, Terraform state, `credentials*.json`
 * and everything under `.aws`, `.ssh`, plus `.kube/config` and `.docker/config.json`. A `.key` file is a secret
 * unless it is a Keynote document (a ZIP), so `head` is the file's first bytes.
 */
export function isSecretPath(relativePath: string, head: Uint8Array): boolean {
  const parts = relativePath.toLowerCase().split('/')
  const name = parts.at(-1) ?? ''
  if (name === '.env' || (name.startsWith('.env.') && !DOTENV_EXAMPLES.has(name))) return true
  if (name.startsWith('id_') && !name.endsWith('.pub')) return true
  if (SECRET_NAMES.has(name) || SECRET_EXTENSIONS.some(ext => name.endsWith(ext))) return true
  if (name.includes('.keychain') || name.includes('.tfstate')) return true
  if (name.startsWith('credentials') && name.endsWith('.json')) return true
  if (name.endsWith('.key') && !matchesFamily('zip', head)) return true
  if (parts.includes('.aws') || parts.includes('.ssh')) return true
  const tail = parts.slice(-2).join('/')
  return tail === '.git/config' || tail === '.kube/config' || tail === '.docker/config.json'
}

/** By content: a text file whose first bytes hold a credential itself (a private key, a service key, Latch's own). */
export function hasSecretContent(head: Uint8Array): boolean {
  if (!matchesFamily('text', head)) return false
  const encoding = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8'
  return containsSecret(new TextDecoder(encoding, { fatal: false }).decode(head))
}
