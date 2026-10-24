import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('plugin SDK types', () => {
  let consumer: string | undefined
  afterEach(async () => {
    if (consumer) await rm(consumer, { recursive: true, force: true })
    consumer = undefined
  })

  // An outside project compiles the SDK's TypeScript sources with its own options. Without allowImportingTsExtensions,
  // only type-only imports may name a .ts file, so the files these subpaths reach must import types and nothing else.
  it('type-check in an outside TypeScript project that does not allow .ts import extensions', async () => {
    consumer = await mkdtemp(join(tmpdir(), 'latch-sdk-consumer-'))
    await mkdir(join(consumer, 'node_modules'))
    await symlink(resolve('.'), join(consumer, 'node_modules', 'harness-link'), 'dir')
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'sdk-consumer', private: true, type: 'module' }))
    await writeFile(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', strict: true, noEmit: true, types: [] },
        files: ['plugin.ts'],
      }),
    )
    await writeFile(
      join(consumer, 'plugin.ts'),
      [
        "import type { HarnessPlugin, PluginInfo, ToolDefinition } from 'harness-link/plugin-sdk'",
        "import type { HarnessDriver, HarnessHostOptions } from 'harness-link/harness-sdk'",
        'export type Surface = [HarnessPlugin, PluginInfo, ToolDefinition, HarnessDriver, HarnessHostOptions]',
        '',
      ].join('\n'),
    )
    const output = await execFileAsync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', consumer]).then(
      result => result.stdout,
      (error: Error & { stdout?: string }) => error.stdout || error.message,
    )
    expect(output).toBe('')
  })
})
