/**
 * Data-directory entries holding credentials, identity, audit, settings or session data. `snapshots`, `automations` and
 * `automations.json` are listed before any code writes them, so they are private from their first write.
 */
export const PRIVATE_ENTRIES = [
  'plugin-packages',
  'auth',
  'identity',
  'native',
  'personal',
  'audit',
  'policy.json',
  'agents',
  'backups',
  'latch.db',
  'latch.db-wal',
  'latch.db-shm',
  'sessions',
  'harnesses',
  'provider.json',
  'providers.json',
  'settings.json',
  'sessions-meta.json',
  'session-folders.json',
  'project-context.json',
  'host.json',
  'host.log',
  'host.lock',
  'desktop-launch.json',
  'snapshots',
  'automations',
  'automations.json',
]
/**
 * Names the Host writes next to private entries for a moment: atomic-write temp files (the `prefix` their writers pass to
 * `writeFileAtomic`, or the default `.<file name>-`) and a stale lock moved aside.
 */
const TRANSIENT_PREFIXES = [
  '.host-',
  '.policy-',
  '.provider.json-',
  '.providers.json-',
  '.settings.json-',
  'sessions-meta.json.',
  '.project-context.json-',
  '.session-folders.json-',
  '.desktop-launch-',
  '.automations.json-',
]

/** Folds case and Unicode compatibility forms (`Providers.json`, `providerſ.json`), as case-insensitive disks may. */
function foldName(name: string): string {
  return name.normalize('NFKC').toLowerCase()
}

const FOLDED_PRIVATE = new Set(PRIVATE_ENTRIES.map(foldName))
export function isPrivateEntry(name: string): boolean {
  const folded = foldName(name)
  return FOLDED_PRIVATE.has(folded) || TRANSIENT_PREFIXES.some(prefix => folded.startsWith(prefix))
}
