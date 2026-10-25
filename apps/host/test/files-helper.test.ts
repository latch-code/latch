import { spawn } from 'node:child_process'
import { copyFile, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildFilesHelper } from '../scripts/build-files.ts'

const codeRoot = fileURLToPath(new URL('../../../', import.meta.url))
interface Entry {
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number
}
interface Result {
  entries?: Entry[]
  truncated?: boolean
  error?: string
}
let compiled = '',
  binary = '',
  directory = '',
  root = ''

function invoke(input: unknown, raw = false): Promise<{ code: number | null; result: Result; bytes: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0,
      stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Directory helper did not terminate'))
    }, 5000)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1_048_576) child.kill('SIGKILL')
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 4096)
    })
    child.stdin.on('error', () => {})
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timer)
      try {
        resolve({ code, result: JSON.parse(Buffer.concat(chunks).toString()) as Result, bytes, stderr })
      } catch {
        reject(new Error('Directory helper returned invalid JSON'))
      }
    })
    child.stdin.end(raw ? input : JSON.stringify(input))
  })
}

function request(dir = '', protectedPaths: string[] = [], showHidden = false) {
  return { root, dir, protectedPaths, showHidden }
}

describe.skipIf(process.platform !== 'darwin')('descriptor-relative macOS file listing', () => {
  beforeAll(async () => {
    compiled = await mkdtemp(join(tmpdir(), 'latch-files-build-'))
    await mkdir(join(compiled, 'native/macos'), { recursive: true })
    await copyFile(join(codeRoot, 'native/macos/LatchFiles.swift'), join(compiled, 'native/macos/LatchFiles.swift'))
    binary = (await buildFilesHelper(compiled))!
  }, 130_000)
  afterAll(async () => {
    if (compiled) await rm(compiled, { recursive: true, force: true })
  })
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'latch-files-')))
    root = join(directory, 'workspace')
    await mkdir(root)
  })
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('returns metadata for one directory, Unicode names and symlinks without reading or following their contents', async () => {
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'outside-only'), 'private bytes')
    await mkdir(join(root, '子目录'))
    await writeFile(join(root, '你好.txt'), 'hello')
    await symlink(outside, join(root, 'outside-link'))
    const { code, result, stderr } = await invoke(request())
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(result.truncated).toBe(false)
    expect(result.entries?.map(entry => [entry.name, entry.kind]).sort()).toEqual([
      ['outside-link', 'symlink'],
      ['你好.txt', 'file'],
      ['子目录', 'directory'],
    ])
    const file = result.entries?.find(entry => entry.name === '你好.txt')
    expect(file?.size).toBe(5)
    expect(file?.mtime).toBeGreaterThan(Date.now() - 60_000)
    expect((await invoke(request('子目录'))).result).toEqual({ entries: [], truncated: false })
    expect((await invoke(request('outside-link'))).code).toBe(1)
  })

  it('hides generated and dot entries by default, with the same protections when hidden entries are shown', async () => {
    await Promise.all(
      ['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', 'source'].map(name => mkdir(join(root, name))),
    )
    await writeFile(join(root, 'draft.tmp'), '')
    await writeFile(join(root, '.credentials'), 'secret')
    expect((await invoke(request())).result.entries?.map(entry => entry.name)).toEqual(['source'])
    const shown = await invoke(request('', [join(root, '.credentials')], true))
    expect(shown.result.entries?.map(entry => entry.name).sort()).toEqual([
      '.git',
      '.next',
      '.venv',
      '__pycache__',
      'build',
      'dist',
      'draft.tmp',
      'node_modules',
      'source',
    ])
  })

  it('filters protected path spellings, canonical aliases and hard-linked file identities', async () => {
    const privateDirectory = join(root, 'private')
    await mkdir(privateDirectory)
    await writeFile(join(privateDirectory, 'key'), 'secret')
    await link(join(privateDirectory, 'key'), join(root, 'innocent-name'))
    const alias = join(directory, 'private-alias')
    await symlink(privateDirectory, alias)
    await writeFile(join(root, 'allowed'), '')
    const result = await invoke(request('', [alias, join(privateDirectory, 'key')], true))
    expect(result.result.entries?.map(entry => entry.name)).toEqual(['allowed'])
    expect((await invoke(request('private', [privateDirectory], true))).result).toEqual({ error: 'protected' })
    expect((await invoke(request('', [directory]))).result).toEqual({ error: 'protected' })
    expect((await invoke(request('', [root]))).result).toEqual({ error: 'protected' })
  })

  it('refuses symlinks in root and intermediate directory components', async () => {
    await mkdir(join(root, 'target'))
    await symlink('target', join(root, 'alias'))
    await symlink(root, join(directory, 'root-alias'))
    expect((await invoke(request('alias'))).result).toEqual({ error: 'unreadable' })
    expect((await invoke({ ...request(), root: join(directory, 'root-alias') })).result).toEqual({ error: 'unreadable' })
  })

  it('rejects traversal, malformed types and over-budget input with static errors', async () => {
    const invalid = [
      { ...request(), dir: '../outside' },
      { ...request(), dir: '/absolute' },
      { ...request(), dir: 'a//b' },
      { ...request(), dir: 'a/./b' },
      { ...request(), root: `${root}/..` },
      { ...request(), showHidden: 1 },
      { ...request(), protectedPaths: [null] },
      { ...request(), unknown: true },
    ]
    for (const input of invalid) {
      const value = await invoke(input)
      expect(value.result).toEqual({ error: 'invalid-input' })
      expect(value.stderr).toBe('')
    }
    expect((await invoke(` ${' '.repeat(1_048_576)}`, true)).result).toEqual({ error: 'invalid-input' })
    expect((await invoke('{"root":', true)).result).toEqual({ error: 'invalid-input' })
  })

  it('returns a bounded partial listing instead of losing results at the entry and output limits', async () => {
    for (let start = 0; start < 2200; start += 50)
      await Promise.all(Array.from({ length: 50 }, (_, index) => mkdir(join(root, `${'"'.repeat(248)}${start + index}`))))
    const result = await invoke(request())
    expect(result.code).toBe(0)
    expect(result.result.truncated).toBe(true)
    expect(result.result.entries!.length).toBeGreaterThan(0)
    expect(result.result.entries!.length).toBeLessThan(2000)
    expect(result.bytes).toBeLessThanOrEqual(1_048_576)
    await rm(root, { recursive: true })
    await mkdir(root)
    for (let start = 0; start < 2050; start += 50)
      await Promise.all(Array.from({ length: 50 }, (_, index) => mkdir(join(root, `file-${start + index}`))))
    const entries = await invoke(request())
    expect(entries.result.truncated).toBe(true)
    expect(entries.result.entries).toHaveLength(2000)
  }, 20_000)

  it('never lists an outside directory substituted for an accepted directory during concurrent renames', async () => {
    const target = join(root, 'target'),
      parked = join(root, 'parked'),
      outside = join(directory, 'outside')
    await mkdir(target)
    await mkdir(outside)
    await writeFile(join(target, 'inside'), '')
    await writeFile(join(outside, 'outside-only'), 'private')
    let stopped = false
    const mutate = (async () => {
      while (!stopped) {
        await rename(target, parked)
        await symlink(outside, target)
        await new Promise(resolve => setImmediate(resolve))
        await rm(target)
        await rename(parked, target)
      }
    })()
    try {
      for (let index = 0; index < 8; index++) {
        const result = await invoke(request('target'))
        expect(result.stderr).toBe('')
        if (result.code === 0) expect(result.result.entries?.map(entry => entry.name)).toEqual(['inside'])
        else expect(['unreadable', 'changed']).toContain(result.result.error)
      }
    } finally {
      stopped = true
      await mutate
    }
  }, 15_000)
})
