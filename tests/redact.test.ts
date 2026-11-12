import { describe, expect, it } from 'vitest'
import { containsSecret, CREDENTIALS, PATTERNS, redactSecrets } from '@latch/core/node-kit'
import { containsSecret as pageContainsSecret, CREDENTIAL_CARRIERS, CREDENTIAL_KEYS, LATCH_CREDENTIALS, looksSecret } from '@latch/protocol'

const credential = `ldc1.dev_${'A'.repeat(22)}.${'b'.repeat(43)}`
// Assembled at run time, so the source never holds a key-shaped line.
const pem = (kind: string) => ['-----BEGIN', kind, 'KEY-----'].filter(Boolean).join(' ')
const modelKey = ['sk', 'proj', 'a1B2'.repeat(8)].join('-')
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const githubToken = ['ghp', 'x'.repeat(36)].join('_')

describe('redactSecrets', () => {
  it.each([
    [`credential ${credential} end`, 'credential [redacted] end'],
    [`native QR LATCHPAIR2.${'a'.repeat(128)} end`, 'native QR [redacted] end'],
    [`link https://latch.example/pair#2.${'a'.repeat(128)} end`, 'link https://latch.example[redacted] end'],
    [`native window lnw1.${'W'.repeat(43)} end`, 'native window [redacted] end'],
    [`native proof lnp1.${'P'.repeat(43)} end`, 'native proof [redacted] end'],
    [`native book LATCHBOOK1.${'B'.repeat(128)} end`, 'native book [redacted] end'],
    ['invite lpi1-ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'invite [redacted]'],
    ['offline lpo1-ABCDEFGHIJKLMNOPQRSTUVWX23', 'offline [redacted]'],
    [`GEMINI_API_KEY=lmg1.${'g-'.repeat(21)}x end`, 'GEMINI_API_KEY=[redacted] end'],
    [`LATCH_TOOL_TOKEN=lbt1.${'b_'.repeat(21)}x end`, 'LATCH_TOOL_TOKEN=[redacted] end'],
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
    ['https://user:token123@git.example.com/org/repo.git', 'https://[redacted]@git.example.com/org/repo.git'],
    ['HTTPS://user:token123@git.example.com', 'HTTPS://[redacted]@git.example.com'],
    ['https://token123@github.com/org/repo', 'https://[redacted]@github.com/org/repo'],
    ['http://user:p@ss@h.example:8080/x', 'http://[redacted]@h.example:8080/x'],
    ['http://user:pw@[::1]:4317/link/', 'http://[redacted]@[::1]:4317/link/'],
    ['postgres://admin:hunter2@db.internal:5432/app', 'postgres://[redacted]@db.internal:5432/app'],
    ['mongodb+srv://a:b@cluster.example/db', 'mongodb+srv://[redacted]@cluster.example/db'],
    ['redis://:hunter2@cache:6379', 'redis://[redacted]@cache:6379'],
    ['git+https://user:token123@git.example.com/r', 'git+https://[redacted]@git.example.com/r'],
    ['postgres://me@corp.example:hunter2@db/app', 'postgres://[redacted]@db/app'],
    ['wss://token123@relay.example/socket', 'wss://[redacted]@relay.example/socket'],
    ['ws://token123@127.0.0.1:4317', 'ws://[redacted]@127.0.0.1:4317'],
    [
      "remote 'https://u:t@a.example' and https://v:w@b.example/x",
      "remote 'https://[redacted]@a.example' and https://[redacted]@b.example/x",
    ],
    ['[repo](https://u:t@a.example/x), https://v:w@b.example', '[repo](https://[redacted]@a.example/x), https://[redacted]@b.example'],
  ])('redacts the userinfo of %s and keeps the rest of the URL', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it.each([
    'https://example.com/path?q=1#top',
    'http://h-abc.localhost:4317/link/',
    'http://[::1]:4317/link/',
    'https://example.com:8443/@scope/pkg',
    'https://www.npmjs.com/package/@latch/sdk',
    'https://medium.com/@someone/post',
    'https://example.com/a?mail=me@example.com',
    'https://example.com#me@example.com',
    'https://example.com and me@example.com',
    '<https://example.com>, me@example.com',
    'git@github.com:org/repo.git',
    'ssh://git@github.com/org/repo.git',
    'ssh://git@github.com:22/org/repo.git',
    'ftp://anonymous@ftp.example/pub',
    'postgres://me@db.example:5432/app',
    'mailto:me@example.com',
    'npm:@latch/sdk@1.2.3',
    'time 12:30 me@example.com',
  ])('leaves the ordinary %s alone', text => {
    expect(redactSecrets(text)).toBe(text)
  })

  it('keeps long text without a userinfo fast', () => {
    const started = performance.now()
    expect(redactSecrets(`https://${'a:'.repeat(100_000)}`)).not.toContain('[redacted]')
    expect(redactSecrets('://'.repeat(100_000))).not.toContain('[redacted]')
    expect(redactSecrets(`wss://${'a@b:'.repeat(100_000)}`)).toContain('[redacted]')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('classifies encoded native pairing payloads and app-open receipts as secrets', () => {
    expect(containsSecret(`LATCHPAIR2.${'a'.repeat(128)}`)).toBe(true)
    expect(containsSecret(`lnw1.${'W'.repeat(43)}`)).toBe(true)
    expect(containsSecret(`lnp1.${'P'.repeat(43)}`)).toBe(true)
    expect(containsSecret(`lmg1.${'T'.repeat(43)}`)).toBe(true)
    expect(containsSecret(`lbt1.${'T'.repeat(43)}`)).toBe(true)
    expect(containsSecret(`LATCHBOOK1.${'B'.repeat(128)}`)).toBe(true)
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
      'postgres://user:password@localhost:5432/app',
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

describe('the page’s copy of the credential shapes', () => {
  it('matches the Host’s, shape for shape, so a draft the Host would call secret stays out of browser storage', () => {
    const shapes = (patterns: readonly RegExp[]) => patterns.map(pattern => `${pattern.source}/${pattern.flags}`)
    expect(shapes([...LATCH_CREDENTIALS, ...CREDENTIAL_KEYS])).toEqual(shapes(CREDENTIALS))
    // Drafts are kept out of storage for everything a log line would lose, carriers included.
    expect(shapes([...LATCH_CREDENTIALS, ...CREDENTIAL_CARRIERS, ...CREDENTIAL_KEYS])).toEqual(shapes(PATTERNS))
    for (const text of ['Cookie: latch_abcdefgh=xyz', 'Latch-Device abc', 'https://x.test/?token=abc', 'https://user:pw@x.test/'])
      expect(looksSecret(text)).toBe(redactSecrets(text) !== text)
    for (const text of ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', 'sk-ant-' + 'a'.repeat(30), 'plain text'])
      expect(pageContainsSecret(text)).toBe(containsSecret(text))
  })
})
