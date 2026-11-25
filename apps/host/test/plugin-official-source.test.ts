import { expect, it, vi } from 'vitest'
import type { FetchLike } from '../src/egress.ts'
import { getOfficialArchive, readOfficialRaw, resolveOfficialMain } from '../src/plugin-official-source.ts'

const main = 'a'.repeat(40)
const tag = 'b'.repeat(40)
const packet = (data: string) => (Buffer.byteLength(data) + 4).toString(16).padStart(4, '0') + data
const prefix = packet('# service=git-upload-pack\n') + '0000'
const mainRef = packet(`${main} refs/heads/main\n`)
const found = (body: string) => resolveOfficialMain({ dataDir: '', fetch: () => Promise.resolve(new Response(body)) })

it('takes main from its own Git ref even if HEAD and a tag named main point elsewhere', async () => {
  const head = packet(`${tag} HEAD\0symref=HEAD:refs/heads/another object-format=sha1\n`)
  const refs = prefix + head + packet(`${tag} refs/tags/main\n`) + mainRef + '0000'
  await expect(found(refs)).resolves.toBe(main)
})

it.each([
  ['missing branch', prefix + packet(`${tag} HEAD\n`) + '0000'],
  ['duplicate branch', prefix + mainRef + mainRef + '0000'],
  ['empty object ID', prefix + packet(`${'0'.repeat(40)} refs/heads/main\n`) + '0000'],
  ['missing final flush', prefix + mainRef],
  ['malformed length', prefix + '0080' + main],
  ['bytes following the flush', prefix + mainRef + '0000' + mainRef],
  ['HTML response', '<html></html>'],
])('refuses %s in the Git advertisement', async (_description, bytes) => {
  await expect(found(bytes)).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
})

it('checks the commit and relative file path before a pinned request', async () => {
  const fetch = vi.fn<FetchLike>()
  const options = { dataDir: '', fetch }
  await expect(getOfficialArchive('refs/heads/main', options)).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
  await expect(readOfficialRaw(main, '../README.md', 256, options)).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
  expect(fetch).not.toHaveBeenCalled()
})
