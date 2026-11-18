import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

/** Which relay file `pnpm relay-edge:accept` reads when none is named, run as the script with a temporary HOME. */
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
function accept(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(done => {
    execFile(
      process.execPath,
      ['--disable-sigusr1', '--import', 'tsx', resolve('apps/relay-edge/scripts/accept.ts'), ...args],
      { cwd: resolve('.'), env: { PATH: process.env.PATH ?? '', HOME: home }, timeout: 30_000 },
      (error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    )
  })
}

it('reads the only relay file in ~/.latch/relays, and names the files (never their contents) when there are several', async () => {
  const home = await mkdtemp(join(tmpdir(), 'latch-relay-accept-'))
  homes.push(home)
  const empty = await accept(home)
  expect(empty.code).toBe(1)
  expect(empty.stderr).toContain('~/.latch/relays 里没有中继文件；用 --file <中继文件> 指定')

  const relays = join(home, '.latch', 'relays')
  await mkdir(join(home, '.latch'), { mode: 0o700 })
  await mkdir(relays, { mode: 0o700 })
  // Not a relay file: the run stops on reading it, before any network step, which shows that it was the file chosen.
  await writeFile(join(relays, 'ne.json'), '{"note":"not-a-relay-file"}', { mode: 0o600 })
  const one = await accept(home)
  expect(one.code).toBe(1)
  expect(one.stderr).toContain('这个文件不是 Workers 中继的中继文件')

  await writeFile(join(relays, 'se.json'), '{"note":"not-a-relay-file"}', { mode: 0o600 })
  const several = await accept(home)
  expect(several.code).toBe(1)
  expect(several.stderr).toContain('~/.latch/relays 里有 ne、se；用 --name <名称> 选一个')
  expect(several.stderr).not.toContain('not-a-relay-file')
  const named = await accept(home, '--name', 'se')
  expect(named.stderr).toContain('这个文件不是 Workers 中继的中继文件')
  expect((await accept(home, '--name', 'se', '--file', join(relays, 'se.json'))).stderr).toContain('--file 与 --name 只用一个')
}, 60_000)
