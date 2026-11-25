import { OFFICIAL_PLUGIN_CATALOG_REPOSITORY } from '@latch/protocol'
import { githubInvalid, githubRequest, safeSourcePath, type ExternalReaderOptions } from './plugin-external-files.ts'

const repository = new URL(OFFICIAL_PLUGIN_CATALOG_REPOSITORY).pathname
const sha = /^[0-9a-f]{40}$/u
const validCommit = (commit: string) => sha.test(commit) && commit !== '0'.repeat(40)

/** Git's smart HTTP v0 advertisement starts with a service announcement, then length-prefixed refs between two flushes. */
export async function resolveOfficialMain(options: ExternalReaderOptions): Promise<string> {
  const response = await githubRequest(options)(
    `${OFFICIAL_PLUGIN_CATALOG_REPOSITORY}.git/info/refs?service=git-upload-pack`,
    512 * 1024,
    'application/x-git-upload-pack-advertisement',
  )
  let offset = 0
  const packet = (): string | undefined => {
    const length = response.toString('latin1', offset, offset + 4)
    if (!/^[0-9a-f]{4}$/u.test(length)) throw githubInvalid()
    offset += 4
    const size = Number.parseInt(length, 16)
    if (size === 0) return undefined
    if (size < 5 || size > 65520 || offset + size - 4 > response.length) throw githubInvalid()
    const data = response.toString('utf8', offset, offset + size - 4)
    offset += size - 4
    return data.endsWith('\n') ? data.slice(0, -1) : data
  }
  if (packet() !== '# service=git-upload-pack' || packet() !== undefined) throw githubInvalid()
  let main: string | undefined
  let first = true
  for (let line = packet(); line !== undefined; line = packet()) {
    const capabilities = line.indexOf('\0')
    if (capabilities !== -1) {
      if (!first || /[\r\n\0]/u.test(line.slice(capabilities + 1))) throw githubInvalid()
      line = line.slice(0, capabilities)
    }
    first = false
    const ref = /^([0-9a-f]{40}) ([^\p{Cc} ]+)$/u.exec(line)
    if (!ref) throw githubInvalid()
    if (ref[2] === 'refs/heads/main') {
      if (main || !validCommit(ref[1])) throw githubInvalid()
      main = ref[1]
    }
  }
  if (!main || offset !== response.length) throw githubInvalid()
  return main
}

export async function getOfficialArchive(commit: string, options: ExternalReaderOptions): Promise<Buffer> {
  if (!validCommit(commit)) throw githubInvalid()
  return githubRequest(options)(`https://codeload.github.com${repository}/tar.gz/${commit}`, 16 * 1024 * 1024, 'application/octet-stream')
}

export async function readOfficialRaw(commit: string, path: string, limit: number, options: ExternalReaderOptions): Promise<Buffer> {
  if (!validCommit(commit) || !safeSourcePath(path)) throw githubInvalid()
  const file = path.split('/').map(encodeURIComponent).join('/')
  return githubRequest(options)(`https://raw.githubusercontent.com${repository}/${commit}/${file}`, limit, 'application/octet-stream')
}
