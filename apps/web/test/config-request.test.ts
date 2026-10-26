import { describe, expect, it } from 'vitest'
import { ConfigRequests } from '../src/core/configRequest.ts'
import { ApiError, ApiTimeoutError } from '../src/core/api.ts'

describe('session configuration outcomes', () => {
  it('keeps a timed-out request and blocks a second write until an authoritative outcome is known', () => {
    const requests = new ConfigRequests(),
      request = requests.begin('a', 'model', 'large')!
    requests.settle('a', request, new ApiTimeoutError())
    expect(requests.begin('a', 'model', 'small')).toBeUndefined()
    expect(requests.get('a')).toBe(request)
    expect(requests.reconcile('a', request, [{ id: 'model', name: 'Model', currentValue: 'small', options: [] }])).toBe(false)
    expect(requests.get('a')?.requestId).toBe(request.requestId)
    expect(requests.reconcile('a', request, [], 'pending')).toBe(false)
    expect(requests.reconcile('a', request, [{ id: 'model', name: 'Model', currentValue: 'large', options: [] }], 'pending')).toBe(false)
    expect(requests.reconcile('a', request, [], 'failed')).toBe(true)
    expect(requests.begin('a', 'model', 'small')?.requestId).not.toBe(request.requestId)
  })
  it('reconciles legacy Hosts by their actual value and ignores late results from another session or request', () => {
    const requests = new ConfigRequests(),
      a = requests.begin('a', 'effort', 'high')!,
      b = requests.begin('b', 'model', 'large')!
    requests.settle('a', a, new ApiTimeoutError())
    expect(requests.reconcile('a', a, [{ id: 'effort', name: 'Effort', currentValue: 'high', options: [] }])).toBe(true)
    const newer = requests.begin('a', 'effort', 'low')!
    expect(requests.settle('a', a)).toBe(false)
    expect(requests.get('a')).toBe(newer)
    expect(requests.get('b')).toBe(b)
    requests.settle('b', b, new ApiError(409, 'config-value-invalid', '不可用'))
    expect(requests.get('b')).toBeUndefined()
  })
})
