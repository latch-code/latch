import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, fileBytes, ApiError, ApiTimeoutError, ClientError, isUncertain, setAuthHooks } from '../src/core/api.ts'
import { ConfirmationError } from '../src/core/confirmations.ts'
import {
  createRenewer,
  CredentialNotKeptError,
  MissingDeviceKeyError,
  PENDING_WINDOW_MS,
  RenewalBackoff,
  RenewalScheduler,
  type RenewalDeps,
} from '../src/core/credentials.ts'
import { backoffDelay, connectEventStream, EventStreamParser, type StreamEvent } from '../src/core/eventStream.ts'
import { ENROLLMENT_REASON_TEXT } from '../src/core/securityCopy.ts'
import { authStateFor, renewalFailureOf } from '../src/core/useHarness.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('event stream parser', () => {
  const feedAll = (chunks: string[]) => {
    const parser = new EventStreamParser()
    return chunks.flatMap(chunk => parser.feed(chunk))
  }

  it('handles LF, CRLF and CR line ends, also when split across chunks', () => {
    const expected: StreamEvent[] = [
      { event: 'refresh', data: '{"a":1}' },
      { event: 'task-state', data: 'x' },
    ]
    expect(feedAll(['event: refresh\ndata: {"a":1}\n\nevent: task-state\ndata: x\n\n'])).toEqual(expected)
    expect(feedAll(['event: refresh\r\ndata: {"a":1}\r', '\n\r', '\nevent: task-state\r\ndata: x\r\n\r\n'])).toEqual(expected)
    expect(feedAll(['event: refresh\rdata: {"a":1}\r\revent: task-state\rdata: x\r\r'])).toEqual(expected)
    const text = 'event: refresh\r\ndata: {"a":1}\r\n\r\nevent: task-state\r\ndata: x\r\n\r\n'
    expect(feedAll([...text])).toEqual(expected)
  })

  it('joins multi-line data, skips comments and heartbeats, keeps ids and strips one leading space', () => {
    expect(feedAll([':heartbeat\n\n', 'id: 7\ndata:  two\ndata:lines\n', ': inside\n\n'])).toEqual([
      { event: 'message', data: ' two\nlines', id: '7' },
    ])
  })

  it('ignores a byte-order mark, events without data and a trailing partial frame', () => {
    expect(feedAll(['﻿event: refresh\n\nevent: refresh\ndata: 1\n\n', 'data: partial'])).toEqual([{ event: 'refresh', data: '1' }])
  })

  it('backs off from 1 s to 15 s', () => {
    expect([0, 1, 2, 3, 4, 5].map(attempt => backoffDelay(attempt))).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000])
  })
})

describe('fetch-based event stream connection', () => {
  function body(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    })
  }

  it('repairs once by aborting the actual reader, dropping already-buffered old frames and reconnecting without delta negotiation', async () => {
    const requests: RequestInit[] = []
    const cancelled = vi.fn()
    let nextBody: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      const initial = requests.length === 1
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (!initial) nextBody = controller
            controller.enqueue(
              new TextEncoder().encode(
                initial
                  ? 'event: task-delta\ndata: bad\n\nevent: task-state\ndata: obsolete-buffer\n\n'
                  : 'event: task-state\ndata: full\n\n',
              ),
            )
          },
          cancel() {
            if (initial) cancelled()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const events: string[] = [],
      repaired: boolean[] = []
    const connection = connectEventStream(
      '/link/api/events?sessionId=a',
      {
        onOpen() {},
        onError() {},
        onUnauthorized: () => 'stop',
        onEvent(event) {
          events.push(event.data)
          if (event.event === 'task-delta') repaired.push(connection.repair())
        },
      },
      { fetch: fetchMock, taskDelta: true },
    )
    try {
      await vi.waitFor(() => expect(events).toEqual(['bad', 'full']))
      expect(cancelled).toHaveBeenCalledTimes(1)
      expect(requests[0]!.signal?.aborted).toBe(true)
      expect(new Headers(requests[0]!.headers).get('x-latch-state')).toBe('delta-v1')
      expect(new Headers(requests[1]!.headers).has('x-latch-state')).toBe(false)
      nextBody!.enqueue(new TextEncoder().encode('event: task-delta\ndata: bad-again\n\n'))
      await vi.waitFor(() => expect(repaired).toEqual([true, false]))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(events).not.toContain('obsolete-buffer')
    } finally {
      connection.close()
    }
  })

  it('renews on 401 renewal-required and reconnects at once, then delivers frames', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'renewal-required', message: 'x' }), { status: 401 }),
      new Response(body('event: refresh\ndata: {"r":1}\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]
    const fetchMock = vi.fn(async () => responses.shift() ?? new Promise<Response>(() => {}))
    const events: StreamEvent[] = []
    const unauthorized: string[] = []
    const opened = vi.fn()
    const connection = connectEventStream(
      '/link/api/events',
      {
        onOpen: opened,
        onEvent: event => {
          events.push(event)
        },
        onError: () => {},
        onUnauthorized: code => {
          unauthorized.push(code)
          return 'renewed'
        },
      },
      { fetch: fetchMock as unknown as typeof fetch, initialDelayMs: 60_000 },
    )
    await vi.waitFor(() => {
      expect(events).toEqual([{ event: 'refresh', data: '{"r":1}' }])
    })
    expect(unauthorized).toEqual(['renewal-required'])
    expect(opened).toHaveBeenCalledTimes(1)
    connection.close()
    expect(connection.open).toBe(false)
  })

  const renewalRequired = () => new Response(JSON.stringify({ error: 'renewal-required', message: 'x' }), { status: 401 })

  it('backs off after a renewal that failed instead of reconnecting at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchMock = vi.fn(async () => renewalRequired())
    const connection = connectEventStream(
      '/link/api/events',
      { onOpen: () => {}, onEvent: () => {}, onError: () => {}, onUnauthorized: () => 'retry' },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    const calls = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      return fetchMock.mock.calls.length
    }
    expect(await calls(0)).toBe(1)
    expect(await calls(999)).toBe(1)
    expect(await calls(1)).toBe(2)
    expect(await calls(1999)).toBe(2)
    expect(await calls(1)).toBe(3)
    expect(await calls(3999)).toBe(3)
    expect(await calls(1)).toBe(4)
    connection.close()
  })

  it('reconnects at once only once per renewal while the Host keeps asking for one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchMock = vi.fn(async () => renewalRequired())
    const connection = connectEventStream(
      '/link/api/events',
      { onOpen: () => {}, onEvent: () => {}, onError: () => {}, onUnauthorized: () => 'renewed' },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    connection.close()
  })

  it('drops the connection on suspend, ignores frames that arrive after it, and connects again only on reconnect', async () => {
    let push!: (text: string) => void
    const live = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          push = text => {
            try {
              controller.enqueue(new TextEncoder().encode(text))
            } catch {
              /* cancelled */
            }
          }
        },
      })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const stream = live()
      init.signal?.addEventListener('abort', () => {
        void stream.cancel().catch(() => {})
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const events: StreamEvent[] = []
    const connection = connectEventStream(
      '/link/api/events',
      {
        onOpen: () => {},
        onEvent: event => {
          events.push(event)
        },
        onError: () => {},
        onUnauthorized: () => 'retry',
      },
      { fetch: fetchMock as unknown as typeof fetch, initialDelayMs: 1 },
    )
    await vi.waitFor(() => {
      expect(connection.open).toBe(true)
    })
    push('event: refresh\ndata: 1\n\n')
    await vi.waitFor(() => {
      expect(events).toHaveLength(1)
    })
    connection.suspend()
    expect(connection.open).toBe(false)
    push('event: refresh\ndata: 2\n\n')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(events).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    connection.reconnect()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => {
      expect(connection.open).toBe(true)
    })
    push('event: refresh\ndata: 3\n\n')
    await vi.waitFor(() => {
      expect(events.map(event => event.data)).toEqual(['1', '3'])
    })
    connection.close()
  })

  it('stops when the handler answers stop', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'device-revoked', message: 'x' }), { status: 401 }))
    const errors = vi.fn()
    connectEventStream(
      '/link/api/events',
      { onOpen: () => {}, onEvent: () => {}, onError: errors, onUnauthorized: () => 'stop' },
      { fetch: fetchMock as unknown as typeof fetch, initialDelayMs: 1 },
    )
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('api()', () => {
  it('renews a file byte read once and keeps its exact range and same-origin credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'renewal-required' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 206 }))
    vi.stubGlobal('fetch', fetchMock)
    const renew = vi.fn(async () => true)
    const clear = setAuthHooks({ renew })
    try {
      expect(Array.from(new Uint8Array(await fileBytes('A'.repeat(22), 4, 6)))).toEqual([1, 2, 3])
      expect(renew).toHaveBeenCalledOnce()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      for (const [path, init] of fetchMock.mock.calls) {
        expect(path).toBe(`/link/api/files/${'A'.repeat(22)}`)
        expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Range: 'bytes=4-6' } })
      }
    } finally {
      clear()
    }
  })

  it('refuses a file path or invalid byte range before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fileBytes('../private', 0)).rejects.toBeInstanceOf(ClientError)
    await expect(fileBytes('A'.repeat(22), 10, 9)).rejects.toBeInstanceOf(ClientError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('renews once on 401 renewal-required and retries the request; other 401s are reported', async () => {
    const replies = [
      json(401, { error: 'renewal-required', message: 'x' }),
      json(200, { ok: true }),
      json(401, { error: 'device-revoked', message: 'x' }),
    ]
    const fetchMock = vi.fn(async () => replies.shift()!)
    vi.stubGlobal('fetch', fetchMock)
    const renew = vi.fn(async () => true)
    const unauthorized = vi.fn()
    const remove = setAuthHooks({ renew, unauthorized })
    try {
      expect(await api('snapshot')).toEqual({ ok: true })
      expect(renew).toHaveBeenCalledTimes(1)
      await expect(api('snapshot')).rejects.toMatchObject({
        status: 401,
        code: 'device-revoked',
        message: '这台设备已被移除。要继续使用，请重新连接。',
      })
      expect(unauthorized).toHaveBeenCalledTimes(1)
    } finally {
      remove()
    }
  })

  it('sends a confirmation header and keeps error details', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['x-latch-confirmation']).toBe('cfm_x')
      return json(403, { error: 'scope-required', message: 'server', required: 'admin' })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(api('policy', { method: 'PATCH', body: {}, confirmation: 'cfm_x' })).rejects.toMatchObject({
      code: 'scope-required',
      message: '这台设备不能改设置',
      details: { required: 'admin' },
    })
  })

  it('takes a 2xx status as the answer without reading the body when asked to', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('connection reset'))
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(broken, { status: 200 })),
    )
    await expect(api('credentials/renew', { method: 'POST', body: {}, discardBody: true })).resolves.toBeUndefined()
  })

  it('treats refusals and local confirmation outcomes as definitive', () => {
    expect(isUncertain(new ApiError(503, 'audit-unavailable', 'x'))).toBe(false)
    expect(isUncertain(new ApiError(502, 'request-failed', 'x'))).toBe(true)
    expect(isUncertain(new ApiTimeoutError())).toBe(true)
    expect(isUncertain(new ConfirmationError('x', 'denied', true))).toBe(false)
    expect(isUncertain(new ClientError('x', 'y', { definitive: false }))).toBe(true)
  })
})

describe('credential renewal', () => {
  const key = { hostId: 'h', deviceId: 'dev_a', privateKey: {} as CryptoKey, publicKeySpki: 'x', createdAt: '' }
  function fakeHost(options: { rotateConflict?: boolean } = {}) {
    let renewAfter = 0
    const calls: string[] = []
    const api = vi.fn(async (path: string) => {
      calls.push(path)
      await new Promise(resolve => setTimeout(resolve, 5))
      if (path === 'snapshot') {
        if (renewAfter <= Date.now()) throw new ApiError(401, 'renewal-required', 'x')
        return { device: { renewAfter: new Date(renewAfter).toISOString() } }
      }
      if (path === 'credentials/challenge') return { nonce: 'n', expiresAt: '' }
      if (path === 'credentials/renew') {
        if (options.rotateConflict) throw new ApiError(409, 'credential-rotated', 'x')
        renewAfter = Date.now() + 86_400_000
        return {}
      }
      throw new Error(`unexpected ${path}`)
    })
    return { api, calls }
  }
  /** Web Locks stand-in: one holder per name at a time. */
  function fakeLocks() {
    const tails = new Map<string, Promise<unknown>>()
    return {
      request: (name: string, callback: () => Promise<unknown>) => {
        const run = (tails.get(name) ?? Promise.resolve()).then(callback, callback)
        tails.set(
          name,
          run.catch(() => {}),
        )
        return run
      },
    } as unknown as RenewalDeps['locks']
  }
  const deps = (api: RenewalDeps['api'], locks?: RenewalDeps['locks'], loadKey: RenewalDeps['loadKey'] = async () => key): RenewalDeps => ({
    api,
    locks,
    loadKey,
    sign: async (_key, text) => {
      expect(text).toBe('latch-renew-v1\nh\ndev_a\nn')
      return 'sig'
    },
    now: () => Date.now(),
  })

  it('runs one renewal for concurrent callers in a tab', async () => {
    const host = fakeHost()
    const renewer = createRenewer(deps(host.api as never))
    const results = await Promise.all([
      renewer.renew({ hostId: 'h', deviceId: 'dev_a' }),
      renewer.renew({ hostId: 'h', deviceId: 'dev_a' }),
      renewer.renew({ hostId: 'h' }),
    ])
    expect(results).toEqual(['renewed', 'renewed', 'renewed'])
    expect(host.calls.filter(path => path === 'credentials/renew')).toHaveLength(1)
  })

  it('serializes tabs with Web Locks; the waiting tab re-reads the snapshot and does not rotate again', async () => {
    const host = fakeHost()
    const locks = fakeLocks()
    const tabA = createRenewer(deps(host.api as never, locks))
    const tabB = createRenewer(deps(host.api as never, locks))
    expect(await Promise.all([tabA.renew({ hostId: 'h', deviceId: 'dev_a' }), tabB.renew({ hostId: 'h', deviceId: 'dev_a' })])).toEqual([
      'renewed',
      'not-due',
    ])
    expect(host.calls.filter(path => path === 'credentials/renew')).toHaveLength(1)
  })

  /**
   * A Host that keeps the current credential until the renewed one is first presented: a renew stores a pending
   * credential, its first use promotes it and starts a 60 s grace for the replaced one, and a replaced credential used
   * after that grace revokes the device. `outcomes` decides how each renew request ends; the browser's cookie changes
   * only when an answer arrives, and not at all for `not-stored` (a 2xx whose cookie the browser drops). `now` lets a
   * test drive the Host clock with fake timers; `advance` moves it further.
   */
  function pendingHost(
    outcomes: Array<'ok' | 'lost-before' | 'lost-after' | 'failed-500' | 'expired' | 'not-stored'>,
    now: () => number = () => 1_000_000,
  ) {
    let offset = 0
    const clock = () => now() + offset
    let issued = 0
    let cookie = 'cred-0'
    const state = {
      current: 'cred-0',
      rotatedAt: clock() - 86_400_001,
      pending: null as string | null,
      previous: [] as Array<{ value: string; graceUntil: number }>,
      revoked: false,
    }
    const nonces = new Set<string>()
    const sent: Array<{ path: string; nonce?: string; discardBody?: boolean }> = []
    const authenticate = (renewal: boolean) => {
      if (state.revoked) throw new ApiError(401, 'device-revoked', 'x')
      if (cookie === state.pending) {
        state.previous.push({ value: state.current, graceUntil: clock() + 60_000 })
        state.current = cookie
        state.rotatedAt = clock()
        state.pending = null
      }
      if (cookie === state.current) {
        if (!renewal && clock() - state.rotatedAt > 86_400_000) throw new ApiError(401, 'renewal-required', 'x')
        return
      }
      const previous = state.previous.find(entry => entry.value === cookie)
      if (!previous) throw new ApiError(401, 'unauthorized', 'x')
      if (clock() > previous.graceUntil) {
        state.revoked = true
        throw new ApiError(401, 'device-revoked', 'x')
      }
      if (renewal) throw new ApiError(409, 'credential-rotated', 'x')
    }
    const api = vi.fn(async (path: string, request: { body?: { nonce?: string }; discardBody?: boolean } = {}) => {
      sent.push({
        path,
        ...(request.body?.nonce ? { nonce: request.body.nonce } : {}),
        ...(request.discardBody ? { discardBody: true } : {}),
      })
      if (path === 'snapshot') {
        authenticate(false)
        return { device: { renewAfter: new Date(state.rotatedAt + 86_400_000).toISOString() } }
      }
      if (path === 'credentials/challenge') {
        authenticate(true)
        const nonce = `n${++issued}`
        nonces.add(nonce)
        return { nonce, expiresAt: '' }
      }
      const outcome = outcomes.shift() ?? 'ok'
      if (outcome === 'lost-before') throw new TypeError('network')
      authenticate(true)
      if (!nonces.delete(request.body?.nonce ?? '') || outcome === 'expired') throw new ApiError(401, 'invalid-signature', 'x')
      if (outcome === 'failed-500') throw new ApiError(500, 'internal-error', 'x')
      state.pending = `cred-${issued}`
      if (outcome === 'lost-after') throw new ApiTimeoutError()
      if (outcome !== 'not-stored') cookie = state.pending
      return undefined
    })
    const renewer = createRenewer({ api: api as never, loadKey: async () => key, sign: async (_key, text) => `sig:${text}`, now: clock })
    return {
      renewer,
      state,
      sent,
      cookie: () => cookie,
      advance: (ms: number) => {
        offset += ms
      },
      /** An ordinary request with whatever cookie the browser holds. */
      request: () => {
        authenticate(false)
      },
      renews: () => sent.filter(call => call.path === 'credentials/renew'),
    }
  }

  it.each(['lost-after', 'lost-before', 'failed-500'] as const)(
    'keeps the current credential when a renew ends without an answer (%s) and leaves the retry to the caller',
    async outcome => {
      const host = pendingHost([outcome])
      const failure = await host.renewer.renew({ hostId: 'h', deviceId: 'dev_a' }).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      // A transient cause: the page keeps the credential and reconnects instead of returning to enrollment.
      expect(renewalFailureOf(failure)).toBeNull()
      expect(host.renews()).toHaveLength(1)
      expect(host.cookie()).toBe('cred-0')
      expect(host.state.current).toBe('cred-0')
    },
  )

  it('renews again with the same credential long after a lost answer; the unused credential is replaced and nothing is revoked', async () => {
    const host = pendingHost(['lost-after', 'ok'])
    await expect(host.renewer.renew({ hostId: 'h', deviceId: 'dev_a' })).rejects.toBeInstanceOf(ApiTimeoutError)
    expect(host.state.pending).toBe('cred-1')
    // Well past the 60 s that a rotated-out credential used to be accepted for.
    host.advance(5 * 60_000)
    expect(await host.renewer.renew({ hostId: 'h', deviceId: 'dev_a' })).toBe('renewed')
    expect(host.cookie()).toBe('cred-2')
    host.request()
    expect(host.state).toMatchObject({ current: 'cred-2', pending: null, revoked: false })
    expect(host.renews().map(call => call.nonce)).toEqual(['n1', 'n2'])
    expect(host.renews().every(call => call.discardBody)).toBe(true)
  })

  it('retries an expired or forgotten challenge once with a fresh one', async () => {
    const host = pendingHost(['expired', 'ok'])
    expect(await host.renewer.renew({ hostId: 'h', deviceId: 'dev_a' })).toBe('renewed')
    expect(host.renews().map(call => call.nonce)).toEqual(['n1', 'n2'])
    const twice = pendingHost(['expired', 'expired'])
    await expect(twice.renewer.renew({ hostId: 'h', deviceId: 'dev_a' })).rejects.toMatchObject({ status: 401, code: 'invalid-signature' })
  })

  it('paces renewal after transient failures and lets every trigger in between share the wait', () => {
    let now = 0
    const backoff = new RenewalBackoff(() => now)
    expect(backoff.wait()).toBe(0)
    expect([1, 2, 3, 4, 5, 6].map(() => backoff.failed())).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(backoff.wait()).toBe(30_000)
    now += 29_000
    expect(backoff.wait()).toBe(1_000)
    now += 1_000
    expect(backoff.wait()).toBe(0)
    backoff.reset()
    expect(backoff.failed()).toBe(2_000)
  })

  it('counts one backoff step per failed attempt, however many requests were waiting on it', async () => {
    vi.useFakeTimers()
    const renew = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new TypeError('network'))
          }, 5)
        }),
    )
    const retry = vi.fn()
    const scheduler = new RenewalScheduler({ renew, retry, now: () => Date.now() })
    // The snapshot, another request and the event stream hit renewal-required together.
    const answers = Promise.all([scheduler.renew({ hostId: 'h' }), scheduler.renew({ hostId: 'h' }), scheduler.renew({ hostId: 'h' })])
    await vi.advanceTimersByTimeAsync(5)
    expect(await answers).toEqual([false, false, false])
    expect(renew).toHaveBeenCalledTimes(1)
    expect(scheduler.failure).toBeNull()
    // A trigger during the wait shares it.
    expect(await scheduler.renew({ hostId: 'h' })).toBe(false)
    // The failure came 5 ms in; the first wait is 2 s from then.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(retry).toHaveBeenCalledTimes(1)
    // The retry starts at once, and its failure is the second step.
    const second = scheduler.renew({ hostId: 'h' })
    await vi.advanceTimersByTimeAsync(5)
    expect(await second).toBe(false)
    expect(renew).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(retry).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('schedules nothing after sign-out, also for an attempt that was still running', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    const scheduler = new RenewalScheduler({
      renew: () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new TypeError('network'))
          }, 5)
        }),
      retry,
    })
    const running = scheduler.renew({ hostId: 'h' })
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await running).toBe(false)
    expect(retry).not.toHaveBeenCalled()
    expect(scheduler.failure).toBeNull()
  })

  const identity = { hostId: 'h', deviceId: 'dev_a' }

  it('does not renew again while the browser still presents the replaced credential, and gives up after the pending window', async () => {
    const host = pendingHost(['not-stored'])
    expect(await host.renewer.renew(identity)).toBe('renewed')
    expect(host.cookie()).toBe('cred-0')
    expect(host.state.pending).toBe('cred-1')
    const early = await host.renewer.renew(identity).catch((cause: unknown) => cause)
    expect(early).toBeInstanceOf(CredentialNotKeptError)
    expect(renewalFailureOf(early)).toBeNull()
    // The Host still accepts the pending credential at exactly 10 minutes.
    host.advance(PENDING_WINDOW_MS)
    expect(renewalFailureOf(await host.renewer.renew(identity).catch((cause: unknown) => cause))).toBeNull()
    host.advance(1)
    const late = await host.renewer.renew(identity).catch((cause: unknown) => cause)
    expect(renewalFailureOf(late)).toBe('renewal-not-stored')
    expect(authStateFor(new ApiError(401, 'renewal-required', 'x'), renewalFailureOf(late))).toEqual({ reason: 'renewal-not-stored' })
    expect(ENROLLMENT_REASON_TEXT['renewal-not-stored']).toContain('没有保存新的凭据')
    expect(host.renews()).toHaveLength(1)
    expect(host.state).toMatchObject({ current: 'cred-0', revoked: false })
  })

  it('paces the checks for a renewed cookie the browser did not store and leaves for enrollment after the pending window', async () => {
    vi.useFakeTimers({ now: 1_000_000_000 })
    const host = pendingHost(['not-stored'], () => Date.now())
    const retries: number[] = []
    const scheduler: RenewalScheduler = new RenewalScheduler({
      renew: id => host.renewer.renew(id),
      now: () => Date.now(),
      retry: () => {
        retries.push(Date.now())
        void scheduler.renew(identity)
      },
    })
    const start = Date.now()
    expect(await scheduler.renew(identity)).toBe(true)
    // The request retried after the renewal still presents the old credential and asks again.
    expect(await scheduler.renew(identity)).toBe(false)
    // Requests and event-stream reconnects keep asking every second; they wait for the scheduled retry.
    for (let second = 0; second < 15 * 60 && scheduler.failure === null; second++) {
      void scheduler.renew(identity)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(scheduler.failure).toBe('renewal-not-stored')
    expect(host.renews()).toHaveLength(1)
    expect(host.sent.filter(call => call.path === 'snapshot')).toHaveLength(retries.length + 2)
    const gaps = retries.map((at, index) => at - (index === 0 ? start : retries[index - 1]!))
    expect(gaps.slice(0, 6)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(Math.max(...gaps)).toBe(30_000)
    expect(retries.at(-1)! - start).toBeGreaterThan(PENDING_WINDOW_MS)
    expect(retries.at(-1)! - start).toBeLessThanOrEqual(PENDING_WINDOW_MS + 30_000)
  })

  it('renews as usual a day after a renewal whose cookie was stored', async () => {
    const host = pendingHost(['ok', 'ok'])
    expect(await host.renewer.renew(identity)).toBe('renewed')
    host.request()
    host.advance(86_400_001)
    expect(await host.renewer.renew(identity)).toBe('renewed')
    expect(host.renews()).toHaveLength(2)
    host.request()
    expect(host.state).toMatchObject({ current: 'cred-2', revoked: false })
  })

  it('treats credential-rotated as another tab having renewed, and a missing key as re-enrollment', async () => {
    expect(await createRenewer(deps(fakeHost({ rotateConflict: true }).api as never)).renew({ hostId: 'h', deviceId: 'dev_a' })).toBe(
      'rotated',
    )
    // The other tab's credential was promoted between this tab's snapshot and its challenge.
    const challengeConflict = vi.fn(async (path: string) => {
      if (path === 'snapshot') throw new ApiError(401, 'renewal-required', 'x')
      throw new ApiError(409, 'credential-rotated', 'x')
    })
    expect(await createRenewer(deps(challengeConflict as never)).renew({ hostId: 'h', deviceId: 'dev_a' })).toBe('rotated')
    expect(challengeConflict.mock.calls.map(([path]) => path)).toEqual(['snapshot', 'credentials/challenge'])
    await expect(
      createRenewer(deps(fakeHost().api as never, undefined, async () => undefined)).renew({ hostId: 'h', deviceId: 'dev_a' }),
    ).rejects.toBeInstanceOf(MissingDeviceKeyError)
  })
})
