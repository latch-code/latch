import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/host/redact.ts'

const credential = `ldc1.dev_${'A'.repeat(22)}.${'b'.repeat(43)}`

describe('redactSecrets', () => {
  it.each([
    [`credential ${credential} end`, 'credential [redacted] end'],
    ['invite lpi1-ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'invite [redacted]'],
    ['offline lpo1-ABCDEFGHIJKLMNOPQRSTUVWX23', 'offline [redacted]'],
    ['cookie: harness_link=abc-DEF_123; Path=/link', 'cookie: [redacted]; Path=/link'],
    [`set-cookie: latch_abcdefgh=${credential}; HttpOnly`, 'set-cookie: [redacted]; HttpOnly'],
    ['__Host-latch_abcd2345=xyz other', '[redacted] other'],
    [`authorization: Latch-Device ${credential}`, 'authorization: [redacted]'],
    ['open http://h.localhost:4317/link/#token=abc_DEF-1', 'open http://h.localhost:4317/link/[redacted]'],
    ['https://phone.example/link/#pair=lpi1-ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'https://phone.example/link/#pair=[redacted]'],
    ['https://phone.example/link/#pair=not-a-code_1', 'https://phone.example/link/[redacted]'],
    ['GET /link/login?token=secret_1&x=1', 'GET /link/login[redacted]&x=1'],
    ['GET /x?a=1&token=secret', 'GET /x?a=1[redacted]'],
  ])('%s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it('leaves ordinary text alone', () => {
    const text = 'Latch 0.1.0 · 打开 http://h-abc.localhost:4317/link/ ，请在本机确认。 dev_123 latch_short=1 lpi1-short'
    expect(redactSecrets(text)).toBe(text)
  })

  it('redacts every occurrence', () => {
    expect(redactSecrets(`${credential} and ${credential}`)).toBe('[redacted] and [redacted]')
  })
})
