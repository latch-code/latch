import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { passesCredentialCookie } from '../vite.config.ts'

const HOST_ID = 'a'.repeat(52)
const HOST_NAME = `h-${HOST_ID}.localhost`

describe('development proxy', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  it('passes a credential cookie on only for the Host-specific name', () => {
    expect(passesCredentialCookie(`${HOST_NAME}:5173`, HOST_NAME)).toBe(true)
    expect(passesCredentialCookie(HOST_NAME.toUpperCase(), HOST_NAME)).toBe(true)
    expect(passesCredentialCookie('127.0.0.1:5173', HOST_NAME)).toBe(false)
    expect(passesCredentialCookie('localhost:5173', HOST_NAME)).toBe(false)
    expect(passesCredentialCookie(`${HOST_NAME}.evil.test`, HOST_NAME)).toBe(false)
    expect(passesCredentialCookie(undefined, HOST_NAME)).toBe(false)
  })

  it('drops Set-Cookie from the Host when the page is opened on 127.0.0.1', async () => {
    // A stand-in Host on an ephemeral loopback port; the dev server reads it from a temporary data directory.
    const upstream: Server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'latch_aaaaaaaa=credential; HttpOnly; SameSite=Strict; Path=/' })
      res.end('{"device":{}}')
    })
    await new Promise<void>(resolve => { upstream.listen(0, '127.0.0.1', resolve) })
    cleanups.push(() => new Promise(resolve => { upstream.close(() => { resolve() }) }))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const dataDir = await mkdtemp(join(tmpdir(), 'latch-devproxy-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    await writeFile(join(dataDir, 'host.json'), JSON.stringify({
      version: 2, pid: process.pid, hostId: HOST_ID, instanceId: '00000000-0000-4000-8000-000000000000', socketPath: join(dataDir, 'host.sock'),
      loopbackOrigin: `http://${HOST_NAME}:${upstreamPort}`, tlsOrigin: null, startedAt: new Date().toISOString(), dataDir,
    }), { mode: 0o600 })

    const previous = process.env.HARNESS_DATA_DIR
    process.env.HARNESS_DATA_DIR = dataDir
    let server: ViteDevServer
    try {
      server = await createServer({
        configFile: join(import.meta.dirname, '..', 'vite.config.ts'), configLoader: 'runner', cacheDir: join(dataDir, 'vite-cache'),
        logLevel: 'silent', server: { port: 0, strictPort: false, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
      })
    } finally {
      if (previous === undefined) delete process.env.HARNESS_DATA_DIR
      else process.env.HARNESS_DATA_DIR = previous
    }
    cleanups.push(() => server.close())
    await server.listen()
    const port = (server.httpServer!.address() as AddressInfo).port

    const post = (host: string) => new Promise<{ cookie: string[] | undefined; status: number }>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port, path: '/link/api/enrollments/enr_1/complete', method: 'POST', headers: { host, 'content-type': 'application/json' } }, response => {
        response.resume()
        response.on('end', () => { resolve({ cookie: response.headers['set-cookie'], status: response.statusCode ?? 0 }) })
      })
      outgoing.on('error', reject)
      outgoing.end('{}')
    })
    const onLoopbackIp = await post(`127.0.0.1:${port}`)
    expect(onLoopbackIp.status).toBe(200)
    expect(onLoopbackIp.cookie).toBeUndefined()
    const onHostName = await post(`${HOST_NAME}:${port}`)
    expect(onHostName.status).toBe(200)
    expect(onHostName.cookie).toEqual(['latch_aaaaaaaa=credential; HttpOnly; SameSite=Strict; Path=/'])
  })
})
