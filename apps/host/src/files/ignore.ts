// What the Host leaves out when it watches or records a session's folders: tool state, dependencies and build output,
// and files whose name says they may hold a secret. The output tracker and the change snapshots share these rules.
import { redactSecrets } from '@latch/core/node-kit'
import { isSecretPath } from './secrets.ts'

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', '.ds_store'])
const EMPTY = new Uint8Array()

/** A relative, `/`-separated path under an ignored name, or a `*.tmp` file. */
export function isIgnoredPath(path: string): boolean {
  return path.split('/').some(part => IGNORED_NAMES.has(part.toLowerCase())) || path.toLowerCase().endsWith('.tmp')
}

/** A path whose name alone says the file may hold a secret, or that has a secret's shape itself. Decided without reading it. */
export function isSecretLookingPath(path: string): boolean {
  return isSecretPath(path, EMPTY) || redactSecrets(path) !== path
}
