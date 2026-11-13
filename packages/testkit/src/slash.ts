import { fileURLToPath } from 'node:url'

/** Shared by browser matching tests and the native client's matching tests. */
export const SLASH_MATCH_VECTORS_FILE = fileURLToPath(new URL('../vectors/slash-match-v1.json', import.meta.url))
