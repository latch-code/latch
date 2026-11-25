import { gunzipSync, gzipSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { gitArchiveFixture } from '@latch/testkit'
import { officialArchiveFiles } from '../src/plugin-official-archive.ts'

const commit = '31'.repeat(20)
const root = 'plugin-market-' + commit
const fixture = () => gitArchiveFixture(commit, new Map([['plugins/short.mjs', 'example']]))
const unused = {
  dataDir: '',
  fetch: vi.fn((): Promise<Response> => {
    throw new Error('No raw file should be read')
  }),
}

function checksum(header: Buffer) {
  header.fill(32, 148, 156)
  header.write(
    header
      .subarray(0, 512)
      .reduce((n, byte) => n + byte, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  )
}

it.each(['1', '2', '3', '4', '6', 'g'])('rejects non-regular archive members (%s) before reading any raw file', async type => {
  const tar = gunzipSync(fixture())
  const header = tar.subarray(tar.indexOf(root + '/plugins/short.mjs'))
  header.write(type, 156)
  checksum(header)
  await expect(officialArchiveFiles(commit, gzipSync(tar), unused)).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
})

it('requires the archive comment to identify the advertised commit and all files to have real parents', async () => {
  await expect(officialArchiveFiles('42'.repeat(20), fixture(), unused)).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
  const tar = gunzipSync(fixture())
  const header = tar.subarray(tar.indexOf(root + '/plugins/short.mjs'))
  header.write(root + '/missing/short.mjs')
  checksum(header)
  await expect(officialArchiveFiles(commit, gzipSync(tar), unused)).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
})

it('uses a length-checked PAX path for long Git filenames and applies ordinary path checks to it', async () => {
  const tar = gunzipSync(fixture())
  const offset = tar.indexOf(root + '/plugins/short.mjs')
  const withPath = (relative: string) => {
    const pax = Buffer.from(tar.subarray(0, 1024))
    const value = ' path=' + root + '/' + relative + '\n'
    const record = String(Buffer.byteLength(value) + 3) + value
    expect(Buffer.byteLength(record)).toBeGreaterThanOrEqual(100)
    pax.write('x', 156)
    pax.write(Buffer.byteLength(record).toString(8).padStart(11, '0') + '\0', 124)
    checksum(pax)
    pax.fill(0, 512)
    pax.write(record, 512)
    return gzipSync(Buffer.concat([tar.subarray(0, offset), pax, tar.subarray(offset)]))
  }
  const path = 'plugins/' + 'a'.repeat(80) + '.mjs'
  const fetch = vi.fn(async () => new Response('example'))
  const files = await officialArchiveFiles(commit, withPath(path), { dataDir: '', fetch })
  expect(await files.read('plugins/short.mjs', 100)).toBeUndefined()
  expect((await files.read(path, 100))?.toString()).toBe('example')
  expect(fetch.mock.calls).toHaveLength(1)
  await expect(officialArchiveFiles(commit, withPath('plugins/../' + path), unused)).rejects.toMatchObject({
    code: 'plugin-external-github-invalid',
  })
})

it('rejects a raw file larger than the requested limit before making a network request', async () => {
  const index = await officialArchiveFiles(commit, fixture(), unused)
  await expect(index.read('plugins/short.mjs', 6)).rejects.toMatchObject({ code: 'plugin-external-limit' })
  expect(unused.fetch).not.toHaveBeenCalled()
})
