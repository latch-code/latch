// The website and workbench use this at build time. Read the declared files as bytes of a package, never as modules.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type catalogSource from '../latch.catalog.json'

function readSourceFile(root: string, file: string): string {
  const parts = file.split('/')
  if (!parts.every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(part))) throw new Error('Invalid catalog file')
  let path = root
  for (const part of parts.slice(0, -1)) {
    path = join(path, part)
    if (!lstatSync(path).isDirectory()) throw new Error('Invalid catalog source directory')
  }
  path = join(path, parts.at(-1)!)
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || realpathSync(path) !== path) throw new Error('Invalid catalog source file')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino || realpathSync(path) !== path) {
      throw new Error('Catalog source file changed while opening')
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function catalogPackages(repository = fileURLToPath(new URL('../../', import.meta.url))) {
  const root = realpathSync(repository)
  const catalog = JSON.parse(readSourceFile(root, 'examples/latch.catalog.json')) as typeof catalogSource
  return Object.fromEntries(
    catalog.plugins.map(entry => {
      if (!/^[a-z0-9-]+$/u.test(entry.folder)) throw new Error('Invalid catalog folder')
      const read = (file: string) => {
        if (typeof file !== 'string') throw new Error('Invalid catalog file')
        return readSourceFile(root, `examples/${entry.folder}/${file}`)
      }
      const manifest = JSON.parse(read(entry.manifest))
      if (manifest.id !== entry.id || typeof manifest.version !== 'string') throw new Error('Catalog identity mismatch: ' + entry.id)
      return [entry.id, { manifest, files: entry.files.map(path => ({ path, content: read(path) })) }]
    }),
  )
}
