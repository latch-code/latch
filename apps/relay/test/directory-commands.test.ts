import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { build } from 'esbuild'
import { nodeCrypto, RelayDirectoryCache } from '@latch/link-client'
import { decodeSignedRelayDirectory, unhex, verifyRelayDirectory } from '@latch/link-wire'
import { runDirectoryCommand } from '../src/directory-commands.ts'

const folders: string[] = [],
  execute = promisify(execFile)
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { force: true, recursive: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'latch-directory-signer-'))
  folders.push(directory)
  const root = join(directory, 'root'),
    online = join(directory, 'online')
  const offline = await runDirectoryCommand(['init', 'root', '--data-dir', root]),
    publisher = await runDirectoryCommand(['init', 'online', '--data-dir', online])
  const now = Date.now(),
    rootInput = join(root, 'manifest.json'),
    onlineInput = join(online, 'manifest.json')
  const authority = {
    generation: 1,
    issuedAt: now - 1000,
    expiresAt: now + 86_400_000,
    keys: [{ publicKey: String(publisher.publicKey), notBefore: now - 1000, notAfter: now + 86_400_000 }],
    revokedKeys: [] as string[],
    nodes: [{ relayId: '1'.repeat(32), region: 'self-hosted', spkiHashes: ['2'.repeat(64)], ports: [9443] }],
  }
  const addresses = {
    generation: 1,
    issuedAt: now - 1000,
    expiresAt: now + 3600_000,
    nodes: [{ relayId: '1'.repeat(32), host: 'relay.example', port: 9443, addresses: ['8.8.8.8'] }],
  }
  async function signRoot(version: string) {
    await writeFile(rootInput, JSON.stringify(authority), { mode: 0o600 })
    const output = join(root, `authority-${version}.json`)
    const result = await runDirectoryCommand(['sign-authority', '--data-dir', root, '--input', rootInput, '--output', output])
    return { output, result }
  }
  async function signOnline(proof: string, version: string) {
    await writeFile(onlineInput, JSON.stringify(addresses), { mode: 0o600 })
    const output = join(online, `addresses-${version}.bin`)
    const result = await runDirectoryCommand([
      'sign-addresses',
      '--data-dir',
      online,
      '--root-key',
      String(offline.publicKey),
      '--authority',
      proof,
      '--input',
      onlineInput,
      '--output',
      output,
    ])
    return { output, result }
  }
  return { directory, root, online, offline, publisher, authority, addresses, rootInput, onlineInput, signRoot, signOnline }
}

it('uses independent private roles, signs the live wire, persists scoped floors and propagates an offline Root-only revocation', async () => {
  const f = await fixture(),
    first = await f.signRoot('1'),
    firstOnline = await f.signOnline(first.output, '1')
  const anchor = unhex(String(f.offline.publicKey), 32),
    checked = await verifyRelayDirectory(nodeCrypto, decodeSignedRelayDirectory(await readFile(firstOnline.output)), [anchor], Date.now())
  expect(checked.checkpoint.generation).toBe(1)
  const identical = await f.signRoot('1')
  expect(identical.result).toEqual(first.result)
  expect((await stat(join(f.root, 'directory-key.json'))).mode & 0o777).toBe(0o600)
  expect((await stat(firstOnline.output)).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(f.offline)).not.toContain('PRIVATE KEY')
  f.addresses.generation = Number.MAX_SAFE_INTEGER
  await f.signOnline(first.output, 'max')
  f.authority.generation = 2
  const next = await f.signRoot('2')
  f.addresses.generation = 1
  const nextOnline = await f.signOnline(next.output, 'root2')
  expect(nextOnline.result).toMatchObject({ rootGeneration: 2, generation: 1 })
  await expect(f.signOnline(first.output, 'rollback')).rejects.toThrow('rollback')
  f.addresses.nodes[0]!.addresses = ['1.1.1.1']
  await expect(f.signOnline(next.output, 'conflict')).rejects.toThrow('conflict')
  f.authority.generation = 3
  f.authority.revokedKeys = [String(f.publisher.publicKey)]
  const revoked = await f.signRoot('3')
  await expect(f.signOnline(revoked.output, 'revoked')).rejects.toThrow()
  const published = join(f.root, 'root-revocation.bin')
  await runDirectoryCommand([
    'publish-authority',
    '--data-dir',
    f.root,
    '--authority',
    revoked.output,
    '--previous',
    nextOnline.output,
    '--output',
    published,
  ])
  let saved: string | undefined
  const cache = await RelayDirectoryCache.open(
    { anchors: [anchor], mirrors: ['https://directory.example/relays.bin'] },
    {
      read: async () => saved,
      write: async value => {
        saved = value
      },
    },
  )
  await cache.adopt(await readFile(nextOnline.output))
  await expect(cache.adopt(await readFile(published))).rejects.toThrow()
  expect(cache.sources().minimum?.generation).toBe(3)
  expect(cache.status().ready).toBe(false)
  expect(cache.sources().minimumOnline).toBeUndefined()
})

it('refuses private-file replacement through aliases, existing output, wrong roles, permission widening and ambiguous publication', async () => {
  const f = await fixture(),
    first = await f.signRoot('1'),
    before = await readFile(join(f.root, 'directory-key.json'))
  await expect(
    runDirectoryCommand(['sign-authority', '--data-dir', f.root, '--input', f.rootInput, '--output', `${f.root}/./directory-key.json`]),
  ).rejects.toThrow()
  await expect(
    runDirectoryCommand(['sign-authority', '--data-dir', f.root, '--input', f.rootInput, '--output', join(f.online, 'directory-key.json')]),
  ).rejects.toThrow('new versioned')
  expect(await readFile(join(f.root, 'directory-key.json'))).toEqual(before)
  await expect(
    runDirectoryCommand(['sign-authority', '--data-dir', f.online, '--input', f.rootInput, '--output', join(f.online, 'wrong.json')]),
  ).rejects.toThrow('Root role')
  f.authority.nodes[0]!.ports = [8443]
  await expect(f.signRoot('conflict')).rejects.toThrow('conflict')
  const statePath = join(f.root, 'directory-state.json'),
    state = await readFile(statePath)
  await rm(statePath)
  await expect(f.signRoot('missing-state')).rejects.toThrow('state unavailable')
  await writeFile(statePath, state, { mode: 0o600 })
  await writeFile(join(f.root, 'directory.lock'), '', { mode: 0o600 })
  await expect(runDirectoryCommand(['public-key', '--data-dir', f.root])).rejects.toMatchObject({ code: 'EEXIST' })
  await rm(join(f.root, 'directory.lock'))
  await chmod(join(f.root, 'directory-key.json'), 0o644)
  await expect(runDirectoryCommand(['public-key', '--data-dir', f.root])).rejects.toThrow('private')
  expect(await readFile(first.output)).toHaveLength((await stat(first.output)).size)
})

it('runs the real CLI with private-runtime checks and never prints key material on success or invalid input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-directory-cli-'))
  folders.push(directory)
  const source = fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    cli = join(directory, 'latch-relay.mjs')
  await build({ entryPoints: [source], outfile: cli, bundle: true, platform: 'node', target: 'node24', format: 'esm' })
  const prefix = ['--disable-sigusr1', cli]
  const created = await execute(process.execPath, [...prefix, 'directory', 'init', 'root', '--data-dir', directory])
  expect(JSON.parse(created.stdout)).toMatchObject({ initialized: true, role: 'root', publicKey: expect.stringMatching(/^[a-f0-9]{64}$/u) })
  expect(created.stdout + created.stderr).not.toContain('PRIVATE KEY')
  await expect(
    execute(process.execPath, ['--import', 'tsx', cli, 'directory', 'public-key', '--data-dir', directory]),
  ).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.not.stringContaining('PRIVATE KEY') })
  const queried = await execute(process.execPath, [...prefix, 'directory', 'public-key', '--data-dir', directory])
  expect(JSON.parse(queried.stdout).publicKey).toBe(JSON.parse(created.stdout).publicKey)
  const stripped = await execute(process.execPath, ['--disable-sigusr1', source, 'directory', 'public-key', '--data-dir', directory])
  expect(JSON.parse(stripped.stdout).publicKey).toBe(JSON.parse(created.stdout).publicKey)
  const now = Date.now(),
    input = join(directory, 'authority-input.json'),
    output = join(directory, 'authority-output.json')
  await writeFile(
    input,
    JSON.stringify({
      generation: 1,
      issuedAt: now - 1000,
      expiresAt: now + 86_400_000,
      keys: [
        {
          publicKey: Buffer.from(await nodeCrypto.publicKey(Buffer.alloc(32, 4))).toString('hex'),
          notBefore: now - 1000,
          notAfter: now + 86_400_000,
        },
      ],
      revokedKeys: [],
      nodes: [],
    }),
    { mode: 0o600 },
  )
  const signed = await execute(process.execPath, [
    ...prefix,
    'directory',
    'sign-authority',
    '--data-dir',
    directory,
    '--input',
    input,
    '--output',
    output,
  ])
  expect(JSON.parse(signed.stdout)).toMatchObject({ signed: true, generation: 1, role: 'root' })
  expect(signed.stdout + signed.stderr).not.toContain('PRIVATE KEY')
  await writeFile(join(directory, 'directory-key.json'), '{"privateKey":"PRIVATE KEY invalid fixture"', { mode: 0o600 })
  await expect(execute(process.execPath, [...prefix, 'directory', 'public-key', '--data-dir', directory])).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: expect.not.stringContaining('PRIVATE KEY'),
  })
})
