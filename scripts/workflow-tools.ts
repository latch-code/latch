import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type ToolPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64'

export interface WorkflowTool {
  name: 'actionlint' | 'zizmor'
  version: string
  /** Release download directory; an asset's URL is this plus its file name. */
  release: string
  /**
   * One release archive per platform with its SHA-256. Each hash matched the digest GitHub reports
   * for the asset and passed `gh attestation verify` against the project's release workflow at that tag.
   */
  assets: Record<ToolPlatform, { file: string; sha256: string }>
}

// Bumping a version means replacing every hash below with the values checked the same way.
export const WORKFLOW_TOOLS: readonly WorkflowTool[] = [
  {
    name: 'actionlint',
    version: '1.7.12',
    release: 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/',
    assets: {
      'darwin-arm64': {
        file: 'actionlint_1.7.12_darwin_arm64.tar.gz',
        sha256: 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
      },
      'darwin-x64': {
        file: 'actionlint_1.7.12_darwin_amd64.tar.gz',
        sha256: '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
      },
      'linux-arm64': {
        file: 'actionlint_1.7.12_linux_arm64.tar.gz',
        sha256: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
      },
      'linux-x64': {
        file: 'actionlint_1.7.12_linux_amd64.tar.gz',
        sha256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      },
    },
  },
  {
    name: 'zizmor',
    version: '1.31.1',
    release: 'https://github.com/zizmorcore/zizmor/releases/download/v1.31.1/',
    assets: {
      'darwin-arm64': {
        file: 'zizmor-aarch64-apple-darwin.tar.gz',
        sha256: 'ad5aa633cd56215b11e6c51d51f90c7e6b22904a75047d1215abbd422f61d698',
      },
      'darwin-x64': {
        file: 'zizmor-x86_64-apple-darwin.tar.gz',
        sha256: '72ae63bb85b67229c06242f04195cb43927e9fab5f43803c6434dc701a517d61',
      },
      'linux-arm64': {
        file: 'zizmor-aarch64-unknown-linux-gnu.tar.gz',
        sha256: '37eebbd5762a44f262d94875431b14a6d2402991e90a685113ea97b8b41be833',
      },
      'linux-x64': {
        file: 'zizmor-x86_64-unknown-linux-gnu.tar.gz',
        sha256: 'd185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99',
      },
    },
  },
]

export type FetchArchive = (url: string) => Promise<Uint8Array>

export interface EnsureToolOptions {
  /** Each tool lives in `<cacheDir>/<name>-<version>/<name>`. */
  cacheDir: string
  platform?: NodeJS.Platform
  arch?: string
  fetchArchive?: FetchArchive
}

export function toolPlatform(platform: NodeJS.Platform, arch: string): ToolPlatform | undefined {
  const key = `${platform}-${arch}`
  return key === 'darwin-arm64' || key === 'darwin-x64' || key === 'linux-arm64' || key === 'linux-x64' ? key : undefined
}

/**
 * Returns the path of the tool's binary, downloading its release archive first when the cache has no copy.
 * An archive whose SHA-256 differs from the pinned value is rejected before anything is written.
 */
export async function ensureTool(tool: WorkflowTool, options: EnsureToolOptions): Promise<string> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const key = toolPlatform(platform, arch)
  if (!key) throw new Error(`${tool.name} 没有为 ${platform}-${arch} 固定的版本`)
  const directory = join(options.cacheDir, `${tool.name}-${tool.version}`)
  const binary = join(directory, tool.name)
  if (await isFile(binary)) return binary

  const asset = tool.assets[key]
  const archive = await (options.fetchArchive ?? fetchArchive)(tool.release + asset.file)
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== asset.sha256) {
    throw new Error(`${asset.file} 的 SHA-256 为 ${actual}，与固定值 ${asset.sha256} 不符，未安装`)
  }

  await mkdir(options.cacheDir, { recursive: true })
  const staging = await mkdtemp(join(options.cacheDir, `.${tool.name}-`))
  try {
    await writeFile(join(staging, asset.file), archive)
    // Only the binary comes out of the archive; both projects put it at the archive root.
    await run('tar', ['-xzf', asset.file, tool.name], { cwd: staging })
    await chmod(join(staging, tool.name), 0o755)
    await mkdir(directory, { recursive: true })
    await rename(join(staging, tool.name), binary)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return binary
}

async function fetchArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
