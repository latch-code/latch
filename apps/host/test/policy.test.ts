import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { AuditLog, verifyAuditFile, type AuditFs } from '../src/audit.ts'
import {
  PolicyStore,
  ceilingFor,
  defaultPolicy,
  isConfirmedAddressEntry,
  isEgressEntry,
  isLowering,
  policyDiff,
  policySchema,
  type Policy,
} from '../src/policy.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(platform: NodeJS.Platform = 'darwin', auditFs?: AuditFs) {
  const dataDir = mkdtempSync(join(tmpdir(), 'latch-policy-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const audit = await AuditLog.open(join(dataDir, 'audit'), auditFs ? { fs: auditFs } : {})
  cleanups.push(() => audit.close())
  return { dataDir, audit, open: () => PolicyStore.open({ dataDir, audit, platform }) }
}

function records(dataDir: string) {
  return readFileSync(join(dataDir, 'audit', 'audit.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line))
}

function edit(policy: Policy, change: (draft: Policy) => void): Policy {
  const draft = structuredClone(policy)
  change(draft)
  return draft
}

describe('policy defaults and schema', () => {
  it('uses the macOS helper on darwin and no presence backend elsewhere', () => {
    expect(defaultPolicy('darwin')).toEqual({
      version: 1,
      local: { maxLevel: 'L2', allowL3: true },
      remote: { maxLevel: 'L1', allowRemoteStart: true, harnesses: ['standard'], workspaces: null, allowInstall: false },
      insecureLan: { enabled: false },
      operators: [],
      presence: { backend: 'macos-helper', helperCdhash: null },
      hostEgressAllow: [],
      confirmedAddresses: [],
      keyBackend: 'file',
      unattended: { maxLevel: 'L1', allowAutoApproveRules: false, approvalTtlHours: { standard: 8, acp: 1 }, pauseAfterIdleDays: 14 },
    })
    expect(defaultPolicy('linux').presence.backend).toBe('none')
    expect(policySchema.safeParse(defaultPolicy('linux')).success).toBe(true)
  })

  it('rejects unknown keys, L3 ceilings, remote install and malformed egress entries', () => {
    const base = defaultPolicy('darwin')
    const bad = (change: (draft: Record<string, any>) => void) => {
      const draft = structuredClone(base) as Record<string, any>
      change(draft)
      return policySchema.safeParse(draft).success
    }
    expect(
      bad(draft => {
        draft.extra = true
      }),
    ).toBe(false)
    expect(
      bad(draft => {
        draft.local.maxLevel = 'L3'
      }),
    ).toBe(false)
    expect(
      bad(draft => {
        draft.remote.allowInstall = true
      }),
    ).toBe(false)
    expect(
      bad(draft => {
        draft.insecureLan.enabled = true
      }),
    ).toBe(false)
    expect(
      bad(draft => {
        draft.keyBackend = 'keychain'
      }),
    ).toBe(false)
    expect(
      bad(draft => {
        draft.presence.helperCdhash = 'ABC'
      }),
    ).toBe(false)
    expect(
      bad(draft => {
        draft.hostEgressAllow = ['localhost:11434', 'localhost:11434']
      }),
    ).toBe(false)
    expect(
      bad(draft => {
        draft.hostEgressAllow = Array.from({ length: 65 }, (_, index) => `h${index}.lan:80`)
      }),
    ).toBe(false)
    expect(
      bad(draft => {
        draft.hostEgressAllow = ['localhost:11434', '127.0.0.1:8080', '[::1]:8080', 'my-box.lan:443']
      }),
    ).toBe(true)
  })

  it.each([
    ['localhost:11434', true],
    ['127.0.0.1:1', true],
    ['[::1]:8080', true],
    ['[fd7a:115c:a1e0::1]:443', true],
    ['a.b-c.example:65535', true],
    ['localhost', false],
    ['LOCALHOST:80', false],
    ['::1:80', false],
    ['[::1]', false],
    ['host:0', false],
    ['host:65536', false],
    ['host:080', false],
    ['http://host:80', false],
    ['host:80/path', false],
    ['-bad.host:80', false],
    ['host_name:80', false],
    ['[zz::1]:80', false],
  ])('egress entry %s → %s', (entry, expected) => {
    expect(isEgressEntry(entry)).toBe(expected)
  })
})

describe('isLowering', () => {
  const base = defaultPolicy('darwin')
  it.each<[string, (draft: Policy) => void, boolean]>([
    ['no change', () => {}, true],
    [
      'local L2 → L1',
      draft => {
        draft.local.maxLevel = 'L1'
      },
      true,
    ],
    [
      'local L2 → L0 and L3 off',
      draft => {
        draft.local.maxLevel = 'L0'
        draft.local.allowL3 = false
      },
      true,
    ],
    [
      'remote L1 → L2',
      draft => {
        draft.remote.maxLevel = 'L2'
      },
      false,
    ],
    [
      'remote start off',
      draft => {
        draft.remote.allowRemoteStart = false
      },
      true,
    ],
    [
      'harnesses list → subset',
      draft => {
        draft.remote.harnesses = []
      },
      true,
    ],
    [
      'harnesses list → any',
      draft => {
        draft.remote.harnesses = null
      },
      false,
    ],
    [
      'harnesses list → other',
      draft => {
        draft.remote.harnesses = ['codex']
      },
      false,
    ],
    [
      'workspaces any → list',
      draft => {
        draft.remote.workspaces = ['default']
      },
      true,
    ],
    [
      'egress add',
      draft => {
        draft.hostEgressAllow = ['localhost:11434']
      },
      false,
    ],
    [
      'presence backend',
      draft => {
        draft.presence.backend = 'none'
      },
      false,
    ],
    [
      'presence pin',
      draft => {
        draft.presence.helperCdhash = 'a'.repeat(40)
      },
      false,
    ],
    [
      'unattended',
      draft => {
        draft.unattended.pauseAfterIdleDays = 7
      },
      false,
    ],
    [
      'lower one, raise another',
      draft => {
        draft.local.maxLevel = 'L1'
        draft.remote.maxLevel = 'L2'
      },
      false,
    ],
  ])('%s → %s', (_name, change, expected) => {
    expect(isLowering(base, edit(base, change))).toBe(expected)
  })

  it('treats removing a confirmed model-service address as lowering and adding one as raising', () => {
    const wide = edit(base, draft => {
      draft.confirmedAddresses = ['https://gateway.example:443/v1/acct-1/openai', 'http://127.0.0.1:11434/v1']
    })
    const removed = edit(wide, draft => {
      draft.confirmedAddresses = ['http://127.0.0.1:11434/v1']
    })
    expect(isLowering(wide, removed)).toBe(true)
    expect(isLowering(removed, wide)).toBe(false)
    // A file from before the field existed: recording none is no change in what may be used, and adding one raises.
    const legacy = edit(base, draft => {
      delete draft.confirmedAddresses
    })
    expect(
      isLowering(
        legacy,
        edit(legacy, draft => void (draft.confirmedAddresses = [])),
      ),
    ).toBe(true)
    expect(isLowering(legacy, wide)).toBe(false)
  })

  it('accepts only canonical model-service addresses (an origin and its path), without duplicates', () => {
    for (const entry of [
      'https://api.example.com:443',
      'http://127.0.0.1:11434',
      'http://[::1]:8080',
      'https://xn--fiq228c.com:443',
      'http://127.0.0.1:11434/v1',
      'https://gateway.example:443/v1/acct-1/openai',
      'https://gateway.example:443/v1/%E6%A8%A1%E5%9E%8B',
    ])
      expect(isConfirmedAddressEntry(entry), entry).toBe(true)
    for (const entry of [
      'https://api.example.com',
      'https://API.example.com:443',
      'https://api.example.com:443/',
      'https://api.example.com:443/v1/',
      'https://api.example.com:443/v1/../v2',
      'https://api.example.com:443/v1?tenant=a',
      'https://api.example.com:443/v1#a',
      'https://api.example.com:443/v 1',
      'ftp://api.example.com:21',
      'https://user@api.example.com:443',
      'https://api.example.com:0',
      '127.0.0.1:11434',
      `https://api.example.com:443/${'a'.repeat(2400)}`,
    ])
      expect(isConfirmedAddressEntry(entry), entry).toBe(false)
    const parse = (confirmedAddresses: unknown) => policySchema.safeParse({ ...defaultPolicy('darwin'), confirmedAddresses }).success
    expect(parse(['http://127.0.0.1:11434'])).toBe(true)
    expect(parse(['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434'])).toBe(true)
    expect(parse(['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'])).toBe(false)
    expect(parse(['http://127.0.0.1:11434/v1/'])).toBe(false)
    expect(parse(undefined)).toBe(true)
  })

  it('treats removing egress entries and re-enabling L3 correctly', () => {
    const wide = edit(base, draft => {
      draft.hostEgressAllow = ['a.lan:80', 'b.lan:80']
      draft.local.allowL3 = false
    })
    expect(
      isLowering(
        wide,
        edit(wide, draft => {
          draft.hostEgressAllow = ['b.lan:80']
        }),
      ),
    ).toBe(true)
    expect(
      isLowering(
        wide,
        edit(wide, draft => {
          draft.local.allowL3 = true
        }),
      ),
    ).toBe(false)
  })

  it('describes changes as display lines', () => {
    const next = edit(base, draft => {
      draft.local.maxLevel = 'L1'
      draft.hostEgressAllow = ['localhost:11434']
    })
    expect(policyDiff(base, next)).toEqual([
      { path: 'hostEgressAllow', before: '[]', after: '["localhost:11434"]' },
      { path: 'local.maxLevel', before: 'L2', after: 'L1' },
    ])
  })
})

describe('ceilingFor', () => {
  it('uses the local ceiling only for host.sock', () => {
    const policy = defaultPolicy('darwin')
    expect(ceilingFor(policy, 'unix')).toBe('L2')
    expect(ceilingFor(policy, 'loopback-tcp')).toBe('L1')
    expect(ceilingFor(policy, 'lan-tls')).toBe('L1')
    expect(ceilingFor(policy, 'tailnet-tls')).toBe('L1')
  })
})

describe('PolicyStore', () => {
  it('creates the default policy once and audits its creation', async () => {
    const { dataDir, open } = await fixture('linux')
    const store = await open()
    expect(store.get()).toEqual(defaultPolicy('linux'))
    expect(store.hash()).toBe(sha256Hex(canonicalJson(defaultPolicy('linux'))))
    expect(JSON.parse(readFileSync(join(dataDir, 'policy.json'), 'utf8'))).toEqual(defaultPolicy('linux'))
    expect(statSync(join(dataDir, 'policy.json')).mode & 0o777).toBe(0o600)
    expect(records(dataDir).map(record => [record.action, record.detail])).toEqual([
      ['policy.created', { before: '', after: store.hash(), fields: [], lowering: false }],
    ])
    const copy = store.get()
    copy.local.maxLevel = 'L0'
    expect(store.get().local.maxLevel).toBe('L2')
    await open()
    expect(records(dataDir)).toHaveLength(1)
  })

  it('audits before writing, and requires a step-up for raising changes', async () => {
    const { dataDir, open } = await fixture()
    const store = await open()
    const actor = { deviceId: `dev_${'B'.repeat(22)}`, listener: 'loopback-tcp' as const, via: 'http' as const }
    const lowered = edit(store.get(), draft => {
      draft.remote.maxLevel = 'L0'
    })
    await store.update(lowered, actor, 'none')
    const raised = edit(store.get(), draft => {
      draft.hostEgressAllow = ['localhost:11434']
    })
    await expect(store.update(raised, actor, 'none')).rejects.toMatchObject({ status: 403, code: 'stepup-required' })
    await store.update(raised, { ...actor, listener: 'unix' }, 'lpc-local')
    await expect(store.update({ ...raised, local: { maxLevel: 'L3', allowL3: true } } as never, actor, 'lpc-local')).rejects.toMatchObject({
      status: 400,
      code: 'invalid-policy',
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'policy.json'), 'utf8'))).toEqual(raised)
    const changes = records(dataDir).filter(record => record.action === 'policy.changed')
    expect(changes.map(record => [record.detail.fields, record.detail.lowering, record.stepup])).toEqual([
      [['remote.maxLevel'], true, 'none'],
      [['hostEgressAllow'], false, 'lpc-local'],
    ])
    expect(changes[1].detail.after).toBe(store.hash())
    expect(await verifyAuditFile(join(dataDir, 'audit', 'audit.jsonl'))).toMatchObject({ ok: true })
  })

  it('detects and audits edits made outside Latch, without blocking', async () => {
    const { dataDir, audit, open } = await fixture()
    const store = await open()
    await audit.append({
      action: 'host.started',
      actor: { listener: 'host', via: 'startup' },
      detail: { hostId: 'a'.repeat(52), version: '0.1.0', policyHash: store.hash(), settingsHash: sha256Hex(''), devMode: true },
    })
    await open()
    expect(records(dataDir).some(record => record.action === 'policy.changed-outside')).toBe(false)
    const edited = edit(store.get(), draft => {
      draft.remote.maxLevel = 'L2'
    })
    writeFileSync(join(dataDir, 'policy.json'), JSON.stringify(edited))
    const reopened = await open()
    expect(reopened.get().remote.maxLevel).toBe('L2')
    expect(reopened.warnings).toEqual(['policy.json 在 Latch 之外被修改过，已记入审计。'])
    const outside = records(dataDir).filter(record => record.action === 'policy.changed-outside')
    expect(outside.map(record => record.detail)).toEqual([{ expected: store.hash(), actual: reopened.hash() }])
  })

  it('fills confirmed addresses once in a file from before they existed, audited, without a changed-outside record', async () => {
    const { dataDir, audit, open } = await fixture()
    const store = await open()
    // The previous build's file: everything but confirmedAddresses, and the Host's own record of its hash.
    const legacy = edit(store.get(), draft => {
      delete draft.confirmedAddresses
      draft.hostEgressAllow = ['127.0.0.1:11434']
    })
    writeFileSync(join(dataDir, 'policy.json'), JSON.stringify(legacy))
    await audit.append({
      action: 'host.started',
      actor: { listener: 'host', via: 'startup' },
      detail: {
        hostId: 'a'.repeat(52),
        version: '0.1.0',
        policyHash: sha256Hex(canonicalJson(legacy)),
        settingsHash: sha256Hex(''),
        devMode: true,
      },
    })
    const reopened = await open()
    expect(reopened.warnings).toEqual([])
    expect(reopened.needsAddressMigration).toBe(true)
    expect(reopened.get()).not.toHaveProperty('confirmedAddresses')
    await reopened.migrateConfirmedAddresses(['http://127.0.0.1:11434/v1', 'https://gateway.example:443', 'not an address'])
    expect(reopened.needsAddressMigration).toBe(false)
    expect(reopened.get().confirmedAddresses).toEqual(['http://127.0.0.1:11434/v1', 'https://gateway.example:443'])
    expect(records(dataDir).at(-1)).toMatchObject({
      action: 'policy.changed',
      actor: { listener: 'host', via: 'startup' },
      stepup: 'none',
      detail: { fields: ['confirmedAddresses'], lowering: false, after: reopened.hash() },
    })
    // Once the field exists the upgrade never adds anything again, and the next start sees no outside change.
    await reopened.migrateConfirmedAddresses(['https://later.example:443'])
    expect(reopened.get().confirmedAddresses).toEqual(['http://127.0.0.1:11434/v1', 'https://gateway.example:443'])
    const again = await open()
    expect(again.warnings).toEqual([])
    expect(again.get().confirmedAddresses).toEqual(['http://127.0.0.1:11434/v1', 'https://gateway.example:443'])
    expect(records(dataDir).some(record => record.action === 'policy.changed-outside')).toBe(false)
  })

  it('refuses plaintext LAN, reports corrupt files, and ignores operators with a warning', async () => {
    const { dataDir, open } = await fixture()
    await open()
    const path = join(dataDir, 'policy.json')
    const valid = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...valid, insecureLan: { enabled: true } }))
    await expect(open()).rejects.toMatchObject({
      status: 500,
      code: 'insecure-lan-removed',
      message: expect.stringContaining('明文局域网接入已移除'),
    })
    writeFileSync(path, '{broken')
    await expect(open()).rejects.toMatchObject({ code: 'policy-invalid' })
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    writeFileSync(path, JSON.stringify({ ...valid, local: { maxLevel: 'L9', allowL3: true } }))
    await expect(open()).rejects.toMatchObject({ code: 'policy-invalid' })
    writeFileSync(path, JSON.stringify({ ...valid, operators: [{ user: 'ops' }] }))
    const store = await open()
    expect(store.warnings).toContain('policy.json 中的 operators 已忽略：无界面确认通道尚未实现。')
  })

  it('pins the presence helper once (trust on first use)', async () => {
    const { dataDir, open } = await fixture()
    const store = await open()
    await store.pinHelperCdhash('a'.repeat(40))
    await store.pinHelperCdhash('a'.repeat(40))
    expect(store.get().presence.helperCdhash).toBe('a'.repeat(40))
    await expect(store.pinHelperCdhash('b'.repeat(40))).rejects.toMatchObject({ code: 'presence-already-pinned' })
    await expect(store.pinHelperCdhash('xyz')).rejects.toMatchObject({ code: 'presence-cdhash-invalid' })
    const actions = records(dataDir).map(record => record.action)
    expect(actions).toEqual(['policy.created', 'presence.helper.pinned', 'policy.changed'])
    // The pin is a known change: reopening does not report an outside edit.
    await open()
    expect(records(dataDir).map(record => record.action)).not.toContain('policy.changed-outside')
  })

  it('applies a confirmed change only while the policy still hashes to the base it was confirmed against', async () => {
    const { dataDir, open } = await fixture()
    const store = await open()
    const actor = { listener: 'unix' as const, via: 'http' as const }
    const changed = expect.objectContaining({ status: 409, code: 'policy-changed', message: '安全策略已被修改，请刷新后重试' })
    const base = store.hash()
    const lowered = edit(store.get(), draft => {
      draft.remote.maxLevel = 'L0'
    })
    await expect(store.update(lowered, actor, 'none', 'f'.repeat(64))).rejects.toEqual(changed)
    expect(store.hash()).toBe(base)

    // Both confirmed against the same base: the first commits on the queue, the second no longer matches.
    const raised = edit(store.get(), draft => {
      draft.hostEgressAllow = ['localhost:11434']
    })
    const [first, second] = await Promise.allSettled([
      store.update(lowered, actor, 'none', base),
      store.update(raised, actor, 'lpc-local', base),
    ])
    expect(first).toEqual({ status: 'fulfilled', value: { audited: true } })
    expect(second).toEqual({ status: 'rejected', reason: changed })
    expect(store.get()).toMatchObject({ remote: { maxLevel: 'L0' }, hostEgressAllow: [] })

    // The startup pin runs on the same queue, so a change confirmed against the unpinned policy is refused after it.
    const unpinned = store.hash()
    const pin = store.pinHelperCdhash('a'.repeat(40))
    await expect(
      store.update(
        edit(store.get(), draft => {
          draft.local.allowL3 = false
        }),
        actor,
        'none',
        unpinned,
      ),
    ).rejects.toEqual(changed)
    await pin
    expect(store.get()).toMatchObject({ local: { allowL3: true }, presence: { helperCdhash: 'a'.repeat(40) } })
    await expect(
      store.update(
        edit(store.get(), draft => {
          draft.local.allowL3 = false
        }),
        actor,
        'none',
        store.hash(),
      ),
    ).resolves.toEqual({ audited: true })
    expect(records(dataDir).filter(record => record.action === 'policy.changed')).toHaveLength(3)
  })
})

describe('PolicyStore when the audit log fails or policy.json disappears', () => {
  /** fsync after a write fails while `failing` is set; the cut-back succeeds, so the log recovers. */
  function switchableAudit(): { fs: AuditFs; state: { failing: boolean } } {
    const state = { failing: false }
    return {
      state,
      fs: {
        async open(path) {
          const handle = await openFile(path, 'a', 0o600)
          let written = false
          return {
            write: data => {
              written = true
              return handle.write(data)
            },
            sync: async () => {
              const afterWrite = written
              written = false
              if (state.failing && afterWrite) throw Object.assign(new Error('EIO'), { code: 'EIO' })
              await handle.sync()
            },
            truncate: length => handle.truncate(length),
            close: () => handle.close(),
          }
        },
      },
    }
  }

  it('applies a lowering change while the audit log fails, and still refuses raising ones', async () => {
    const audit = switchableAudit()
    const { dataDir, open } = await fixture('darwin', audit.fs)
    const store = await open()
    const actor = { deviceId: `dev_${'B'.repeat(22)}`, listener: 'loopback-tcp' as const, via: 'http' as const }
    audit.state.failing = true
    const lowered = edit(store.get(), draft => {
      draft.remote.maxLevel = 'L0'
      draft.remote.allowRemoteStart = false
    })
    await expect(store.update(lowered, actor, 'none')).resolves.toEqual({ audited: false })
    expect(store.get()).toEqual(lowered)
    expect(JSON.parse(readFileSync(join(dataDir, 'policy.json'), 'utf8'))).toEqual(lowered)
    const raised = edit(store.get(), draft => {
      draft.remote.maxLevel = 'L1'
    })
    await expect(store.update(raised, { ...actor, listener: 'unix' }, 'lpc-local')).rejects.toMatchObject({
      status: 503,
      code: 'audit-unavailable',
    })
    expect(store.get()).toEqual(lowered)
    await expect(store.pinHelperCdhash('a'.repeat(40))).rejects.toMatchObject({ code: 'audit-unavailable' })
    expect(store.get().presence.helperCdhash).toBeNull()

    audit.state.failing = false
    // The unaudited change surfaces on the next start as a change made outside the audit trail.
    const reopened = await open()
    expect(reopened.get()).toEqual(lowered)
    expect(records(dataDir).map(record => [record.action, record.detail])).toEqual([
      ['policy.created', { before: '', after: sha256Hex(canonicalJson(defaultPolicy('darwin'))), fields: [], lowering: false }],
      ['policy.changed-outside', { expected: sha256Hex(canonicalJson(defaultPolicy('darwin'))), actual: reopened.hash() }],
    ])
    await expect(
      reopened.update(
        edit(reopened.get(), draft => {
          draft.local.allowL3 = false
        }),
        actor,
        'none',
      ),
    ).resolves.toEqual({ audited: true })
  })

  it('records a deleted policy.json as changed outside Latch before recreating the defaults', async () => {
    const { dataDir, open } = await fixture()
    const store = await open()
    const lowered = edit(store.get(), draft => {
      draft.remote.allowRemoteStart = false
    })
    await store.update(lowered, { listener: 'unix', via: 'http' }, 'none')
    unlinkSync(join(dataDir, 'policy.json'))
    const recreated = await open()
    expect(recreated.get()).toEqual(defaultPolicy('darwin'))
    expect(recreated.warnings).toEqual(['policy.json 在 Latch 之外被删除，已按默认值重建并记入审计。'])
    const tail = records(dataDir).slice(-2)
    expect(tail.map(record => [record.action, record.detail])).toEqual([
      ['policy.changed-outside', { expected: sha256Hex(canonicalJson(lowered)), actual: recreated.hash() }],
      ['policy.created', { before: '', after: recreated.hash(), fields: [], lowering: false }],
    ])
  })

  it('does not pin the presence helper again on its own after the pin was lost', async () => {
    const { dataDir, open } = await fixture()
    const store = await open()
    await store.pinHelperCdhash('a'.repeat(40))
    unlinkSync(join(dataDir, 'policy.json'))
    const recreated = await open()
    await expect(recreated.pinHelperCdhash('b'.repeat(40))).rejects.toMatchObject({ status: 409, code: 'presence-repin-required' })
    expect(recreated.get().presence.helperCdhash).toBeNull()
    // The offline repin path still works.
    await recreated.update(
      edit(recreated.get(), draft => {
        draft.presence.helperCdhash = 'b'.repeat(40)
      }),
      { listener: 'cli', via: 'cli' },
      'offline',
    )
    expect(recreated.get().presence.helperCdhash).toBe('b'.repeat(40))
  })
})
