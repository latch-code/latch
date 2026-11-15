import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function seedCliFiles(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { mode: 0o700, recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(dirname(path), { mode: 0o700, recursive: true })
    await writeFile(path, contents, { mode: 0o600, flag: 'wx' })
  }
}

export async function cliTree(root: string) {
  const entries = []
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, name)
    const stat = await lstat(path, { bigint: true })
    entries.push({
      name,
      mode: stat.mode,
      inode: stat.ino,
      modified: stat.mtimeNs,
      content: stat.isSymbolicLink() ? await readlink(path) : stat.isFile() ? await readFile(path) : undefined,
    })
  }
  return entries
}

/** The fake program and its descendants see only the given CLI home, with no change to the Vitest process. */
export async function fakeCli(command: string, fixture: string, home: string, env: Record<string, string> = {}): Promise<void> {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const scoped = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ...env,
  }
  const words = [...Object.entries(scoped).map(([name, value]) => quote(`${name}=${value}`)), quote(process.execPath), quote(fixture)]
  await mkdir(dirname(command), { mode: 0o700, recursive: true })
  await writeFile(command, `#!/bin/sh\nexec /usr/bin/env ${words.join(' ')} "$@"\n`, { mode: 0o700, flag: 'wx' })
}
