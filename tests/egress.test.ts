import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressDenied, createEgressFetch, isDeniedAddress, resolveEgressAddress, type LookupFunction } from '../src/host/egress.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function localServer(handler: (request: IncomingMessage, response: ServerResponse, port: number) => void): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = []
  let port = 0
  const server: Server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url} host=${request.headers.host}`)
    handler(request, response, port)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { port, hits }
}

function lookupFrom(table: Record<string, string[] | (() => string[])>): LookupFunction & { calls: string[] } {
  const calls: string[] = []
  const lookup = ((hostname, _options, callback) => {
    calls.push(hostname)
    const entry = table[hostname]
    if (!entry) { callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []); return }
    const addresses = typeof entry === 'function' ? entry() : entry
    callback(null, addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })))
  }) as LookupFunction & { calls: string[] }
  lookup.calls = calls
  return lookup
}

function egressCause(error: unknown): EgressDenied | undefined {
  if (error instanceof EgressDenied) return error
  const cause = (error as { cause?: unknown } | undefined)?.cause
  return cause instanceof EgressDenied ? cause : undefined
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise } catch (error) { return error }
  throw new Error('expected a rejection')
}

const noLocal = () => new Set<string>()

describe('isDeniedAddress', () => {
  it.each([
    ['0.1.2.3', 'reserved'], ['10.0.0.1', 'private'], ['100.64.0.1', 'private'], ['100.127.255.255', 'private'], ['100.128.0.1', undefined],
    ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'], ['169.254.169.254', 'metadata'], ['169.254.1.1', 'link-local'],
    ['172.15.255.255', undefined], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['172.32.0.0', undefined],
    ['192.168.1.1', 'private'], ['224.0.0.1', 'multicast'], ['239.255.255.255', 'multicast'], ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'], ['8.8.8.8', undefined], ['93.184.216.34', undefined],
    ['::', 'reserved'], ['::1', 'loopback'], ['[::1]', 'loopback'], ['fe80::1', 'link-local'], ['fe80::1%en0', 'link-local'], ['febf::1', 'link-local'],
    ['fc00::1', 'private'], ['fd7a:115c:a1e0::1', 'private'], ['fd00:ec2::254', 'metadata'], ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::ffff:169.254.169.254', 'metadata'], ['::ffff:10.1.2.3', 'private'],
    ['::127.0.0.1', 'loopback'], ['::ffff:8.8.8.8', undefined], ['64:ff9b::a9fe:a9fe', 'metadata'], ['2002:a9fe:a9fe::1', 'metadata'],
    ['2606:4700:4700::1111', undefined], ['not-an-ip', 'reserved'],
    // Never globally routed; 198.18.0.0/15 is what fake-IP proxies hand out for every name.
    ['198.18.0.5', 'reserved'], ['198.19.255.1', 'reserved'], ['198.17.255.255', undefined], ['198.20.0.0', undefined],
    ['192.0.0.192', 'reserved'], ['192.0.2.1', 'reserved'], ['192.88.99.1', 'reserved'], ['198.51.100.1', 'reserved'], ['203.0.113.1', 'reserved'],
    ['::ffff:198.18.0.5', 'reserved'], ['64:ff9b::c612:5', 'reserved'], ['64:ff9b:1::7f00:1', 'reserved'], ['::ffff:0:7f00:1', 'reserved'],
    ['100::1', 'reserved'], ['2001:db8::1', 'reserved'], ['2001::1', 'reserved'], ['2001:4860:4860::8888', undefined],
  ])('%s → %s', (address, expected) => {
    expect(isDeniedAddress(address, new Set())).toBe(expected)
  })

  it('denies the Host\'s own interface addresses, including IPv4-mapped forms', () => {
    const local = new Set(['93.184.215.14', '2606:2800:21f:cb07::7'])
    expect(isDeniedAddress('93.184.215.14', local)).toBe('local-interface')
    expect(isDeniedAddress('::ffff:93.184.215.14', local)).toBe('local-interface')
    expect(isDeniedAddress('2606:2800:21F:CB07::7', local)).toBe('local-interface')
    expect(isDeniedAddress('93.184.215.15', local)).toBeUndefined()
  })
})

describe('resolveEgressAddress', () => {
  it('checks every resolution it dials, so DNS rebinding cannot reach a private address', async () => {
    let call = 0
    const lookup = lookupFrom({ 'rebind.test': () => (call++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']) })
    const input = { hostname: 'rebind.test', port: 443, allow: [], lookup, localAddresses: new Set<string>() }
    await expect(resolveEgressAddress(input)).resolves.toBe('93.184.216.34')
    const error = await rejection(resolveEgressAddress(input))
    expect(error).toBeInstanceOf(EgressDenied)
    expect(error).toMatchObject({ code: 'egress-denied', target: 'rebind.test:443', reason: 'loopback' })
    expect(lookup.calls).toEqual(['rebind.test', 'rebind.test'])
  })

  it('skips denied addresses in favour of a public one, and keeps metadata denied even when allowlisted', async () => {
    const lookup = lookupFrom({ 'mixed.test': ['10.0.0.1', '93.184.216.34'], 'meta.test': ['169.254.169.254'] })
    await expect(resolveEgressAddress({ hostname: 'mixed.test', port: 80, allow: [], lookup, localAddresses: new Set() })).resolves.toBe('93.184.216.34')
    await expect(resolveEgressAddress({ hostname: 'meta.test', port: 80, allow: ['meta.test:80'], lookup, localAddresses: new Set() })).rejects.toMatchObject({ reason: 'metadata' })
    await expect(resolveEgressAddress({ hostname: '[::1]', port: 8080, allow: ['[::1]:8080'], lookup, localAddresses: new Set() })).resolves.toBe('::1')
    await expect(resolveEgressAddress({ hostname: 'missing.test', port: 80, allow: [], lookup, localAddresses: new Set() })).rejects.toMatchObject({ code: 'ENOTFOUND' })
  })
})

describe('createEgressFetch', () => {
  it('refuses the metadata address without connecting', async () => {
    const fetch = createEgressFetch({ allow: () => [], localAddresses: noLocal })
    const error = await rejection(fetch('http://169.254.169.254/latest/meta-data/', {}))
    expect(error).toBeInstanceOf(TypeError)
    expect(egressCause(error)).toMatchObject({ code: 'egress-denied', reason: 'metadata', target: '169.254.169.254:80' })
    expect(egressCause(error)?.message).toBe('Host 不会访问 169.254.169.254:80（本机、私网或元数据地址）。如需访问本机模型服务，请在本机确认后加入出站白名单。')
  })

  it('refuses a host name that resolves to loopback, and the server never sees the request', async () => {
    const server = await localServer((_request, response) => response.end('secret'))
    const lookup = lookupFrom({ 'model.test': ['127.0.0.1'] })
    const fetch = createEgressFetch({ allow: () => [], lookup, localAddresses: noLocal })
    const error = await rejection(fetch(`http://model.test:${server.port}/v1/models`, {}))
    expect(egressCause(error)).toMatchObject({ reason: 'loopback', target: `model.test:${server.port}` })
    const literal = await rejection(fetch(`http://127.0.0.1:${server.port}/`, {}))
    expect(egressCause(literal)).toMatchObject({ reason: 'loopback' })
    expect(server.hits).toEqual([])
  })

  it('reaches an allowlisted host:port and keeps the original Host header', async () => {
    const server = await localServer((_request, response) => response.end('ok'))
    const lookup = lookupFrom({ 'model.test': ['127.0.0.1'] })
    const fetch = createEgressFetch({ allow: () => [`127.0.0.1:${server.port}`, `model.test:${server.port}`], lookup, localAddresses: noLocal })
    expect(await (await fetch(`http://127.0.0.1:${server.port}/a`, {})).text()).toBe('ok')
    expect(await (await fetch(`http://model.test:${server.port}/b`, { method: 'POST', body: '{}' })).text()).toBe('ok')
    expect(server.hits).toEqual([`GET /a host=127.0.0.1:${server.port}`, `POST /b host=model.test:${server.port}`])
    // The allowlist is exact: another port on the same host is still refused.
    expect(egressCause(await rejection(fetch(`http://127.0.0.1:${server.port + 1}/`, {})))).toMatchObject({ reason: 'loopback' })
  })

  it('follows at most three same-origin redirects and refuses cross-origin ones', async () => {
    const server = await localServer((request, response, port) => {
      const step = Number(/\/hop\/(\d+)/u.exec(request.url ?? '')?.[1] ?? -1)
      if (request.url === '/cross') { response.writeHead(302, { location: `http://localhost:${port}/` }); response.end(); return }
      if (request.url === '/meta') { response.writeHead(307, { location: 'http://169.254.169.254/' }); response.end(); return }
      if (request.url === '/see-other') { response.writeHead(303, { location: '/done' }); response.end(); return }
      if (step > 0) { response.writeHead(302, { location: `/hop/${step - 1}` }); response.end(); return }
      response.end(`${request.method} ${request.url}`)
    })
    const allow = [`127.0.0.1:${server.port}`, `localhost:${server.port}`]
    const fetch = createEgressFetch({ allow: () => allow, localAddresses: noLocal })
    const base = `http://127.0.0.1:${server.port}`
    expect(await (await fetch(`${base}/hop/3`, {})).text()).toBe('GET /hop/0')
    await expect(fetch(`${base}/hop/4`, {})).rejects.toThrow('too many redirects')
    const cross = await rejection(fetch(`${base}/cross`, {}))
    expect(cross).toBeInstanceOf(EgressDenied)
    expect(cross).toMatchObject({ reason: 'redirect', target: `localhost:${server.port}` })
    expect(await rejection(fetch(`${base}/meta`, {}))).toMatchObject({ reason: 'redirect', target: '169.254.169.254:80' })
    expect(await (await fetch(`${base}/see-other`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).text()).toBe('GET /done')
    expect(server.hits.filter(hit => hit.includes('localhost'))).toEqual([])
    // redirect: 'error' is left to the fetch implementation, which rejects.
    await expect(fetch(`${base}/hop/1`, { redirect: 'error' })).rejects.toThrow()
    const manual = await fetch(`${base}/hop/1`, { redirect: 'manual' })
    expect(manual.status).toBe(302)
  })

  it('accepts only http and https', async () => {
    const fetch = createEgressFetch({ allow: () => [], localAddresses: noLocal })
    expect(await rejection(fetch('file:///etc/passwd', {}))).toMatchObject({ code: 'egress-denied', reason: 'protocol' })
    expect(await rejection(fetch('ftp://example.com/', {}))).toMatchObject({ reason: 'protocol' })
  })

  it('treats the Host\'s interface addresses as denied', async () => {
    const server = await localServer((_request, response) => response.end('ok'))
    const lookup = lookupFrom({ 'self.test': ['93.184.215.9'] })
    const fetch = createEgressFetch({ allow: () => [], lookup, localAddresses: () => new Set(['93.184.215.9']) })
    expect(egressCause(await rejection(fetch(`http://self.test:${server.port}/`, {})))).toMatchObject({ reason: 'local-interface' })
    expect(server.hits).toEqual([])
  })

  it('refuses the fake-IP placeholder a TUN proxy answers with, since the proxy would dial the real address itself', async () => {
    const server = await localServer((_request, response) => response.end('secret'))
    const lookup = lookupFrom({ 'rebind.test': ['198.18.0.5'] })
    const fetch = createEgressFetch({ allow: () => [], lookup, localAddresses: noLocal })
    expect(egressCause(await rejection(fetch(`http://rebind.test:${server.port}/v1/models`, {})))).toMatchObject({ reason: 'reserved', target: `rebind.test:${server.port}` })
    expect(server.hits).toEqual([])
  })

  it('stops using pooled connections that only an allowlist entry permitted once the entry is removed', async () => {
    const server = await localServer((_request, response) => response.end('ok'))
    let allow = [`127.0.0.1:${server.port}`]
    const fetch = createEgressFetch({ allow: () => allow, localAddresses: noLocal })
    const base = `http://127.0.0.1:${server.port}`
    expect(await (await fetch(`${base}/a`, {})).text()).toBe('ok')
    expect(await (await fetch(`${base}/b`, {})).text()).toBe('ok')
    allow = []
    // Without the entry, the idle keep-alive socket is dropped instead of reused.
    expect(egressCause(await rejection(fetch(`${base}/c`, {})))).toMatchObject({ reason: 'loopback' })
    expect(server.hits.map(hit => hit.split(' ')[1])).toEqual(['/a', '/b'])
  })

  it('ends a response still streaming over a connection whose allowlist entry was removed', async () => {
    let release = () => {}
    const server = await localServer((request, response) => {
      if (request.url !== '/stream') { response.end('ok'); return }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('first ')
      release = () => response.end('last')
    })
    const entry = `localhost:${server.port}`
    let allow = [`127.0.0.1:${server.port}`, entry]
    const lookup = lookupFrom({ localhost: ['127.0.0.1'] })
    const fetch = createEgressFetch({ allow: () => allow, lookup, localAddresses: noLocal })
    const streaming = await fetch(`http://localhost:${server.port}/stream`, {})
    const reader = streaming.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first ')
    allow = [`127.0.0.1:${server.port}`]
    // The next request through the Host's fetch applies the removal to every connection, busy or idle.
    expect(await (await fetch(`http://127.0.0.1:${server.port}/other`, {})).text()).toBe('ok')
    release()
    await expect((async () => { for (;;) { const next = await reader.read(); if (next.done) return 'done' } })()).rejects.toThrow()
  })
})
