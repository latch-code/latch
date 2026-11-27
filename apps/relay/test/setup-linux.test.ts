import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createTransportCertificate } from '@latch/link-client'
import { readRelayTls } from '../src/config.ts'
import { runLinuxAcceptance } from '../scripts/accept-linux.ts'
import {
  buildSshRemoteCommand,
  LinuxSetupError,
  runLinuxRemoteStatus,
  runLinuxSetup,
  runLinuxUninstall,
} from '../scripts/setup-linux-core.ts'

const execFileAsync = promisify(execFile)

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
            return {
              code: 0,
              stdout:
                '{"os":"Linux","arch":"x86_64","uid":0,"sudo":1,"systemd":1,"port443Busy":1,"existingPort":443,"existingMode":"self-ip"}\n',
              stderr: '',
            }
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

    // A rebuilt machine may have the same endpoint but a different registration token.
    await expect(
      runLinuxSetup(
        { server: 'root@203.0.113.10', upgrade: true, home },
        {
          async ssh(_target, _script, bundle) {
            const profile = { ...bareProfile, profile: { ...bareProfile.profile, registrationKey: `lrt1.${'E'.repeat(43)}` } }
            return {
              code: 0,
              stderr: '',
              stdout: bundle
                ? `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(profile)}\n---LATCH-RELAY-PROFILE-END---\n`
                : JSON.stringify({
                    os: 'Linux',
                    arch: 'x86_64',
                    uid: 1000,
                    sudo: 1,
                    systemd: 1,
                    existingPort: 443,
                    existingMode: 'self-ip',
                  }),
            }
          },
          buildBundle: async () => ({ tarball: fakeBundle, sha256: bundleSha }),
          readBundle: async () => {
            throw new Error('unexpected')
          },
          accept: async () => {
            throw new Error('must not accept a different profile')
          },
          progress: () => {},
        },
      ),
    ).rejects.toThrow('注册令牌')
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(bareProfile)

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
    expect(uninstallScript).toContain('rm -rf /srv/latch-relay /etc/latch-relay')
    expect(msg).toContain('清除 /srv/latch-relay')
  })

  it('reuses the saved public domain and external port for an upgrade through the SSH IP', async () => {
    const home = await mkdtemp(join(tmpdir(), 'latch-linux-upgrade-proxy-'))
    cleanup.push(home)
    const relaysDir = join(home, '.latch', 'relays')
    await mkdir(relaysDir, { recursive: true, mode: 0o700 })
    await chmod(join(home, '.latch'), 0o700)
    const out = join(relaysDir, 'office.json')
    const saved = { ...SAMPLE_PROFILE, profile: { ...SAMPLE_PROFILE.profile, url: 'https://relay.example.com:7443/' } }
    await writeFile(out, JSON.stringify(saved), { mode: 0o600 })
    const result = await runLinuxSetup(
      { server: 'root@203.0.113.10', home, upgrade: true, skipAccept: true },
      {
        async ssh(_target, script, bundle) {
          if (bundle) {
            expect(script).toContain('--url https://relay.example.com:7443')
            return {
              code: 0,
              stderr: '',
              stdout: `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(saved)}\n---LATCH-RELAY-PROFILE-END---\n`,
            }
          }
          return {
            code: 0,
            stderr: '',
            stdout: JSON.stringify({
              os: 'Linux',
              arch: 'x86_64',
              uid: 0,
              systemd: 1,
              existingId: saved.profile.relayId,
              existingMode: 'behind-proxy',
              existingPort: 18443,
            }),
          }
        },
        buildBundle: async () => ({ tarball: Buffer.from('bundle'), sha256: 'a'.repeat(64) }),
        readBundle: async () => {
          throw new Error('unexpected')
        },
        accept: async () => [],
        progress: () => {},
      },
    )
    expect(result.out).toBe(out)
    expect(result.mode).toBe('behind-proxy')
  })

  it('installs custom TLS into root-owned /etc/latch-relay/tls (never inside /srv/latch-relay) and enforces TLS file permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'latch-linux-custom-tls-'))
    cleanup.push(home)
    const fakeBundle = Buffer.from('custom-tls-bundle')
    const bundleSha = createHash('sha256').update(fakeBundle).digest('hex')
    let installScript = ''

    await runLinuxSetup(
      {
        server: 'root@203.0.113.10',
        domain: 'relay.example.com',
        cert: '/etc/ssl/private/fullchain.pem',
        key: '/etc/ssl/private/privkey.pem',
        skipAccept: true,
        home,
      },
      {
        async ssh(_target, script) {
          if (!installScript && script.includes('BUNDLE_SHA_MISMATCH')) installScript = script
          if (!script.includes('BUNDLE_SHA_MISMATCH')) {
            return { code: 0, stdout: '{"os":"Linux","arch":"x86_64","uid":0,"sudo":1,"systemd":1,"port443Busy":0}\n', stderr: '' }
          }
          return {
            code: 0,
            stdout: `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(SAMPLE_PROFILE)}\n---LATCH-RELAY-PROFILE-END---\n`,
            stderr: '',
          }
        },
        buildBundle: async () => ({ tarball: fakeBundle, sha256: bundleSha }),
        readBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
        accept: async () => [],
        progress: () => {},
      },
    )

    expect(installScript).toContain('run_root install -d -m 0755 -o root -g root /etc/latch-relay')
    expect(installScript).toContain('run_root install -d -m 0750 -o root -g latch-relay /etc/latch-relay/tls')
    expect(installScript).toContain('run_root install -m 0640 -o root -g latch-relay /etc/ssl/private/fullchain.pem')
    expect(installScript).toContain('run_root install -m 0640 -o root -g latch-relay /etc/ssl/private/privkey.pem')
    expect(installScript).toContain('--cert /etc/latch-relay/tls/fullchain.pem --key /etc/latch-relay/tls/privkey.pem')
    expect(installScript).not.toContain('/srv/latch-relay/tls')
    expect(installScript).not.toContain('run_root cat "$prof_tmp"')
    expect(installScript).not.toContain('run_root rm -f "$prof_tmp"')

    // Verify `readRelayTls` accepts 0600 self-owned PEMs and rejects group-writable, world-readable or symlinked PEMs.
    const tlsDir = join(home, 'tls')
    await mkdir(tlsDir, { mode: 0o700 })
    const pair = createTransportCertificate(Date.now(), 3_600_000, 'relay.example.com')
    const certPath = join(tlsDir, 'cert.pem')
    const keyPath = join(tlsDir, 'key.pem')
    await writeFile(certPath, pair.cert, { mode: 0o600 })
    await writeFile(keyPath, pair.key, { mode: 0o600 })
    expect((await readRelayTls(certPath, keyPath)).cert.length).toBeGreaterThan(0)

    await chmod(keyPath, 0o644)
    await expect(readRelayTls(certPath, keyPath)).rejects.toThrow(/TLS file permissions/)
    await chmod(keyPath, 0o600)

    const linkKey = join(tlsDir, 'link-key.pem')
    await symlink(keyPath, linkKey)
    await expect(readRelayTls(certPath, linkKey)).rejects.toThrow(/TLS file permissions/)
  })

  it('preserves port 443 and CAP_NET_BIND_SERVICE on --upgrade when the relay already holds 443, and rolls back on health failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'latch-linux-upgrade-443-'))
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
    const relaysDir = join(home, '.latch', 'relays')
    await mkdir(relaysDir, { recursive: true, mode: 0o700 })
    await chmod(join(home, '.latch'), 0o700)
    await writeFile(join(relaysDir, 'ip-203-0-113-10.json'), `${JSON.stringify(bareProfile)}\n`, { mode: 0o600 })

    const fakeBundle = Buffer.from('upgrade-bundle-v2')
    const bundleSha = createHash('sha256').update(fakeBundle).digest('hex')
    let upgradeScript = ''

    const res = await runLinuxSetup(
      { server: 'root@203.0.113.10', upgrade: true, skipAccept: true, home },
      {
        async ssh(_target, script) {
          if (!script.includes('BUNDLE_SHA_MISMATCH')) {
            // Running relay already occupies `:443` (`port443Busy: 1`) and `relay.json` has `existingPort: 443`!
            return {
              code: 0,
              stdout:
                '{"os":"Linux","arch":"x86_64","uid":0,"sudo":1,"systemd":1,"port443Busy":1,"existingPort":443,"existingMode":"self-ip"}\n',
              stderr: '',
            }
          }
          upgradeScript = script
          return {
            code: 0,
            stdout: `---LATCH-RELAY-PROFILE-BEGIN---\n${JSON.stringify(bareProfile)}\n---LATCH-RELAY-PROFILE-END---\n`,
            stderr: '',
          }
        },
        buildBundle: async () => ({ tarball: fakeBundle, sha256: bundleSha }),
        readBundle: async () => ({ tarball: Buffer.alloc(0), sha256: '' }),
        accept: async () => [],
        progress: () => {},
      },
    )

    expect(res.profile.url).toBe('https://203.0.113.10/')
    expect(upgradeScript).toContain('if run_relay test -f /srv/latch-relay/relay.json; then')
    expect(upgradeScript).toContain('--url https://203.0.113.10')
    expect(upgradeScript).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
    // Candidate `check` runs on `$release_dir` BEFORE switching `/opt/latch-relay/current`:
    const candidateCheckIdx = upgradeScript.indexOf('run_relay "$release_dir/node" --disable-sigusr1 "$release_dir/latch-relay.mjs" check')
    const switchCurrentIdx = upgradeScript.indexOf('run_root ln -sfn "$release_dir" /opt/latch-relay/current')
    expect(candidateCheckIdx).toBeGreaterThan(0)
    expect(switchCurrentIdx).toBeGreaterThan(candidateCheckIdx)
    expect(upgradeScript).toContain('rollback_release')

    // Execute the rollback function in a real `/bin/sh` sandbox to prove a failed restart/health restores `current` and unit!
    const rootSim = join(home, 'sim')
    const oldRel = join(rootSim, 'opt/releases/old')
    const newRel = join(rootSim, 'opt/releases/new')
    const currentLink = join(rootSim, 'opt/current')
    const unitFile = join(rootSim, 'latch-relay.service')
    const logFile = join(rootSim, 'systemctl.log')
    await mkdir(oldRel, { recursive: true })
    await mkdir(newRel, { recursive: true })
    await symlink(oldRel, currentLink)
    await writeFile(unitFile, 'OLD_UNIT\n')

    const simScript = [
      'set -eu',
      `prev_target=$(readlink "${currentLink}")`,
      `unit_backup="${join(rootSim, 'unit.bak')}"`,
      `cp -p "${unitFile}" "$unit_backup"`,
      'was_active=1',
      'rollback_release() {',
      `  ln -sfn "$prev_target" "${currentLink}"`,
      `  cp -p "$unit_backup" "${unitFile}"`,
      `  printf 'restarted:%s\\n' "$(readlink "${currentLink}")" >> "${logFile}"`,
      '}',
      `ln -sfn "${newRel}" "${currentLink}"`,
      `printf 'NEW_UNIT\\n' > "${unitFile}"`,
      'ready=0',
      'if [ "$ready" -ne 1 ]; then rollback_release; exit 14; fi',
    ].join('\n')

    const rollbackRun = await execFileAsync('/bin/sh', ['-c', buildSshRemoteCommand(simScript)]).then(
      () => ({ code: 0 }),
      (err: { code?: number }) => ({ code: err.code ?? 1 }),
    )
    expect(rollbackRun.code).toBe(14)
    expect(await readFile(unitFile, 'utf8')).toBe('OLD_UNIT\n')
    expect(await readFile(logFile, 'utf8')).toBe(`restarted:${oldRel}\n`)
  })

  it('quotes the entire SSH script as one sh -c argument so intermediate failures abort immediately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-ssh-quote-'))
    cleanup.push(dir)
    const marker = join(dir, 'after-failure')
    const multilineScript = ['set -eu', "label='it'\\''s quoted'", 'false', `touch "${marker}"`, 'true'].join('\n')
    const remoteCmd = buildSshRemoteCommand(multilineScript)

    // Simulate OpenSSH passing the single remote command string to the remote login shell (`/bin/sh -c <remoteCmd>`):
    const outcome = await execFileAsync('/bin/sh', ['-c', remoteCmd]).then(
      () => ({ code: 0 }),
      (err: { code?: number }) => ({ code: err.code ?? 1 }),
    )
    expect(outcome.code).not.toBe(0)
    await expect(stat(marker)).rejects.toThrow()
  })

  it('requires the relay health response and explicit credential rejection during acceptance', async () => {
    const certPair = createTransportCertificate(Date.now(), 3_600_000, 'relay.example.com')
    let healthBody = '<!doctype html><html><body>default vhost</body></html>'
    const wrongServer = createHttpsServer(
      { cert: certPair.cert, key: certPair.key, minVersion: 'TLSv1.3', ALPNProtocols: ['http/1.1'] },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(healthBody)
      },
    )
    wrongServer.listen(0, '127.0.0.1')
    await once(wrongServer, 'listening')
    try {
      const port = (wrongServer.address() as AddressInfo).port
      const items = await runLinuxAcceptance(
        {
          relayId: 'a'.repeat(32),
          url: `https://relay.example.com:${port}/`,
          kind: 'edge',
          relayKey: 'b'.repeat(64),
        },
        { ca: certPair.cert, address: '127.0.0.1' },
      )
      expect(items).toEqual([{ name: 'healthz', result: 'fail', detail: 'HTTP 200（响应正文不是中继健康检查）' }])
      healthBody = 'ok\n'
      const transportFailure = await runLinuxAcceptance(
        {
          relayId: 'a'.repeat(32),
          url: `https://relay.example.com:${port}/`,
          kind: 'edge',
          relayKey: 'b'.repeat(64),
          registrationKey: SAMPLE_PROFILE.profile.registrationKey,
        },
        { ca: certPair.cert, address: '127.0.0.1' },
      )
      expect(transportFailure.find(item => item.name === 'wrong-credentials')?.result).toBe('fail')
    } finally {
      wrongServer.closeAllConnections()
      await new Promise<void>(r => wrongServer.close(() => r()))
    }
  })
})
