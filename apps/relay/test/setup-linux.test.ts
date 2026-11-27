import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LinuxSetupError, runLinuxRemoteStatus, runLinuxSetup, runLinuxUninstall } from '../scripts/setup-linux-core.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

const SAMPLE_PROFILE = {
  version: 2,
  profile: {
    relayId: 'a'.repeat(32),
    url: 'https://relay.example.com/',
    kind: 'edge' as const,
    relayKey: 'b'.repeat(64),
    registrationKey: `lrt1.${'C'.repeat(43)}`,
  },
}
const EXPECTED_KEY_HASH = createHash('sha256')
  .update(Buffer.from('b'.repeat(64), 'hex'))
  .digest('hex')
  .slice(0, 8)

describe('latch relay setup linux core workflow', () => {
  it('deploys an ACME-managed Linux relay over SSH, writes a 0600 profile without leaking the token and runs acceptance', async () => {
    const home = await mkdtemp(join(tmpdir(), 'latch-linux-setup-'))
    cleanup.push(home)
    const sshCalls: Array<{ server: string; script: string; stdinBytes: number }> = []
    const printed: string[] = []
    const fakeBundle = Buffer.from('fake-linux-bundle-bytes')
    const bundleSha = createHash('sha256').update(fakeBundle).digest('hex')

    const result = await runLinuxSetup(
      {
        server: 'root@203.0.113.10',
        domain: 'relay.example.com',
        home,
      },
      {
        async ssh(target, script, stdin) {
          sshCalls.push({ server: target.server, script, stdinBytes: stdin?.length ?? 0 })
          if (sshCalls.length === 1) {
            return { code: 0, stdout: '{"os":"Linux","arch":"x86_64","uid":0,"sudo":1,"systemd":1}\n', stderr: '' }
          }
          return {
            code: 0,
            stdout: `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(SAMPLE_PROFILE)}\n---LATCH-RELAY-PROFILE-END---\n`,
            stderr: '',
          }
        },
        async buildBundle(arch) {
          expect(arch).toBe('amd64')
          return { tarball: fakeBundle, sha256: bundleSha }
        },
        async readBundle() {
          throw new Error('unexpected')
        },
        async accept(profile) {
          expect(profile.url).toBe('https://relay.example.com/')
          return [
            { name: 'healthz', result: 'pass', detail: 'HTTP 200' },
            { name: 'wrong-credentials', result: 'pass', detail: '已拒' },
            { name: 'register-and-splice', result: 'pass', detail: '正常' },
          ]
        },
        progress: line => printed.push(line),
      },
    )

    expect(result.keyHash).toBe(EXPECTED_KEY_HASH)
    expect(result.mode).toBe('acme')
    expect(sshCalls).toHaveLength(2)
    expect(sshCalls[1]!.stdinBytes).toBe(fakeBundle.length)
    expect(sshCalls[1]!.script).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
    expect(sshCalls[1]!.script).toContain('--domain relay.example.com --port 443')

    const outPath = join(home, '.latch', 'relays', 'relay-example-com.json')
    expect((await stat(outPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(SAMPLE_PROFILE)
    // Registration token never appears in printed output.
    expect(printed.join('\n')).not.toContain(SAMPLE_PROFILE.profile.registrationKey)
    expect(printed.join('\n')).toContain(EXPECTED_KEY_HASH)
  })

  it('supports aarch64 behind-proxy mode and refuses unsafe SSH targets or existing output files before dialing SSH', async () => {
    const home = await mkdtemp(join(tmpdir(), 'latch-linux-proxy-'))
    cleanup.push(home)
    let dialed = 0
    const badInputs = [
      { server: '-oProxyCommand=id', domain: 'relay.example.com' },
      { server: 'me@host;id', domain: 'relay.example.com' },
      { server: 'me@host', domain: 'Relay_Bad.example.com' },
      { server: 'me@host', domain: 'relay.example.com', behindProxy: true, cert: '/etc/a.pem', key: '/etc/b.pem' },
      { server: 'me@host', domain: 'relay.example.com', cert: '/etc/$(id).pem', key: '/etc/b.pem' },
    ]
    for (const bad of badInputs) {
      await expect(
        runLinuxSetup(
          { ...bad, home },
          {
            ssh: async () => {
              dialed++
              return { code: 0, stdout: '', stderr: '' }
            },
            buildBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
            readBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
            accept: async () => [],
            progress: () => {},
          },
        ),
      ).rejects.toThrow(LinuxSetupError)
    }
    expect(dialed).toBe(0)

    const fakeBundle = Buffer.from('arm64-bundle')
    const res = await runLinuxSetup(
      {
        server: 'ubuntu@relay.example.com',
        domain: 'relay.example.com',
        name: 'office',
        behindProxy: true,
        skipAccept: true,
        home,
      },
      {
        async ssh(_target, script) {
          dialed++
          if (dialed === 1) return { code: 0, stdout: '{"os":"Linux","arch":"aarch64","uid":1000,"sudo":1,"systemd":1}\n', stderr: '' }
          expect(script).toContain('--behind-proxy --port 18443 --public-port 443')
          expect(script).toContain('CapabilityBoundingSet=\n')
          return {
            code: 0,
            stdout: `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(SAMPLE_PROFILE)}\n---LATCH-RELAY-PROFILE-END---\n`,
            stderr: '',
          }
        },
        async buildBundle(arch) {
          expect(arch).toBe('arm64')
          return { tarball: fakeBundle, sha256: createHash('sha256').update(fakeBundle).digest('hex') }
        },
        readBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
        accept: async () => [],
        progress: () => {},
      },
    )
    expect(res.mode).toBe('behind-proxy')
    expect(res.proxySnippets?.caddy).toContain('reverse_proxy 127.0.0.1:18443')
    expect(res.proxySnippets?.nginx).toContain('proxy_pass http://127.0.0.1:18443;')

    // Second run with the same name refuses before touching SSH so existing credentials are never silently clobbered.
    const callsBefore = dialed
    await expect(
      runLinuxSetup(
        { server: 'ubuntu@relay.example.com', domain: 'relay.example.com', name: 'office', behindProxy: true, home },
        {
          ssh: async () => {
            dialed++
            return { code: 0, stdout: '', stderr: '' }
          },
          buildBundle: async () => ({ tarball: fakeBundle, sha256: '' }),
          readBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
          accept: async () => [],
          progress: () => {},
        },
      ),
    ).rejects.toThrow(/已存在/)
    expect(dialed).toBe(callsBefore)
  })

  it('deploys without a domain using bare-IP mode, supports --upgrade without clobbering, and runs status/uninstall', async () => {
    const home = await mkdtemp(join(tmpdir(), 'latch-linux-bareip-'))
    cleanup.push(home)
    const bareProfile = {
      version: 1 as const,
      profile: {
        relayId: '1'.repeat(32),
        url: 'https://203.0.113.10/',
        spkiHash: '2'.repeat(64),
        registrationKey: `lrt1.${'D'.repeat(43)}`,
      },
    }
    const fakeBundle = Buffer.from('bare-ip-bundle')
    const bundleSha = createHash('sha256').update(fakeBundle).digest('hex')
    const scripts: string[] = []

    const first = await runLinuxSetup(
      { server: 'my-vps-alias', home },
      {
        resolveServerIp: async () => '203.0.113.10',
        async ssh(_target, script) {
          scripts.push(script)
          if (scripts.length === 1)
            return { code: 0, stdout: '{"os":"Linux","arch":"x86_64","uid":0,"sudo":1,"systemd":1,"port443Busy":0}\n', stderr: '' }
          return {
            code: 0,
            stdout: `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(bareProfile)}\n---LATCH-RELAY-PROFILE-END---\n`,
            stderr: '',
          }
        },
        buildBundle: async () => ({ tarball: fakeBundle, sha256: bundleSha }),
        readBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
        accept: async profile => {
          expect(profile.url).toBe('https://203.0.113.10/')
          return [{ name: 'healthz', result: 'pass', detail: 'HTTP 200' }]
        },
        progress: () => {},
      },
    )
    expect(first.mode).toBe('self-ip')
    expect(first.keyHash).toBe('22222222')
    expect(scripts[1]).toContain('--ip 203.0.113.10 --port 443')
    expect(scripts[1]).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
    const outPath = join(home, '.latch', 'relays', 'ip-203-0-113-10.json')
    expect((await stat(outPath)).mode & 0o777).toBe(0o600)

    // When `:443` is already occupied on another server, bare-IP mode automatically falls back to `:8443`!
    const fallbackProfile = { ...bareProfile, profile: { ...bareProfile.profile, url: 'https://198.51.100.9:8443/' } }
    await runLinuxSetup(
      { server: 'root@198.51.100.9', home },
      {
        async ssh(_target, script) {
          scripts.push(script)
          if (scripts.length === 3)
            return { code: 0, stdout: '{"os":"Linux","arch":"x86_64","uid":0,"sudo":1,"systemd":1,"port443Busy":1}\n', stderr: '' }
          return {
            code: 0,
            stdout: `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(fallbackProfile)}\n---LATCH-RELAY-PROFILE-END---\n`,
            stderr: '',
          }
        },
        buildBundle: async () => ({ tarball: fakeBundle, sha256: bundleSha }),
        readBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
        accept: async () => [{ name: 'healthz', result: 'pass', detail: 'HTTP 200' }],
        progress: () => {},
      },
    )
    expect(scripts[3]).toContain('--ip 198.51.100.9 --port 8443')

    // Re-running with `--upgrade` succeeds without overwriting the existing local relay file!
    const upgraded = await runLinuxSetup(
      { server: 'root@203.0.113.10', upgrade: true, home },
      {
        async ssh(_target, script) {
          scripts.push(script)
          if (scripts.length === 5)
            return { code: 0, stdout: '{"os":"Linux","arch":"x86_64","uid":0,"sudo":1,"systemd":1,"port443Busy":0}\n', stderr: '' }
          return {
            code: 0,
            stdout: `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(bareProfile)}\n---LATCH-RELAY-PROFILE-END---\n`,
            stderr: '',
          }
        },
        buildBundle: async () => ({ tarball: fakeBundle, sha256: bundleSha }),
        readBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
        accept: async () => [{ name: 'healthz', result: 'pass', detail: 'HTTP 200' }],
        progress: () => {},
      },
    )
    expect(upgraded.out).toBe(outPath)

    // Remote status & uninstall:
    const statusLines = await runLinuxRemoteStatus({ server: 'root@203.0.113.10' }, async () => ({
      code: 0,
      stdout:
        'SVC=active\n{"ready":true,"routes":2,"connections":4,"certificate":{"daysRemaining":364,"renewalWarning":false},"quota":{"monthlyUsed":1073741824,"monthlyBytes":536870912000,"admission":true}}\n',
      stderr: '',
    }))
    expect(statusLines.join('\n')).toContain('active（就绪）')
    expect(statusLines.join('\n')).toContain('364 天')
    expect(statusLines.join('\n')).toContain('1.00 GiB / 500.00 GiB')

    let uninstallScript = ''
    const msg = await runLinuxUninstall({ server: 'root@203.0.113.10', purgeData: true }, async (_target, script) => {
      uninstallScript = script
      return { code: 0, stdout: '', stderr: '' }
    })
    expect(uninstallScript).toContain('rm -rf /srv/latch-relay')
    expect(msg).toContain('清除 /srv/latch-relay')
  })
})
