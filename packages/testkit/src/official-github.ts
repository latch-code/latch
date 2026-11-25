import { gzipSync } from 'node:zlib'

const officialRepo = 'latch-code/plugin-market'

function tarEntry(path: string, type: '0' | '5' | 'g', text = ''): Buffer {
  const header = Buffer.alloc(512)
  const bytes = Buffer.from(text)
  const split = Buffer.byteLength(path) > 100 ? path.lastIndexOf('/', path.length - 2) : -1
  const name = path.slice(split + 1)
  const prefix = split < 0 ? '' : path.slice(0, split)
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('Fixture path does not fit a ustar header')
  header.write(name, 0, 100)
  header.write(prefix, 345, 155)
  header.write(type === '5' ? '0000775' : '0000664', 100)
  header.write(bytes.length.toString(8).padStart(11, '0'), 124)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar', 257)
  header.write('00', 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)])
}

/** A commit tarball in the GitHub codeload format, including Git's global PAX commit comment and explicit directories. */
export function gitArchiveFixture(commit: string, files: ReadonlyMap<string, string>): Buffer {
  const prefix = `plugin-market-${commit}`
  const directories = new Set([prefix])
  for (const path of files.keys()) {
    const parts = path.split('/')
    let parent = prefix
    for (const part of parts.slice(0, -1)) {
      parent += '/' + part
      directories.add(parent)
    }
  }
  const blocks = [tarEntry('pax_global_header', 'g', `52 comment=${commit}\n`)]
  for (const path of directories) blocks.push(tarEntry(path + '/', '5'))
  for (const [path, content] of files) blocks.push(tarEntry(`${prefix}/${path}`, '0', content))
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

const pkt = (line: string) => (4 + Buffer.byteLength(line)).toString(16).padStart(4, '0') + line

/** Read-only public Git advertisement, pinned archive and raw responses for one snapshot. */
export function officialGithubResponse(input: string, commit: string, files: ReadonlyMap<string, string>): Response {
  if (input === `https://github.com/${officialRepo}.git/info/refs?service=git-upload-pack`) {
    const refs = [
      pkt('# service=git-upload-pack\n'),
      '0000',
      pkt(`${commit} HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/main\n`),
      pkt(`${commit} refs/heads/main\n`),
      '0000',
    ].join('')
    return new Response(refs, { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
  }
  if (input === `https://codeload.github.com/${officialRepo}/tar.gz/${commit}`) {
    return new Response(Uint8Array.from(gitArchiveFixture(commit, files)), { headers: { 'content-type': 'application/x-gzip' } })
  }
  const raw = `https://raw.githubusercontent.com/${officialRepo}/${commit}/`
  const content = input.startsWith(raw) ? files.get(input.slice(raw.length)) : undefined
  return content === undefined ? new Response(null, { status: 404 }) : new Response(content)
}
