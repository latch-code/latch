import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOGIN_PATH, isLatchTerminal, loginShell, terminalEnvironment } from '../src/terminal/environment.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('terminal environment', () => {
  it('passes the shell an allowlist of the Host environment, without Host settings, model keys or Node switches', () => {
    const hostEnv: NodeJS.ProcessEnv = {
      HOME: '/Users/me',
      USER: 'me',
      LOGNAME: 'me',
      TMPDIR: '/var/folders/x/T/',
      LANG: 'zh_CN.UTF-8',
      LC_TIME: 'en_GB.UTF-8',
      LC_TERMINAL: 'iTerm2',
      SSH_AUTH_SOCK: '/private/tmp/agent.sock',
      PATH: '/repo/node_modules/.bin:/usr/bin',
      LATCH_API_KEY: 'model-key-value',
      LATCH_DATA_DIR: '/Users/me/Library/Application Support/Latch/Host',
      latch_model: 'lowercase-setting',
      OPENAI_API_KEY: 'model-key-value',
      ANTHROPIC_API_KEY: 'model-key-value',
      NODE_OPTIONS: '--inspect=0',
      ELECTRON_RUN_AS_NODE: '1',
      DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
      npm_config_registry: 'https://registry.example',
      GIT_CONFIG_COUNT: '1',
      HTTPS_PROXY: 'http://proxy.example:8080',
      VSCODE_IPC_HOOK: '/tmp/vscode.sock',
    }
    const env = terminalEnvironment({ hostEnv, shell: '/bin/zsh', folder: '/Users/me/code/latch' })
    expect(env).toEqual({
      HOME: '/Users/me',
      USER: 'me',
      LOGNAME: 'me',
      TMPDIR: '/var/folders/x/T/',
      LANG: 'zh_CN.UTF-8',
      LC_TIME: 'en_GB.UTF-8',
      SSH_AUTH_SOCK: '/private/tmp/agent.sock',
      PATH: LOGIN_PATH,
      SHELL: '/bin/zsh',
      PWD: '/Users/me/code/latch',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Latch',
      LC_TERMINAL: 'Latch',
    })
    expect(Object.keys(env).filter(name => /^(?:latch|node|electron|npm|dyld)_/iu.test(name))).toEqual([])
  })

  it('marks the terminal so commands in it, and over ssh from it, know their output is kept', () => {
    const env = terminalEnvironment({ hostEnv: {}, shell: '/bin/zsh', folder: '/tmp' })
    expect(isLatchTerminal(env)).toBe(true)
    // ssh forwards LC_* by default; TERM_PROGRAM alone marks a local shell.
    expect(isLatchTerminal({ LC_TERMINAL: 'Latch', TERM_PROGRAM: 'tmux' })).toBe(true)
    expect(isLatchTerminal({ TERM_PROGRAM: 'Latch' })).toBe(true)
    expect(isLatchTerminal({ TERM_PROGRAM: 'Apple_Terminal', LC_TERMINAL: 'iTerm2' })).toBe(false)
  })

  it('puts the application command before system commands without inheriting a project PATH or loader variables', () => {
    const cliDir = '/Applications/Latch.app/Contents/Resources/bin'
    const env = terminalEnvironment({
      hostEnv: { PATH: '/project', NODE_OPTIONS: '--inspect', LATCH_API_KEY: 'fixture' },
      shell: '/bin/zsh',
      folder: '/project',
      cliDir,
    })
    expect(env.PATH).toBe(`${cliDir}:${LOGIN_PATH}`)
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.LATCH_API_KEY).toBeUndefined()
  })

  it('gives an environment without a locale a UTF-8 one, and fills in who the user is', () => {
    const env = terminalEnvironment({ hostEnv: {}, shell: '/bin/zsh', folder: '/tmp' })
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.HOME).toMatch(/^\//u)
    expect(env.USER).toBeTruthy()
    expect(env.LOGNAME).toBe(env.USER)
    expect(terminalEnvironment({ hostEnv: { LC_ALL: 'C' }, shell: '/bin/zsh', folder: '/tmp' }).LANG).toBeUndefined()
  })

  it('starts the account shell as a login shell, and /bin/zsh when that shell is unusable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-terminal-shell-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const notExecutable = join(directory, 'fish')
    await writeFile(notExecutable, '#!/bin/sh\n', { mode: 0o644 })
    expect(await loginShell(() => ({ shell: '/bin/sh' }))).toEqual({ file: '/bin/sh', argv: ['-sh'] })
    for (const shell of [null, '', 'bin/sh', notExecutable, directory, '/bin/sh\n'])
      expect(await loginShell(() => ({ shell }))).toEqual({ file: '/bin/zsh', argv: ['-zsh'] })
    expect(
      await loginShell(() => {
        throw new Error('no account')
      }),
    ).toEqual({ file: '/bin/zsh', argv: ['-zsh'] })
  })
})
