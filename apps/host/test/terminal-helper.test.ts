// The real latch-pty, built from native/macos/LatchTerminal.swift into a temporary directory, running /bin/sh -c on
// harmless commands in temporary folders. No login shell, profile or network is involved.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Writable, type Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildTerminalHelper } from '../scripts/build-terminal.ts'
import { FROM_HELPER, FrameReader, TO_HELPER, encodeFrame, encodeSize } from '../src/terminal/frames.ts'
import { TerminalService, type TerminalRequester, type TerminalStreamEvent } from '../src/terminal/service.ts'

const run = promisify(execFile)
const codeRoot = fileURLToPath(new URL('../../../', import.meta.url))
let compiled = '',
  binary = '',
  folder = ''
const children: ChildProcess[] = []
const message = z.record(z.string(), z.unknown())
const mac: TerminalRequester = { listener: 'unix', deviceId: 'dev_mac' }

/** Speaks the frame protocol to one helper and records every frame it sends. */
class Helper {
  readonly frames: Array<{ type: number; payload: Buffer }> = []
  readonly child: ChildProcess
  readonly stdin: Writable
  readonly control: Writable
  readonly stdout: Readable
  readonly closed: Promise<number | null>
  private readonly reader = new FrameReader()

  constructor(start: object | Buffer | undefined, options: { extraPipe?: boolean } = {}) {
    // As the Host runs it: the helper's own environment is empty, the shell's comes in the start frame.
    // Resize and signal frames go on fd 3, so input a program does not read cannot hold them back.
    const child = spawn(binary, [], {
      env: {},
      stdio: options.extraPipe ? ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'ignore', 'pipe'],
    })
    const { stdin, stdout } = child
    const control = child.stdio[3]
    if (!stdin || !stdout || !(control instanceof Writable)) throw new Error('no pipes')
    this.child = child
    this.stdin = stdin
    this.stdout = stdout
    this.control = control
    control.on('error', () => {})
    children.push(child)
    stdin.on('error', () => {})
    stdout.on('data', (chunk: Buffer) => {
      for (const frame of this.reader.push(chunk)) this.frames.push({ type: frame.type, payload: Buffer.from(frame.payload) })
    })
    this.closed = new Promise(resolve => child.once('close', code => resolve(code)))
    if (start) this.send(TO_HELPER.start, Buffer.isBuffer(start) ? start : Buffer.from(JSON.stringify(start)))
  }

  send(type: number, payload: Uint8Array = new Uint8Array(0)): void {
    const channel = type === TO_HELPER.resize || type === TO_HELPER.signal ? this.control : this.stdin
    channel.write(encodeFrame(type, payload))
  }

  output(): string {
    return Buffer.concat(this.frames.filter(frame => frame.type === FROM_HELPER.output).map(frame => frame.payload)).toString()
  }

  messages(type: number): Array<Record<string, unknown>> {
    return this.frames.filter(frame => frame.type === type).map(frame => message.parse(JSON.parse(frame.payload.toString())))
  }

  get pid(): number {
    return Number(this.messages(FROM_HELPER.started)[0]?.pid)
  }

  /** A number the shell printed after `label=`. */
  printed(label: string): number {
    return Number(new RegExp(`${label}=(\\d+)`, 'u').exec(this.output())?.[1])
  }

  async until(check: () => boolean, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out; output so far: ${JSON.stringify(this.output())}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

function shell(script: string, env: Record<string, string> = { PATH: '/usr/bin:/bin' }) {
  return { file: '/bin/sh', argv: ['sh', '-c', script], env, cwd: folder, cols: 80, rows: 24 }
}

/** Whether a process (a zombie included) still exists. */
async function exists(pid: number): Promise<boolean> {
  try {
    return (await run('/bin/ps', ['-o', 'stat=', '-p', String(pid)])).stdout.trim() !== ''
  } catch {
    return false
  }
}

async function gone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 5000
  for (const pid of pids) {
    while (await exists(pid)) {
      if (Date.now() > deadline) throw new Error(`process ${pid} is still there`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

/** A service with the real helper whose shell runs `script` in the session folder, and one terminal open in it. */
async function openTerminal(script: string) {
  const terminals = await TerminalService.open(
    {
      sessionFolder: () => Promise.resolve({ path: folder }),
      hostEnv: { HOME: folder, USER: 'me', LANG: 'zh_CN.UTF-8', LATCH_API_KEY: 'model-key-value', NODE_OPTIONS: '--inspect' },
      shell: { file: '/bin/sh', argv: ['sh', '-c', script] },
    },
    binary,
  )
  const summary = await terminals.create('s1', mac, { cols: 100, rows: 30 })
  const events: TerminalStreamEvent[] = []
  const ref = { sessionId: 's1', terminalId: summary.id }
  terminals.stream(ref, mac, { write: event => events.push(event) > 0, end: () => {} })
  const output = () => Buffer.concat(events.flatMap(event => (event.type === 'output' ? [event.data] : []))).toString()
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out; output so far: ${JSON.stringify(output())}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  return { terminals, ref, output, until }
}

async function withUnreadInput(script: string) {
  const helper = new Helper(shell(`echo ready; ${script}`))
  await helper.until(() => helper.output().includes('ready'))
  for (let frame = 0; frame < 8; frame++) helper.send(TO_HELPER.input, Buffer.alloc(65_536, 0x61))
  await new Promise(resolve => setTimeout(resolve, 300))
  return helper
}

describe.skipIf(process.platform !== 'darwin')('latch-pty', () => {
  beforeAll(async () => {
    compiled = await mkdtemp(join(tmpdir(), 'latch-pty-build-'))
    await mkdir(join(compiled, 'native/macos'), { recursive: true })
    await copyFile(join(codeRoot, 'native/macos/LatchTerminal.swift'), join(compiled, 'native/macos/LatchTerminal.swift'))
    binary = (await buildTerminalHelper(compiled))!
  }, 130_000)
  afterAll(async () => {
    if (compiled) await rm(compiled, { recursive: true, force: true })
  })
  beforeEach(async () => {
    folder = await realpath(await mkdtemp(join(tmpdir(), 'latch-pty-folder-')))
  })
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
    if (folder) await rm(folder, { recursive: true, force: true })
  })

  it('runs the command in the folder it was given, with exactly the environment the Host sent, and reports its exit', async () => {
    const helper = new Helper(shell('pwd; env; exit 3', { PATH: '/usr/bin:/bin', PROBE: 'value' }))
    expect(await helper.closed).toBe(0)
    expect(helper.frames.map(frame => frame.type).filter(type => type !== FROM_HELPER.output && type !== FROM_HELPER.foreground)).toEqual([
      FROM_HELPER.started,
      FROM_HELPER.exit,
    ])
    expect(helper.pid).toBeGreaterThan(1)
    expect(helper.messages(FROM_HELPER.exit)).toEqual([{ code: 3 }])
    const lines = helper.output().split('\r\n')
    expect(lines[0]).toBe(folder)
    expect(lines).toContain('PROBE=value')
    const names = lines.slice(1).flatMap(line => /^([A-Za-z_]\w*)=/u.exec(line)?.slice(1, 2) ?? [])
    // sh adds PWD, SHLVL and _ itself; nothing else reaches it.
    expect(names.filter(name => !['PATH', 'PROBE', 'PWD', 'SHLVL', '_'].includes(name))).toEqual([])
  })

  it('applies the size, resizes, delivers input and signals the foreground program', async () => {
    const helper = new Helper(
      shell(
        'trap "echo got-int; stty size; exit 7" INT; stty size; echo ready; read line; echo "line=$line"; while :; do sleep 0.05; done',
      ),
    )
    await helper.until(() => helper.output().includes('ready'))
    expect(helper.output()).toContain('24 80\r\n')
    helper.send(TO_HELPER.resize, encodeSize(132, 43))
    helper.send(TO_HELPER.input, Buffer.from('typed 你好\r'))
    await helper.until(() => helper.output().includes('line=typed 你好'))
    helper.send(TO_HELPER.signal, Uint8Array.of(2))
    expect(await helper.closed).toBe(0)
    expect(helper.output()).toContain('got-int\r\n43 132\r\n')
    expect(helper.messages(FROM_HELPER.exit)).toEqual([{ code: 7 }])
  })

  it('ends every process group on the terminal when it is closed, also those that ignore the hangup, and leaves no process behind', async () => {
    const helper = new Helper(
      shell('set -m; trap "" HUP; (trap "" HUP; exec sleep 61) & echo "bg=$!"; sh -c "trap \\"\\" HUP; echo fg=\\$\\$; exec sleep 62"'),
    )
    await helper.until(() => /fg=\d+/u.test(helper.output()))
    // The name follows the exec of sleep, which prints nothing.
    await helper.until(() => {
      const last = helper.messages(FROM_HELPER.foreground).at(-1)
      return last?.busy === true && last.name === 'sleep'
    })
    const pids = [helper.pid, helper.printed('bg'), helper.printed('fg')]
    helper.stdin.end()
    expect(await helper.closed).toBe(0)
    expect(helper.messages(FROM_HELPER.exit)).toEqual([{ signal: 9 }])
    await gone(pids)
  })

  it('closes at once when the programs honour the hangup, on SIGTERM as on end of input', async () => {
    const helper = new Helper(shell('set -m; sleep 63 & echo "bg=$!"; sleep 64'))
    await helper.until(() => /bg=\d+/u.test(helper.output()))
    const pids = [helper.pid, helper.printed('bg')]
    const started = Date.now()
    helper.child.kill('SIGTERM')
    expect(await helper.closed).toBe(0)
    expect(Date.now() - started).toBeLessThan(900)
    expect(helper.messages(FROM_HELPER.exit)).toEqual([{ signal: 1 }])
    await gone(pids)
  })

  it('never hands the shell a descriptor other than its terminal, even one the helper inherited', async () => {
    const helper = new Helper(
      shell('for fd in 3 4 5 6 7 8 9; do if { true >&$fd; } 2>/dev/null; then echo "open $fd"; fi; done; echo checked'),
      {
        extraPipe: true,
      },
    )
    expect(await helper.closed).toBe(0)
    expect(helper.output()).toBe('checked\r\n')
  })

  it('keeps output whole and holds the program back while the Host does not read', async () => {
    const helper = new Helper(shell('head -c 1000000 /dev/zero | tr "\\0" "y"; echo; echo done'))
    helper.stdout.pause()
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(helper.frames.some(frame => frame.type === FROM_HELPER.exit)).toBe(false)
    helper.stdout.resume()
    expect(await helper.closed).toBe(0)
    const output = helper.output()
    expect(output.replaceAll(/[^y]/gu, '')).toHaveLength(1_000_000)
    expect(output.endsWith('\r\ndone\r\n')).toBe(true)
    // Output is coalesced: far fewer frames than the pty's 1 KiB reads.
    expect(helper.frames.filter(frame => frame.type === FROM_HELPER.output).length).toBeLessThan(400)
  })

  it('still takes signals and resizes while input waits for a program that does not read it', async () => {
    const stopped = await withUnreadInput('exec sleep 30')
    stopped.send(TO_HELPER.resize, encodeSize(100, 30))
    stopped.send(TO_HELPER.signal, Uint8Array.of(2))
    await stopped.until(() => stopped.frames.some(frame => frame.type === FROM_HELPER.exit), 3000)
    expect(stopped.messages(FROM_HELPER.exit)).toEqual([{ signal: 2 }])
  })

  it('ends the terminal when the Host goes away while input waits', async () => {
    const helper = await withUnreadInput('exec sleep 31')
    const { pid } = helper
    helper.control.end()
    expect(await Promise.race([helper.closed, new Promise(resolve => setTimeout(() => resolve('alive'), 4000))])).toBe(0)
    await gone([pid])
  })

  it('notices a silent program that takes the terminal after the last activity', async () => {
    const helper = new Helper(shell('set -m; sleep 0.4; sleep 32'))
    await helper.until(() => {
      const last = helper.messages(FROM_HELPER.foreground).at(-1)
      return last?.busy === true && last.name === 'sleep'
    }, 5000)
  })

  it('delivers a long paste whole, and frees what it has written while more waits', async () => {
    const total = 12 * 1024 * 1024
    const helper = new Helper(shell(`stty raw -echo; echo ready; head -c ${total} | wc -c`))
    await helper.until(() => helper.output().includes('ready'))
    const chunk = Buffer.alloc(65_536, 0x61)
    let peak = 0
    let sent = 0
    while (sent < total) {
      helper.send(TO_HELPER.input, chunk)
      sent += chunk.length
      if (helper.stdin.writableNeedDrain) await new Promise(resolve => helper.stdin.once('drain', resolve))
      if (sent % (1024 * 1024) === 0 && helper.child.pid) {
        peak = Math.max(peak, Number((await run('/bin/ps', ['-o', 'rss=', '-p', String(helper.child.pid)])).stdout))
      }
    }
    expect(peak).toBeLessThan(16 * 1024)
    await helper.until(() => helper.output().includes(String(total)), 30_000)
  }, 60_000)

  it('refuses a malformed start and reports why a start failed, before anything runs', async () => {
    const oversized = Buffer.alloc(5)
    oversized.writeUInt8(TO_HELPER.start, 0)
    oversized.writeUInt32BE(70_000, 1)
    const cases: Array<[object | Buffer, string]> = [
      [Buffer.from('{"file":'), 'invalid-input'],
      [{ ...shell('true'), extra: 1 }, 'invalid-input'],
      [{ ...shell('true'), file: 'bin/sh' }, 'invalid-input'],
      [{ ...shell('true'), cwd: 'relative' }, 'invalid-input'],
      [{ ...shell('true'), cols: 80.5 }, 'invalid-input'],
      [{ ...shell('true'), cols: 0 }, 'invalid-input'],
      [{ ...shell('true'), rows: true }, 'invalid-input'],
      [{ ...shell('true'), argv: [] }, 'invalid-input'],
      [{ ...shell('true'), argv: ['sh', 'a\u0000b'] }, 'invalid-input'],
      [{ ...shell('true'), env: { 'A=B': 'c' } }, 'invalid-input'],
      [{ ...shell('true'), env: { A: 'b\u0000c' } }, 'invalid-input'],
      [{ ...shell('true'), env: { A: 1 } }, 'invalid-input'],
      [{ file: '/bin/sh', argv: ['sh', '-c', 'true'], cwd: folder, cols: 80, rows: 24 }, 'invalid-input'],
      [{ ...shell('true'), cwd: join(folder, 'missing') }, 'cwd'],
      [{ ...shell('true'), file: join(folder, 'no-such-shell') }, 'exec'],
    ]
    for (const [start, error] of cases) {
      const helper = new Helper(start)
      expect(await helper.closed, JSON.stringify(start)).toBe(1)
      expect(helper.messages(FROM_HELPER.error)).toEqual([{ error }])
      expect(helper.frames).toHaveLength(1)
    }
    const raw = new Helper(undefined)
    raw.stdin.end(oversized)
    expect(await raw.closed).toBe(1)
    expect(raw.messages(FROM_HELPER.error)).toEqual([{ error: 'invalid-input' }])
    const inputFirst = new Helper(undefined)
    inputFirst.send(TO_HELPER.input, Buffer.from('ls\r'))
    expect(await inputFirst.closed).toBe(1)
    expect(inputFirst.messages(FROM_HELPER.error)).toEqual([{ error: 'invalid-input' }])
  })

  it('ends the terminal on a malformed frame once it runs', async () => {
    const helper = new Helper(shell('echo ready; while :; do sleep 0.05; done'))
    await helper.until(() => helper.output().includes('ready'))
    helper.send(TO_HELPER.resize, Buffer.from([0, 80, 0]))
    expect(await helper.closed).toBe(1)
    expect(helper.messages(FROM_HELPER.error)).toEqual([{ error: 'invalid-input' }])
    expect(helper.frames.at(-1)?.type).toBe(FROM_HELPER.exit)
  })

  describe('through the terminal service', () => {
    it('runs in the session folder without the Host secrets, streams the output, finds the dev server and reports the exit', async () => {
      const { terminals, ref, output, until } = await openTerminal('pwd; stty size; env; echo "  Local:   http://localhost:5173/"; exit 4')
      await until(() => terminals.list('s1', mac)[0]?.status === 'exited')
      const lines = output().split('\r\n')
      expect(lines.slice(0, 2)).toEqual([folder, '30 100'])
      expect(lines.filter(line => /^(?:LATCH|NODE|OPENAI)_/iu.test(line))).toEqual([])
      expect(lines).toContain('LANG=zh_CN.UTF-8')
      expect(lines).toContain('TERM=xterm-256color')
      expect(lines).toContain('TERM_PROGRAM=Latch')
      expect(terminals.list('s1', mac)[0]).toMatchObject({ status: 'exited', exitCode: 4, shell: 'sh', services: [] })
      expect(terminals.extract(ref, mac, { lines: 1 }).text).toBe('  Local:   http://localhost:5173/')
      await terminals.shutdown()
    })

    it('closes a terminal with programs running in it, and leaves none of them behind', async () => {
      const { terminals, ref, output, until } = await openTerminal('set -m; sleep 65 & echo "bg=$!"; echo "sh=$$"; sleep 66')
      await until(() => /sh=\d+/u.test(output()))
      const pids = ['bg', 'sh'].map(label => Number(new RegExp(`${label}=(\\d+)`, 'u').exec(output())?.[1]))
      await until(() => terminals.list('s1', mac).some(terminal => terminal.busy))
      await terminals.close(ref, mac, { force: true })
      expect(terminals.list('s1', mac)).toEqual([])
      await gone(pids)
      await terminals.shutdown()
    })
  })
})
