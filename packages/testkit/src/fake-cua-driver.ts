import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_MCP_STDIO } from './acp.ts'

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * A stand-in for Cua Driver's app bundle under `root`, for 「操控这台 Mac」: `Contents/MacOS/cua-driver` answers
 * `--version` with `cua-driver <version>` (or `versionLine` as written), and anything else by running the fake MCP
 * server (copied beside the bundle, out of Latch's own directory) with `tools` added to its list, `instructions` as its
 * own guide at `initialize`, logging to `log`.
 * Unsigned: the Host is given a signature check that stands in for `codesign`. Returns the bundle's path.
 */
export async function writeFakeCuaDriver(
  root: string,
  options: { version?: string; versionLine?: string; tools?: readonly string[]; log?: string; instructions?: string } = {},
): Promise<string> {
  const app = join(root, 'CuaDriver.app')
  const bin = join(app, 'Contents', 'MacOS')
  await mkdir(bin, { recursive: true })
  const server = join(root, 'fake-cua-mcp.mjs')
  await copyFile(FAKE_MCP_STDIO, server)
  const line = options.versionLine ?? `cua-driver ${options.version ?? '0.44.0'}`
  const program = join(bin, 'cua-driver')
  await writeFile(
    program,
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then printf '%s\\n' ${quote(line)}; exit 0; fi`,
      `FAKE_MCP_EXTRA_TOOLS=${quote((options.tools ?? []).join(','))} FAKE_MCP_LOG=${quote(options.log ?? '')} FAKE_MCP_INSTRUCTIONS=${quote(options.instructions ?? '')} exec ${quote(process.execPath)} ${quote(server)}`,
      '',
    ].join('\n'),
  )
  await chmod(program, 0o755)
  return app
}
