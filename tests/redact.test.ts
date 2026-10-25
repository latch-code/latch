import { describe, expect, it } from 'vitest'
import { containsSecret, redactSecrets } from '@latch/core/node-kit'

const credential = `ldc1.dev_${'A'.repeat(22)}.${'b'.repeat(43)}`
// Assembled at run time, so the source never holds a key-shaped line.
const pem = (kind: string) => ['-----BEGIN', kind, 'KEY-----'].filter(Boolean).join(' ')
const modelKey = ['sk', 'proj', 'a1B2'.repeat(8)].join('-')
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const githubToken = ['ghp', 'x'.repeat(36)].join('_')

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

  it.each([
    ['a PEM private key', `${pem('PRIVATE')}\nMIIE`, '[redacted]\nMIIE'],
    ['an RSA private key', `x ${pem('RSA PRIVATE')} y`, 'x [redacted] y'],
    ['an OpenSSH private key', pem('OPENSSH PRIVATE'), '[redacted]'],
    ['a model service key', `key=${modelKey}`, 'key=[redacted]'],
    ['an AWS access key', `id ${awsKey} end`, 'id [redacted] end'],
    ['a GitHub token', `token ${githubToken}`, 'token [redacted]'],
  ])('redacts %s', (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
    expect(containsSecret(input)).toBe(true)
  })

  it('tells a credential from text that only names where one goes: documentation is not a secret', () => {
    for (const text of [
      'GET https://api.example.com/items?token=YOUR_TOKEN',
      '桌面端在 Latch-Device 请求头里带上凭据。',
      'Cookie: latch_abcdefgh=<凭据>',
      'http://h.localhost:4317/link/#pair=XXXX',
    ]) {
      expect(containsSecret(text), text).toBe(false)
      // Log lines still lose them.
      expect(redactSecrets(text), text).not.toBe(text)
    }
    expect(containsSecret(`authorization: Latch-Device ${credential}`)).toBe(true)
    expect(containsSecret('https://phone.example/link/#pair=lpi1-ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(true)
    expect(containsSecret(`curl -H 'x-api-key: ${modelKey}'`)).toBe(true)
  })

  it('finds secrets without being thrown by repeated use, and not in ordinary text or public keys', () => {
    for (let index = 0; index < 3; index++) expect(containsSecret(credential)).toBe(true)
    expect(containsSecret(pem('PUBLIC'))).toBe(false)
    expect(containsSecret('task-0123456789abcdef0123456789 desk-0123456789abcdef0123456789')).toBe(false)
    expect(containsSecret('普通的笔记，没有密钥。')).toBe(false)
  })

  it('redacts every occurrence', () => {
    expect(redactSecrets(`${credential} and ${credential}`)).toBe('[redacted] and [redacted]')
  })
})
