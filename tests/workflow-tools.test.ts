import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureTool, toolPlatform, type WorkflowTool } from '../scripts/workflow-tools.ts'

const run = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'latch-workflow-tools-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** A release archive holding an executable `zizmor` script and a README, like the real archives' layout. */
async function releaseArchive(): Promise<Uint8Array> {
  const source = await tempDir()
  await writeFile(join(source, 'zizmor'), '#!/bin/sh\necho fake zizmor\n')
  await chmod(join(source, 'zizmor'), 0o644)
  await writeFile(join(source, 'README.md'), 'not extracted\n')
  await run('tar', ['-czf', 'archive.tar.gz', 'zizmor', 'README.md'], { cwd: source })
  return new Uint8Array(await readFile(join(source, 'archive.tar.gz')))
}

function pinnedTo(archive: Uint8Array, sha256 = createHash('sha256').update(archive).digest('hex')): WorkflowTool {
  const asset = { file: 'zizmor-test.tar.gz', sha256 }
  return {
    name: 'zizmor',
    version: '0.0.1',
    release: 'https://example.invalid/releases/',
    assets: { 'darwin-arm64': asset, 'darwin-x64': asset, 'linux-arm64': asset, 'linux-x64': asset },
  }
}

describe('workflow tool downloads', () => {
  it('maps only the platforms that have pinned archives', () => {
    expect(toolPlatform('darwin', 'arm64')).toBe('darwin-arm64')
    expect(toolPlatform('linux', 'x64')).toBe('linux-x64')
    expect(toolPlatform('win32', 'x64')).toBeUndefined()
    expect(toolPlatform('linux', 'ia32')).toBeUndefined()
  })

  it('installs the binary from an archive that matches the pinned hash', async () => {
    const archive = await releaseArchive()
    const cacheDir = await tempDir()
    const urls: string[] = []
    const binary = await ensureTool(pinnedTo(archive), {
      cacheDir,
      platform: 'linux',
      arch: 'x64',
      fetchArchive: async url => {
        urls.push(url)
        return archive
      },
    })

    expect(urls).toEqual(['https://example.invalid/releases/zizmor-test.tar.gz'])
    expect(binary).toBe(join(cacheDir, 'zizmor-0.0.1', 'zizmor'))
    expect((await run(binary, [])).stdout).toBe('fake zizmor\n')
    // Nothing else from the archive and no staging directory stays behind.
    expect(await readdir(cacheDir)).toEqual(['zizmor-0.0.1'])
    expect(await readdir(join(cacheDir, 'zizmor-0.0.1'))).toEqual(['zizmor'])
  })

  it('rejects an archive whose hash differs and writes nothing', async () => {
    const archive = await releaseArchive()
    const cacheDir = await tempDir()
    const tool = pinnedTo(archive, '0'.repeat(64))

    await expect(ensureTool(tool, { cacheDir, platform: 'darwin', arch: 'arm64', fetchArchive: async () => archive })).rejects.toThrow(
      `zizmor-test.tar.gz 的 SHA-256 为 ${createHash('sha256').update(archive).digest('hex')}，与固定值 ${'0'.repeat(64)} 不符，未安装`,
    )
    expect(await readdir(cacheDir)).toEqual([])
  })

  it('reuses an installed binary without downloading again', async () => {
    const archive = await releaseArchive()
    const cacheDir = await tempDir()
    const tool = pinnedTo(archive)
    const options = { cacheDir, platform: 'linux' as const, arch: 'arm64' }
    const first = await ensureTool(tool, { ...options, fetchArchive: async () => archive })

    const second = await ensureTool(tool, {
      ...options,
      fetchArchive: () => Promise.reject(new Error('downloaded again')),
    })
    expect(second).toBe(first)
  })

  it('refuses a platform without a pinned archive before downloading', async () => {
    const cacheDir = await tempDir()
    await mkdir(join(cacheDir, 'unrelated'))
    await expect(
      ensureTool(pinnedTo(new Uint8Array()), {
        cacheDir,
        platform: 'win32',
        arch: 'x64',
        fetchArchive: () => Promise.reject(new Error('should not download')),
      }),
    ).rejects.toThrow('zizmor 没有为 win32-x64 固定的版本')
    expect(await readdir(cacheDir)).toEqual(['unrelated'])
  })
})
