import { EDGE_RELAY } from '@latch/link-wire'
import { EDGE_PROTOCOL, hexBytes, pathOf } from './node.ts'
import type { EdgeEnv, EdgePlatform, EdgeRequest, EdgeResponse } from './platform.ts'
import { edgeAddressPrefix } from './prefix.ts'

function empty(platform: EdgePlatform, status: number): EdgeResponse {
  return platform.respond(status, undefined, { 'Cache-Control': 'no-store' })
}
/** Constant time over SHA-256 digests, so neither content nor length of the admin token leaks through timing. */
async function tokenMatches(platform: EdgePlatform, given: string, expected: string): Promise<boolean> {
  const encode = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0) & 255)
  const [a, b] = await Promise.all([platform.subtle.digest('SHA-256', encode(given)), platform.subtle.digest('SHA-256', encode(expected))])
  const left = new Uint8Array(a),
    right = new Uint8Array(b)
  let difference = 0
  for (let index = 0; index < 32; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}
function shardCount(env: EdgeEnv): number | undefined {
  const value = Number(env.SHARDS ?? '1')
  return Number.isInteger(value) && value >= 1 && value <= EDGE_RELAY.maxShards ? value : undefined
}

/**
 * The upgrade checks of the self-hosted relay, as far as a Worker sees the request. The edge may consume or rewrite
 * `Sec-WebSocket-Key`, `Sec-WebSocket-Version` and `Connection`, so those are checked only when present.
 */
export function checkUpgrade(request: EdgeRequest): boolean {
  const get = (name: string) => request.headers.get(name)
  const key = get('sec-websocket-key'),
    version = get('sec-websocket-version')
  return (
    request.method === 'GET'
    && (get('upgrade') ?? '').toLowerCase() === 'websocket'
    && get('sec-websocket-protocol') === EDGE_PROTOCOL
    && get('origin') === null
    && get('sec-websocket-extensions') === null
    && get('content-length') === null
    && get('transfer-encoding') === null
    && (key === null || /^[A-Za-z0-9+/]{22}==$/u.test(key))
    && (version === null || version === '13')
  )
}

/**
 * The stateless front of one relay node. It serves exactly one hostname, checks the upgrade, reduces the client address
 * to its fairness prefix and hands the socket to the shard's node object, created near `LOCATION_HINT`.
 *
 * Routes: `GET /v1/{h,d,c}/<shard>` (WebSocket), `GET /healthz` (ok or 503, nothing else), and
 * `GET /admin/status` / `POST /admin/drain` with `Authorization: Bearer <ADMIN_TOKEN>`. Everything else is 404, and no
 * response says why a request was refused.
 */
export function createEdgeWorker(platform: EdgePlatform): { fetch(request: EdgeRequest, env: EdgeEnv): Promise<EdgeResponse> } {
  return {
    async fetch(request, env) {
      const host = /^https:\/\/([a-z0-9.-]{1,253})(?::443)?\//u.exec(request.url)?.[1],
        path = pathOf(request.url)
      const shards = shardCount(env)
      if (!host || path === undefined || request.url.includes('?')) return empty(platform, 404)
      if (
        !env.NODE
        || !(env.NODE_HOSTS ?? '').split(',').some(name => name.trim() === host)
        || !env.LOCATION_HINT
        || !hexBytes(env.RELAY_ID, 16)
        || !hexBytes(env.RELAY_SIGNING_SEED, 32)
        || !shards
      )
        return empty(platform, 503)
      const namespace = env.NODE
      const stub = (shard: number) =>
        namespace.get(namespace.idFromName(`${env.RELAY_ID}:${env.OBJECT_EPOCH ?? '1'}:${shard}`), { locationHint: env.LOCATION_HINT })
      if (path === '/healthz' && request.method === 'GET') {
        const results = await Promise.all(
          Array.from({ length: shards }, (_, shard) =>
            stub(shard)
              .fetch('https://node/health', { method: 'GET', headers: {} })
              .then(response => response.status === 200)
              .catch(() => false),
          ),
        )
        return platform.respond(results.every(Boolean) ? 200 : 503, 'ok\n', { 'Cache-Control': 'no-store' })
      }
      if (path === '/admin/status' || path === '/admin/drain') {
        const bearer = /^Bearer ([\x21-\x7e]{32,256})$/u.exec(request.headers.get('authorization') ?? '')?.[1]
        if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !bearer || !(await tokenMatches(platform, bearer, env.ADMIN_TOKEN)))
          return empty(platform, 404)
        const drain = path === '/admin/drain'
        if (request.method !== (drain ? 'POST' : 'GET')) return empty(platform, 404)
        const results = await Promise.all(
          Array.from({ length: shards }, (_, shard) =>
            stub(shard)
              .fetch(drain ? 'https://node/drain' : 'https://node/status', { method: request.method, headers: {} })
              .then(async response => (response.status === 200 ? (JSON.parse(await response.text()) as unknown) : null))
              .catch(() => null),
          ),
        )
        return platform.respond(results.every(Boolean) ? 200 : 503, JSON.stringify({ shards: results }), {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
      }
      const route = /^\/v1\/([hdc])\/([0-9]|1[0-5])$/u.exec(path)
      if (!route) return empty(platform, 404)
      const shard = Number(route[2])
      if (shard >= shards || !checkUpgrade(request)) return empty(platform, 400)
      let prefix: string
      try {
        prefix = edgeAddressPrefix(request.headers.get('cf-connecting-ip') ?? '')
      } catch {
        return empty(platform, 400)
      }
      // A fresh request: no client header, cookie or address reaches the node object, only the role and the prefix.
      return stub(shard).fetch('https://node/ws', {
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          'X-Latch-Role': route[1] === 'h' ? 'host' : route[1] === 'd' ? 'data' : 'client',
          'X-Latch-Prefix': prefix,
        },
      })
    },
  }
}
