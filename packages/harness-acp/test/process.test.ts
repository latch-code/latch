import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProcess, setProcessLister } from '../src/wires/process.ts'

afterEach(() => {
  setProcessLister(undefined)
  vi.restoreAllMocks()
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
