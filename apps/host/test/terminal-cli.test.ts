// Pairing links and offline codes never show in a Latch terminal: its output can be attached to a conversation. Assertions
// test patterns rather than print output, so a failure never shows a code.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runLatch, type CliIO } from '../scripts/latch.ts'
import { defaultPolicy } from '../src/policy.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

async function stoppedDataDir(): Promise<{ directory: string; dataDir: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'latch-terminal-cli-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const dataDir = join(directory, 'data')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(
    join(dataDir, 'policy.json'),
    JSON.stringify({ ...defaultPolicy(process.platform), presence: { backend: 'none', helperCdhash: null } }),
    { mode: 0o600 },
  )
  return { directory, dataDir }
}

/** The CLI on an interactive terminal, with this environment. */
function terminal(env: NodeJS.ProcessEnv, cwd: string) {
  const output = { stdout: '', stderr: '' }
  const io: CliIO = {
    stdout: {
      write: (text: string) => {
        output.stdout += text
      },
      isTTY: true,
    },
    stderr: {
      write: (text: string) => {
        output.stderr += text
      },
    },
    stdin: { isTTY: true },
    readSecret: () => Promise.resolve(''),
    readLine: () => Promise.resolve(''),
    env,
    cwd,
  }
  return { output, latch: (...argv: string[]) => runLatch(argv, io) }
}

const CODE = /lpi1-|lpo1-|#pair=/u

describe('pairing codes in a Latch terminal', () => {
  it('shows no pairing link or offline code in a Latch terminal, and still writes them to a 0600 file', async () => {
    const { directory, dataDir } = await stoppedDataDir()
    for (const env of [{ TERM_PROGRAM: 'Latch' }, { LC_TERMINAL: 'Latch', TERM_PROGRAM: 'tmux' }]) {
      const invite = terminal(env, directory)
      expect(await invite.latch('device', 'invite', '--data-dir', dataDir)).toBe(1)
      expect(invite.output.stderr).toContain('Latch 终端的输出可能被加入对话，配对链接不在这里显示；请使用 --code-file <路径>')
      const offline = terminal(env, directory)
      expect(await offline.latch('device', 'enroll', '--offline', '--data-dir', dataDir)).toBe(1)
      expect(offline.output.stderr).toContain('离线登记码不在这里显示；请使用 --code-file <路径>')
      expect(CODE.test(`${invite.output.stdout}${offline.output.stdout}`)).toBe(false)
    }
    for (const env of [
      { TERM_PROGRAM: 'tmux', TMUX: '/tmp/tmux-501/default,1,0' },
      { TERM_PROGRAM: 'Apple_Terminal', STY: '1.ttys000.mac' },
      { TERM_PROGRAM: 'Apple_Terminal', ZELLIJ: '0' },
    ]) {
      const invite = terminal(env, directory)
      expect(await invite.latch('device', 'invite', '--data-dir', dataDir)).toBe(1)
      expect(invite.output.stderr).toContain('终端复用器的窗格可能显示在 Latch 终端里，配对链接不在这里显示；请使用 --code-file <路径>')
      expect(CODE.test(invite.output.stdout)).toBe(false)
    }
    const file = terminal({ TERM_PROGRAM: 'Latch' }, directory)
    expect(await file.latch('device', 'enroll', '--offline', '--code-file', 'code.txt', '--data-dir', dataDir)).toBe(0)
    expect(CODE.test(file.output.stdout)).toBe(false)
    expect(/^lpo1-[A-Z2-7]{26}$/u.test((await readFile(join(directory, 'code.txt'), 'utf8')).trim())).toBe(true)
    expect((await stat(join(directory, 'code.txt'))).mode & 0o777).toBe(0o600)
    // Any other terminal on this computer shows the code as before.
    const other = terminal({ TERM_PROGRAM: 'Apple_Terminal' }, directory)
    expect(await other.latch('device', 'enroll', '--offline', '--data-dir', dataDir)).toBe(0)
    expect(/离线登记码：lpo1-[A-Z2-7]{26}/u.test(other.output.stdout)).toBe(true)
  })
})
