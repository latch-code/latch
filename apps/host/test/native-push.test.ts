import { createDecipheriv, createHmac, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { connect, createServer, type IncomingHttpHeaders } from 'node:http2'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { approvalPresentation, NativePush, pushChange, type PendingPush } from '../src/native-push.ts'
import { appleSender, applePayload, type AppleMessage, type AppleSend } from '../src/apple-push.ts'
import type { DeviceScope, FileDiff } from '@latch/protocol'

const instances: NativePush[] = []

function approvalPreview(...args: Parameters<typeof approvalPresentation>) {
  return approvalPresentation(...args).preview
}

function openPreview(message: Pick<AppleMessage, 'route' | 'ticket' | 'approvalSession'>, key: Buffer): unknown {
  const bytes = Buffer.from(message.approvalSession!, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(`latch-ios-approval-session:v1\n${message.route}\n${message.ticket}`))
  decipher.setAuthTag(bytes.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'))
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.close()))
})

function scenario(deliver?: AppleSend, persist: () => Promise<void> = async () => {}) {
  const route = randomUUID(),
    key = randomBytes(32)
  const messages: AppleMessage[] = []
  const access = new Map<string, { private: boolean; scopes: DeviceScope[] }>([
    ['phone', { private: false, scopes: ['view', 'run', 'approve:standard'] }],
  ])
  const privateNow = new Set<string>()
  const settled = new Set<string>()
  const pending: PendingPush[] = [
    {
      sessionId: 'sensitive-session-name',
      kind: 'approval',
      id: 'decision-A',
      private: false,
      scope: 'approve:standard',
      approvalPreview: approvalPreview(
        { toolName: 'write_file', tool: { diffs: [{ path: 'private-folder/Package.swift', previous: 'none', newText: 'private text' }] } },
        undefined,
        true,
      ),
    },
  ]
  const push = new NativePush(
    {
      pending: async () => pending,
      active: id => access.get(id),
      privateNow: id => privateNow.has(id),
      settledApproval: id => settled.has(id),
    },
    async (message, signal) => {
      messages.push(message)
      return deliver ? deliver(message, signal) : 'accepted'
    },
    key,
    {},
    persist,
  )
  instances.push(push)
  const token = randomBytes(32).toString('hex'),
    start = randomBytes(32).toString('hex')
  const register = (previewKey?: string) => push.change('phone', { route, token, start, ...(previewKey ? { previewKey } : {}) }, () => {})
  return { push, access, pending, privateNow, settled, route, messages, register, token, start }
}

it('projects only known operations and names a known manifest only for a single structured target', () => {
  for (const name of ['Package.swift', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
    expect(approvalPreview({ toolName: 'apply_patch', tool: { locations: [`secret/path/${name}`] } })).toEqual({
      approvalOperation: 'editFile',
      approvalManifest: name,
    })
  }
  const content = { title: 'secret title', input: 'Package.swift', output: 'secret output' }
  for (const locations of [['Package.swift/'], [''], ['secret/path/Settings.swift:24']]) {
    expect(approvalPreview({ toolName: 'write_file', tool: { ...content, locations } })).toEqual({ approvalOperation: 'editFile' })
  }
  expect(
    approvalPreview({ toolName: 'apply_patch', tool: { locations: ['private/a.swift', 'private/b.swift', 'private/c.swift'] } }),
  ).toEqual({
    approvalOperation: 'editFile',
    approvalTargetCount: 3,
    approvalFileType: 'Swift',
  })
  expect(approvalPreview({ toolName: 'apply_patch', tool: { locations: ['private/Package.swift', 'private/a.ts'] } })).toEqual({
    approvalOperation: 'editFile',
    approvalTargetCount: 2,
  })
  expect(
    approvalPreview({
      toolName: 'apply_patch',
      tool: { locations: ['Package.swift'], diffs: [{ path: '/private/Package.swift', newText: 'private diff' }] },
    }),
  ).toEqual({ approvalOperation: 'editFile' })
  const locations = Array.from({ length: 64 }, (_, index) => `private/${index}.swift`)
  expect(approvalPreview({ toolName: 'apply_patch', advisory: true, tool: { locations } })).toEqual({ approvalOperation: 'editFile' })
  expect(
    approvalPreview({ toolName: 'write_file', arguments: JSON.stringify({ path: 'secret/path/config.ts', content: 'private text' }) }),
  ).toEqual({
    approvalOperation: 'editFile',
    approvalTargetCount: 1,
    approvalFileType: 'TypeScript',
  })
  const claude = {
    toolName: 'Edit',
    advisory: true as const,
    tool: { kind: 'edit' as const, input: JSON.stringify({ file_path: 'private/Package.swift', new_string: 'private source' }) },
  }
  expect(approvalPreview(claude, 'claude-agent')).toEqual({
    approvalOperation: 'editFile',
    approvalAgent: 'claude-agent',
    approvalManifest: 'Package.swift',
  })
  expect(approvalPreview(claude, 'custom agent name')).toEqual({ approvalOperation: 'editFile' })
  expect(approvalPreview({ toolName: 'shell', tool: { ...content, kind: 'execute', locations: ['Package.swift'] } })).toEqual({
    approvalOperation: 'runCommand',
  })
  expect(approvalPreview({ toolName: 'unrecognized', tool: content })).toBeUndefined()
})

it('projects complete known commands and separates Codex permission requests from commands', () => {
  const execute = (input: Record<string, unknown>) => ({
    toolName: 'execute',
    tool: { kind: 'execute' as const, input: JSON.stringify(input) },
  })
  for (const command of ['pnpm test', 'swift test', 'git status --short']) {
    expect(approvalPreview(execute({ command }))).toEqual({ approvalOperation: 'runCommand', approvalCommand: command })
  }
  expect(approvalPreview({ ...execute({ command: 'git', args: ['status', '--short'] }), risk: 'R2' })).toEqual({
    approvalOperation: 'runCommand',
    approvalCommand: 'git status --short',
    approvalRisk: 'elevated',
  })
  for (const command of [
    'pnpm test --bad-argument',
    'pnpm test\ntrue',
    'pnpm test > redirect',
    'pnpm test && whoami',
    'pnpm test $(printenv)',
    'TOKEN=secret pnpm test',
  ]) {
    expect(approvalPreview(execute({ command }))).toEqual({ approvalOperation: 'runCommand' })
  }
  expect(approvalPreview({ ...execute({ command: 'pnpm test' }), arguments: JSON.stringify({ command: 'git status' }) })).toEqual({
    approvalOperation: 'runCommand',
  })

  const codex = (input: Record<string, unknown>) => ({ ...execute(input), advisory: true as const, risk: 'R2' as const })
  const request = { command: 'pnpm test', cwd: '/private/path', grants: ['允许后，这条命令在沙箱之外运行'] }
  expect(approvalPreview(codex(request), 'codex')).toEqual({
    approvalOperation: 'runCommand',
    approvalCommand: 'pnpm test',
    approvalOutsideSandbox: true,
    approvalAgent: 'codex',
  })
  expect(approvalPreview(codex({ ...request, network: { host: 'private.example' } }), 'codex')).toEqual({
    approvalOperation: 'allowNetwork',
    approvalAgent: 'codex',
  })
  expect(approvalPreview(codex({ ...request, grantRoot: '/private/path' }), 'codex')).toEqual({
    approvalOperation: 'grantAccess',
    approvalAgent: 'codex',
  })
  expect(approvalPreview(codex({ ...request, grants: ['允许后，Codex 向这个正在运行的命令写入内容'] }), 'codex')).toEqual({
    approvalOperation: 'provideInput',
    approvalAgent: 'codex',
  })
  expect(approvalPreview(codex({ ...request, network: { host: 'private.example' } }), 'cursor')).toEqual({
    approvalOperation: 'runCommand',
    approvalAgent: 'cursor',
  })
})

it('uses only confirmed previous file states from the built-in writer', () => {
  const request = (diff: Partial<FileDiff>, path = 'private/test.swift') => ({
    toolName: 'write_file',
    tool: { locations: [path], diffs: [{ path: 'private/test.swift', newText: 'proposed content', ...diff }] },
  })
  expect(approvalPreview(request({ previous: 'text', oldText: '' }), undefined, true)).toEqual({
    approvalOperation: 'editFile',
    approvalFileChange: 'modify',
    approvalTargetCount: 1,
    approvalFileType: 'Swift',
  })
  for (const diff of [
    {},
    { previous: 'unavailable' },
    { previous: 'text' },
    { previous: 'text', oldText: 'proposed content' },
    { previous: 'none', oldText: 'contradictory content' },
  ] satisfies Partial<FileDiff>[])
    expect(approvalPreview(request(diff), undefined, true)).not.toHaveProperty('approvalFileChange')
  const created = request({ previous: 'none' })
  expect(approvalPreview(created, 'codex')).not.toHaveProperty('approvalFileChange')
  expect(approvalPreview({ ...created, advisory: true }, 'codex', true)).not.toHaveProperty('approvalFileChange')
  expect(approvalPreview(request({ previous: 'none' }, 'other/test.swift'), undefined, true)).not.toHaveProperty('approvalFileChange')
})

it('seals the real session line and a single safe filename to one phone and activity', async () => {
  const approval = (locations: string[]) => ({ toolName: 'apply_patch', advisory: true as const, tool: { locations } })
  const safe = approvalPresentation(approval(['repo/docs/README.md']), 'codex')
  expect(safe.fileName).toBe('README.md')
  expect(approvalPresentation(approval(['repo/AuthView.swift']), 'codex').fileName).toBe('AuthView.swift')
  expect(approvalPresentation(approval(['repo/AuthView.swift'])).fileName).toBeUndefined()
  for (const paths of [
    ['left/README.md', 'right/README.md'],
    ['repo/.env'],
    ['repo/credentials.json'],
    ['repo/.ssh/settings.json'],
    ['repo/notes.txt'],
  ])
    expect(approvalPresentation(approval(paths), 'codex').fileName).toBeUndefined()

  const s = scenario()
  const key = randomBytes(32)
  const title = 'Add Lody to README'
  s.pending[0]!.sessionPreview = { title: `${title}\u200B sk-${'a'.repeat(24)}`, fileName: safe.fileName }
  expect(pushChange.safeParse({ route: s.route, token: s.token, previewKey: randomBytes(33).toString('base64') }).success).toBe(false)
  await s.register(key.toString('base64'))
  await s.push.flush()
  const m = s.messages[0]!
  const payload = applePayload(m, 100)
  expect(payload.aps).toMatchObject({ 'content-state': { approvalSession: m.approvalSession } })
  for (const sensitive of [title, 'README.md', key.toString('base64'), 'repo/docs']) expect(JSON.stringify(m)).not.toContain(sensitive)
  expect(openPreview(m, key)).toEqual({ title: `${title}\\u{200B} [redacted]`, fileName: 'README.md' })
  expect(() => openPreview(m, randomBytes(32))).toThrow()
  expect(() => openPreview({ ...m, route: randomUUID() }, key)).toThrow()
  expect(() => openPreview({ ...m, ticket: 'f'.repeat(32) }, key)).toThrow()
  expect(applePayload({ ...m, kind: 'alert' }, 100).aps).not.toHaveProperty('content-state')
  expect(applePayload({ ...m, kind: 'end' }, 100).aps).toHaveProperty('content-state', {})
  expect(applePayload({ ...m, attention: 'question' }, 100).aps).toHaveProperty('content-state', {})
})

it('includes a public operation in a live start and resolves the opaque decision only on its own phone', async () => {
  const s = scenario()
  s.pending[0]!.sessionPreview = { title: 'Edit the manifest' }
  await s.register()
  await s.push.flush()
  await s.push.flush()
  expect(s.messages).toHaveLength(1)
  const m = s.messages[0]!
  expect(m.kind).toBe('start')
  const payload = applePayload(m, 100)
  expect(m.approvalSession).toBeUndefined()
  expect(payload.aps).toMatchObject({
    'content-state': { approvalOperation: 'editFile', approvalManifest: 'Package.swift', approvalFileChange: 'create' },
  })
  for (const secret of [s.token, s.start, s.pending[0]!.id, s.pending[0]!.sessionId, 'private-folder', 'private text']) {
    expect(JSON.stringify(payload)).not.toContain(secret)
  }
  const extraField = { ...m.approvalPreview!, path: 'private-folder/Package.swift' }
  expect(applePayload({ ...m, approvalPreview: extraField }, 100).aps).toHaveProperty('content-state', {})
  const hint = { route: s.route, ticket: m.ticket }
  expect(await s.push.resolve('phone', hint, () => {})).toEqual(s.pending[0])
  expect(await s.push.resolve('other', hint, () => {})).toBeUndefined()
  s.pending[0] = { ...s.pending[0]!, id: 'decision-B' }
  expect(await s.push.resolve('phone', hint, () => {})).toBeUndefined()
  await s.push.flush()
  expect(s.messages[1]!.ticket).not.toBe(m.ticket)
})
it('applies fresh risk, privacy and device authorization at delivery and at lookup', async () => {
  const s = scenario()
  await s.register()
  s.pending[0]!.scope = 'approve:elevated'
  await s.push.flush()
  expect(s.messages).toHaveLength(0)
  s.access.get('phone')!.scopes.push('approve:elevated')
  s.pending[0]!.private = true
  await s.push.flush()
  expect(s.messages).toHaveLength(0)
  s.access.get('phone')!.private = true
  await s.push.flush()
  expect(s.messages).toHaveLength(1)
  expect(applePayload(s.messages[0]!, 100).aps).toHaveProperty('content-state', {})
  expect(s.messages[0]!.approvalPreview).toBeUndefined()
  const hint = { route: s.route, ticket: s.messages[0]!.ticket }
  s.access.get('phone')!.scopes = ['view', 'run']
  expect(await s.push.resolve('phone', hint, () => {})).toBeUndefined()
  s.access.delete('phone')
  expect(await s.push.resolve('phone', hint, () => {})).toBeUndefined()
  await s.push.remove('phone')
  await s.push.flush()
  expect(s.messages).toHaveLength(1)
})
it('uses the Host receipt even when driver detail still shows the settled request', async () => {
  const s = scenario()
  await s.register()
  await s.push.flush()
  const first = s.messages[0]!
  const hint = { route: s.route, ticket: first.ticket }
  const update = randomBytes(32).toString('hex')
  await s.push.change('phone', { ...hint, update }, () => {})
  const resolving = s.push.resolve('phone', hint, () => {})
  s.settled.add(s.pending[0]!.id)
  expect(await resolving).toBeUndefined()
  await s.push.flush()
  expect(s.messages[1]).toMatchObject({ kind: 'end', token: update, ticket: hint.ticket })
  await s.push.flush()
  expect(s.messages).toHaveLength(2)

  s.pending.push({ ...s.pending[0]!, id: 'decision-B' })
  await s.push.flush()
  expect(s.messages[2]!.ticket).not.toBe(hint.ticket)
  expect(await s.push.resolve('phone', hint, () => {})).toBeUndefined()
})
it('withdraws an in-flight sealed preview if a session becomes private, even for a phone that can read private sessions', async () => {
  let ready!: (signal: AbortSignal) => void, accept!: () => void
  const started = new Promise<AbortSignal>(resolve => {
    ready = resolve
  })
  const s = scenario((message, signal) =>
    message.approvalSession
      ? new Promise(resolve => {
          accept = () => resolve('accepted')
          ready(signal)
        })
      : Promise.resolve('accepted'),
  )
  s.access.get('phone')!.private = true
  s.pending[0]!.approvalPreview = undefined
  s.pending[0]!.sessionPreview = { title: 'Session about to go private' }
  await s.register(randomBytes(32).toString('base64'))
  const inflight = s.push.flush()
  const signal = await started
  s.privateNow.add(s.pending[0]!.sessionId)
  s.push.schedule()
  expect(signal.aborted).toBe(true)
  accept()
  await inflight
  await s.push.flush()
  expect(s.messages).toHaveLength(2)
  expect(s.messages[1]!.approvalPreview).toBeUndefined()
  expect(s.messages[1]!.approvalSession).toBeUndefined()
  expect(applePayload(s.messages[1]!, 100).aps).toHaveProperty('content-state', {})
})
it('cancels an in-flight preview when the phone rotates its preview key on the same route', async () => {
  let begin!: (signal: AbortSignal) => void, finish!: () => void
  const started = new Promise<AbortSignal>(resolve => {
    begin = resolve
  })
  let attempts = 0
  const s = scenario(async (_message, signal) => {
    if (++attempts === 1)
      await new Promise<void>(resolve => {
        finish = resolve
        begin(signal)
      })
    return 'accepted'
  })
  const rotatedKey = randomBytes(32)
  s.pending[0]!.sessionPreview = { title: 'Verify project' }
  await s.register(randomBytes(32).toString('base64'))
  const inflight = s.push.flush()
  const signal = await started
  await s.register(rotatedKey.toString('base64'))
  expect(signal.aborted).toBe(true)
  finish()
  await inflight
  await s.push.flush()
  expect(s.messages).toHaveLength(2)
  expect(s.messages[1]!.ticket).toBe(s.messages[0]!.ticket)
  expect(openPreview(s.messages[1]!, rotatedKey)).toEqual({ title: 'Verify project' })
})
it('ends an activity using its own rotated update token when the question settles', async () => {
  const s = scenario()
  s.pending[0] = { ...s.pending[0]!, kind: 'question', scope: 'run' }
  await s.register()
  await s.push.flush()
  const first = s.messages[0]!,
    update = randomBytes(32).toString('hex')
  await s.push.change('phone', { route: s.route, ticket: first.ticket, update }, () => {})
  s.pending.length = 0
  await s.push.flush()
  expect(s.messages[1]).toMatchObject({ kind: 'end', token: update, ticket: first.ticket })
  expect(await s.push.resolve('phone', first, () => {})).toBeUndefined()
})
it('falls back to normal Apple alerts on a permanent start-token rejection, with no duplicate on refresh', async () => {
  const s = scenario(async m => (m.kind === 'start' ? 'invalid' : 'accepted'))
  await s.register()
  await s.push.flush()
  await s.push.flush()
  await s.push.flush()
  expect(s.messages.map(m => m.kind)).toEqual(['start', 'alert'])
  expect(applePayload(s.messages[1]!, 100).aps).not.toHaveProperty('content-state')
})
it('does not transmit after a failed registration write', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  const s = scenario(undefined, save)
  await expect(s.register()).rejects.toThrow('disk full')
  await s.push.flush()
  expect(s.messages).toEqual([])
})

it('signs a real HTTP/2 request for the fixed Apple sandbox topic, and processes the APNs reply without a real account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'latch-test-apple-push-'))
  const server = createServer()
  try {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const identity = join(dir, 'identity')
    await mkdir(identity, { mode: 0o700 })
    await writeFile(
      join(identity, 'apns.json'),
      JSON.stringify({
        environment: 'sandbox',
        teamId: 'ABCDEFGHIJ',
        keyId: '1234567890',
        privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      }),
      { mode: 0o600 },
    )
    let headers: IncomingHttpHeaders = {}
    const payloads: string[] = []
    server.on('stream', (stream, received) => {
      headers = received
      let payload = ''
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        payload += chunk
      })
      stream.on('end', () => {
        payloads.push(payload)
        stream.respond({ ':status': 200 })
        stream.end()
      })
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test listener unavailable')
    const local: typeof connect = origin => {
      expect(origin).toBe('https://api.sandbox.push.apple.com')
      return connect('http://127.0.0.1:' + address.port)
    }
    const send = await appleSender(dir, local)
    const token = randomBytes(32).toString('hex')
    const message: AppleMessage = {
      kind: 'start',
      attention: 'approval',
      token,
      route: randomUUID(),
      ticket: randomBytes(16).toString('hex'),
      approvalPreview: approvalPreview(
        { toolName: 'execute', tool: { kind: 'execute', input: JSON.stringify({ command: 'swift test', cwd: '/private/work' }) } },
        'codex',
      ),
    }
    expect(await send!(message, new AbortController().signal)).toBe('accepted')
    expect(headers['apns-topic']).toBe('codes.latch.ios.push-type.liveactivity')
    expect(headers['apns-push-type']).toBe('liveactivity')
    expect(headers[':path'] === '/3/device/' + token).toBe(true)
    const [head, claims, signature] = String(headers.authorization)
      .replace(/^bearer /u, '')
      .split('.')
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: '1234567890' })
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString()).iss).toBe('ABCDEFGHIJ')
    expect(
      verify(
        'sha256',
        Buffer.from(head + '.' + claims),
        { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true)
    expect(JSON.parse(payloads[0]!).aps).toMatchObject({
      event: 'start',
      'attributes-type': 'LatchQuestionAttributes',
      attributes: { approval: true, route: message.route, ticket: message.ticket },
      'content-state': { approvalOperation: 'runCommand', approvalCommand: 'swift test', approvalAgent: 'codex' },
    })
    expect(payloads[0]).not.toContain('/private/work')

    // Reopen the real vault and send both restored registrations to the local fake Apple service.
    const wait: PendingPush = {
      kind: 'approval',
      id: 'private-decision',
      sessionId: 'private-session',
      private: false,
      scope: 'approve:standard',
      sessionPreview: { title: 'Run project checks' },
    }
    const options = {
      active: () => ({ private: true, scopes: ['view', 'run', 'approve:standard'] as DeviceScope[] }),
      settledApproval: () => false,
      pending: async () => [wait],
    }
    const route = randomUUID(),
      device = 'phone-test'
    const initial = await NativePush.open(dir, options, local)
    const previewKey = randomBytes(32).toString('base64')
    const legacyRoute = randomUUID()
    await initial!.change(device, { route, token, start: randomBytes(32).toString('hex'), previewKey }, () => {})
    await initial!.change(
      'old-phone',
      { route: legacyRoute, token: randomBytes(32).toString('hex'), start: randomBytes(32).toString('hex') },
      () => {},
    )
    await initial!.close()
    const privateStore = join(identity, 'apns-devices.enc')
    expect((await stat(privateStore)).mode & 0o077).toBe(0)
    const file = Buffer.from(await readFile(privateStore, 'utf8'), 'base64')
    expect(file.includes(token)).toBe(false)
    expect(file.includes(previewKey)).toBe(false)
    const key = Buffer.from(await readFile(join(identity, 'apns-devices.key'), 'utf8'), 'base64')
    const ticket = createHmac('sha256', key)
      .update(JSON.stringify([device, route, wait.sessionId, wait.kind, wait.id]))
      .digest('hex')
      .slice(0, 32)
    const restored = await NativePush.open(dir, options, local)
    expect(await restored!.resolve(device, { route, ticket }, () => {})).toEqual(wait)
    await restored!.flush()
    expect(payloads).toHaveLength(3)
    const starts = payloads.slice(1).map(body => JSON.parse(body).aps)
    const current = starts.find(aps => aps.attributes.route === route)
    expect(
      openPreview({ route, ticket, approvalSession: current['content-state'].approvalSession }, Buffer.from(previewKey, 'base64')),
    ).toEqual(wait.sessionPreview)
    expect(starts.find(aps => aps.attributes.route === legacyRoute)['content-state']).toEqual({})
    await restored!.change(device, { disabled: true }, () => {})
    await restored!.close()
    const disabled = await NativePush.open(dir, options, local)
    expect(await disabled!.resolve(device, { route, ticket }, () => {})).toBeUndefined()
    await disabled!.close()
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    await rm(dir, { recursive: true, force: true })
  }
})

it('cancels an in-flight request on removal and never uses its late result', async () => {
  let ready!: () => void, finish!: (result: 'accepted') => void, signal: AbortSignal | undefined
  const started = new Promise<void>(resolve => {
    ready = resolve
  })
  const s = scenario((_message, current) => {
    signal = current
    ready()
    return new Promise(resolve => {
      finish = resolve
    })
  })
  await s.register()
  const inflight = s.push.flush()
  await started
  s.access.get('phone')!.scopes = ['view']
  s.push.schedule()
  expect(signal?.aborted).toBe(true)
  await s.push.remove('phone')
  expect(signal?.aborted).toBe(true)
  finish('accepted')
  await inflight
  const m = s.messages[0]!
  expect(await s.push.resolve('phone', m, () => {})).toBeUndefined()
})

it('backs off a temporary Apple failure and rechecks that the decision still exists before retrying', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(20_000)
  try {
    const s = scenario(async () => 'retry')
    await s.register()
    await s.push.flush()
    clock.mockReturnValue(20_100)
    await s.push.flush()
    expect(s.messages).toHaveLength(1)
    s.pending.length = 0
    clock.mockReturnValue(52_000)
    await s.push.flush()
    expect(s.messages).toHaveLength(1)
  } finally {
    clock.mockRestore()
  }
})
