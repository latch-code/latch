import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { startRelay } from '@latch/relay'
import { createTransportCertificate } from '@latch/link-client'
import { startTestHost } from './helpers/host.ts'

const exec = promisify(execFile)
let binary = ''
describe.skipIf(process.platform !== 'darwin')('Swift native relay interoperability', () => {
  beforeAll(async () => {
    const args = ['build', '--package-path', 'native/ios', '--disable-automatic-resolution']
    await exec('swift', [...args, '--product', 'LatchNativeFixture', '--jobs', '4'], { timeout: 120_000, maxBuffer: 2_097_152 })
    binary = join((await exec('swift', [...args, '--show-bin-path'])).stdout.trim(), 'LatchNativeFixture')
  })
  it.each([
    ['nativeRelayProbe', { status: 401 }],
    [
      'nativeRelayLifecycle',
      {
        paired: true,
        persistedBeforeComplete: true,
        mutualTLS: true,
        requiresWindow: true,
        verified: true,
        reviewDeniedBeforeDesktopGrant: true,
        created: true,
        files: true,
        largeFile: true,
        events: true,
        resumedWithoutSigning: true,
        replayedAfterReconnect: true,
        rootRevocationClosedLease: true,
      },
    ],
  ])('runs %s through a pinned outer TLS relay and authenticated inner TLS socket', async (operation, expected) => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-swift-relay-')),
      tls = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
    const relayId = randomBytes(16),
      token = randomBytes(32)
    const relay = await startRelay({
      host: '127.0.0.1',
      port: 0,
      cert: tls.cert,
      key: tls.key,
      relayId,
      registrationToken: token,
      maxConnections: 32,
      gateway: {
        binary: resolve('dist/relay/latch-relay-tls'),
        maxHandshakes: 8,
        handshakesPerSecond: 100,
        handshakeBurst: 8,
        prefixFraction: 1,
      },
      registrationWork: { softRoutesPerPrefix: 1, minBits: 0, maxBits: 0, maxConcurrent: 2 },
    })
    let host: Awaited<ReturnType<typeof startTestHost>> | undefined
    try {
      const dataDir = join(directory, 'data'),
        nativeDir = join(dataDir, 'native')
      await mkdir(nativeDir, { recursive: true, mode: 0o700 })
      await writeFile(
        join(nativeDir, 'relays.json'),
        JSON.stringify({
          version: 1,
          generation: 0,
          discoveryKey: `lnd1.${randomBytes(32).toString('base64url')}`,
          profiles: [
            {
              relayId: relayId.toString('hex'),
              url: `https://localhost:${relay.port}/`,
              spkiHash: createHash('sha256').update(tls.spki).digest('hex'),
              registrationKey: `lrt1.${token.toString('base64url')}`,
              seeds: [`lrs1.${randomBytes(32).toString('base64url')}`, `lrs1.${randomBytes(32).toString('base64url')}`],
              activeSlot: 0,
              rotationDay: 0,
              rotations: 0,
            },
          ],
        }),
        { mode: 0o600 },
      )
      host = await startTestHost({
        dataDir,
        workspaceRoot: join(directory, 'workspace'),
        nativeRelayCa: tls.cert,
        egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
      })
      const desktop = await host.enroll({ listener: 'unix' })
      expect(
        (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`localhost:${relay.port}`] } } })).status,
      ).toBe(200)
      await vi.waitFor(() => expect(relay.status().routes).toBe(3), { timeout: 3000 })
      expect(relay.status().registrationWork?.accepted).toBe(2)
      expect(relay.status().gateway?.healthy).toBe(true)
      const invited = await desktop.request('native/pairings', { method: 'POST', body: {} })
      expect(invited.status).toBe(201)
      const { invitation } = (await invited.json()) as { invitation: { payload: string } }
      const requestId = randomUUID()
      await writeFile(join(host.workspaceRoot, 'notes.txt'), 'Swift relay file fixture')
      await writeFile(join(host.workspaceRoot, 'large.txt'), Buffer.alloc(1_048_576, 120))
      const input = {
        operation,
        requestId,
        payload: invitation.payload,
        trustAnchor: new X509Certificate(tls.cert).raw.toString('hex'),
      }
      const fixtureHost = host
      const response = await new Promise<unknown>((resolve, reject) => {
        const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} })
        let grant: Promise<void> | undefined
        let output = '',
          diagnostic = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('Swift relay fixture timeout'))
        }, 20_000)
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString()
          if (output.length > 1_048_576) child.kill('SIGKILL')
        })
        child.stderr.on('data', (data: Buffer) => {
          diagnostic = (diagnostic + data.toString()).slice(0, 4096)
          if (operation === 'nativeRelayLifecycle' && !grant && diagnostic.includes('Native fixture waiting for desktop grant\n')) {
            grant = (async () => {
              const candidates = fixtureHost.host.security.devices.list().filter(device => device.name === 'Swift relay fixture')
              expect(candidates.length).toBe(1)
              expect(candidates[0]!.status).toBe('review')
              expect(candidates[0]!.scopes).toEqual(['view'])
              expect(
                (
                  await desktop.confirmed(`devices/${candidates[0]!.id}`, {
                    method: 'PATCH',
                    body: { scopes: ['view', 'run'], dataScope: 'all' },
                  })
                ).status,
              ).toBe(200)
            })()
            void grant.catch(error => {
              child.kill('SIGKILL')
              reject(error)
            })
          }
        })
        child.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', code => {
          clearTimeout(timer)
          if (code !== 0) {
            reject(new Error(diagnostic || 'Swift relay fixture rejected connection'))
            return
          }
          try {
            const value: unknown = JSON.parse(output)
            void (grant ?? Promise.resolve()).then(() => resolve(value), reject)
          } catch {
            reject(new Error('Swift relay returned invalid JSON'))
          }
        })
        child.stdin.end(JSON.stringify(input))
      })
      expect(response).toEqual(expected)
      if (operation === 'nativeRelayLifecycle') {
        const snapshot = await desktop.json<{ tasks: Array<{ id: string }> }>('snapshot')
        expect(snapshot.tasks).toHaveLength(1)
        const detail = await desktop.json<{ messages: Array<{ requestId?: string; text: string }> }>(`tasks/${snapshot.tasks[0]!.id}`)
        expect(detail.messages.find(message => message.requestId === requestId)?.text).toBe('Swift relay fixture `notes.txt`')
      }
      await vi.waitFor(() => expect(relay.status().connections).toBe(1), { timeout: 3000 })
    } finally {
      await host?.close()
      await relay.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
