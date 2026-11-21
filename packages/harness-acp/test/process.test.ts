import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProcess, setProcessLister } from '../src/wires/process.ts'

afterEach(() => {
  setProcessLister(undefined)
  vi.restoreAllMocks()
})

it.skipIf(process.platform === 'win32')('retries a failed process listing before ending the parent of a detached command', async () => {
  let reportCommand!: (pid: number) => void
  const ready = new Promise<number>(resolve => {
    reportCommand = resolve
  })
  const agent = AgentProcess.spawn(
    {
      command: process.execPath,
      args: [
        '-e',
        `
        const { spawn } = require('node:child_process')
        const child = spawn('/bin/sleep', ['10'], { detached: true, stdio: 'ignore' })
        child.once('spawn', () => console.log(JSON.stringify({ pid: child.pid })))
        process.stdin.resume()
      `,
      ],
      cwd: process.cwd(),
      env: {},
      maxLineBytes: 1024,
      redact: value => value,
    },
    {
      record: row => {
        if (typeof row.pid === 'number') reportCommand(row.pid)
      },
      closed() {},
    },
  )
  let command: number | undefined
  try {
    command = await ready
    const listing = `${command} ${agent.pid} ${command}`
    const read = vi.fn<() => Promise<string | undefined>>().mockResolvedValueOnce(undefined).mockResolvedValue(listing)
    setProcessLister(read)
    await agent.stop('kill', 200)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(() => process.kill(command!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' })))
  } finally {
    setProcessLister(undefined)
    if (command !== undefined) {
      try {
        process.kill(command, 'SIGKILL')
      } catch {
        /* Already gone. */
      }
    }
    await agent.stop('kill', 0)
  }
})

it('does not signal PIDs from a process listing that finishes after the owned leader has exited', async () => {
  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const agent = AgentProcess.spawn(
    {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: {},
      maxLineBytes: 1024,
      redact: value => value,
    },
    { record() {}, closed() {} },
  )
  let listed!: () => void
  const reading = new Promise<void>(resolve => {
    listed = resolve
  })
  let release!: (value: string) => void
  setProcessLister(() => {
    listed()
    return new Promise<string>(resolve => {
      release = resolve
    })
  })
  try {
    const stopping = agent.stop('kill', 50)
    await reading
    process.kill(agent.pid!, 'SIGTERM')
    await agent.exited
    const signals = vi.spyOn(process, 'kill')
    // This PID could have been re-used after the old leader exited. A stale ancestry claim must no longer authorize it.
    release(`${foreign.pid} ${agent.pid} ${foreign.pid}`)
    await stopping
    expect(signals.mock.calls.some(([pid]) => Math.abs(pid) === foreign.pid)).toBe(false)
    expect(() => process.kill(foreign.pid!, 0)).not.toThrow()
  } finally {
    setProcessLister(undefined)
    foreign.kill('SIGKILL')
    await agent.stop('kill', 0)
  }
})
