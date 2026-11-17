import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createCliLink } = require('../src/cli-link.cjs') as {
  createCliLink(input: { target: string; available: boolean; home: string; path: string }): {
    view(): Promise<{ status: string; inPath: boolean }>
    install(): Promise<{ status: string }>
  }
}
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'latch-cli-link-'))
  directories.push(home)
  return {
    home,
    destination: join(home, '.local/bin/latch'),
    cli: createCliLink({ target: '/Applications/Latch.app/Contents/Resources/bin/latch', available: true, home, path: '/usr/bin:/bin' }),
  }
}

describe('CLI link', () => {
  it('creates one user-level link and leaves shell profiles alone', async () => {
    const { home, cli, destination } = await fixture()
    await writeFile(join(home, '.zprofile'), 'unchanged')
    expect(await cli.view()).toMatchObject({ status: 'unlinked', inPath: false })
    expect(await cli.install()).toMatchObject({ status: 'linked' })
    expect(await cli.install()).toMatchObject({ status: 'linked' })
    expect(await readlink(destination)).toBe('/Applications/Latch.app/Contents/Resources/bin/latch')
    expect(await readFile(join(home, '.zprofile'), 'utf8')).toBe('unchanged')
  })
  it.each(['file', 'link'])('never overwrites another command: %s', async kind => {
    const { home, cli, destination } = await fixture()
    await mkdir(join(home, '.local/bin'), { recursive: true })
    if (kind === 'file') await writeFile(destination, 'someone else')
    else await symlink('/someone/else/latch', destination)
    expect(await cli.install()).toMatchObject({ status: 'occupied' })
    expect(kind === 'file' ? await readFile(destination, 'utf8') : await readlink(destination)).toBe(
      kind === 'file' ? 'someone else' : '/someone/else/latch',
    )
  })
  it('refuses a symlinked command directory', async () => {
    const { home, cli } = await fixture()
    await mkdir(join(home, 'elsewhere'))
    await symlink(join(home, 'elsewhere'), join(home, '.local'))
    await expect(cli.install()).rejects.toThrow('权限不安全')
  })
})
