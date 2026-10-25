import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, CurrentDevice, DeviceScope, PermissionLevel } from '@latch/protocol'
import { defaultPolicy, isLowering, type Policy } from '@latch/host/policy'
import {
  applyPatch,
  changePolicy,
  isEgressTarget,
  localLadder,
  localLadderPatch,
  localNote,
  parsePolicy,
  remoteLadderPatch,
  remoteListPatch,
  remoteNote,
  toggledList,
  widens,
  type PolicyPatch,
  type PolicyView,
} from '../src/core/ceilings.ts'
import { deviceAccess } from '../src/core/permissions.ts'
import { ComputerSettings } from '../src/settings/ComputerSettings.tsx'
import { SETTINGS_ADMIN_HIDDEN } from '../src/core/securityCopy.ts'
import { hiddenSectionsCaption, SettingsPage, settingsSections } from '../src/settings/SettingsPage.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
})

const view = (stored: Policy): PolicyView => parsePolicy(stored)!

/** What the Host's PATCH handler does with a body: the same merge, before it judges the change. */
function hostPatched(base: Policy, patch: PolicyPatch): Policy {
  const next = structuredClone(base)
  if (patch.local) Object.assign(next.local, patch.local)
  if (patch.remote) Object.assign(next.remote, patch.remote)
  if (patch.hostEgressAllow) {
    const remove = new Set(patch.hostEgressAllow.remove ?? [])
    next.hostEgressAllow = [...new Set([...next.hostEgressAllow.filter(entry => !remove.has(entry)), ...(patch.hostEgressAllow.add ?? [])])]
  }
  if (patch.confirmedAddresses) {
    const remove = new Set(patch.confirmedAddresses.remove)
    next.confirmedAddresses = (next.confirmedAddresses ?? []).filter(origin => !remove.has(origin))
  }
  return next
}

function policy(change: (draft: Policy) => void = () => {}): Policy {
  const draft = defaultPolicy('darwin')
  change(draft)
  return draft
}

describe('the ceilings of Settings › 电脑', () => {
  it('shows one local ladder over the built-in ceiling and the full-access switch', () => {
    expect(localLadder({ maxLevel: 'L2', allowL3: true })).toBe('L3')
    expect(localLadder({ maxLevel: 'L0', allowL3: true })).toBe('L3')
    expect(localLadder({ maxLevel: 'L2', allowL3: false })).toBe('L2')
    expect(localLadder({ maxLevel: 'L1', allowL3: false })).toBe('L1')
    expect(localLadder({ maxLevel: 'L0', allowL3: false })).toBe('L0')
  })

  it('says what each step of a ceiling leaves possible, as the Host stores it', () => {
    // Full access allowed: full-access sessions start here, each still confirmed (only they can start under 只读).
    expect(localNote({ maxLevel: 'L2', allowL3: true })).toBe('在 Latch 桌面端发起；每个完全访问的会话仍要单独确认')
    expect(localNote({ maxLevel: 'L1', allowL3: true })).toBe('在 Latch 桌面端发起；每个完全访问的会话仍要单独确认')
    expect(localNote({ maxLevel: 'L0', allowL3: true })).toBe('完全访问已允许；Latch 内置会话的上限为只读，不能发起')
    // Full access off: the agents cannot start here, and under 只读 nothing can.
    expect(localNote({ maxLevel: 'L2', allowL3: false })).toBe(
      '自动编辑尚未实现，目前按逐项询问执行；Agent 成员（完全访问）不能在这台电脑上发起会话',
    )
    expect(localNote({ maxLevel: 'L1', allowL3: false })).toBe('Agent 成员（完全访问）不能在这台电脑上发起会话')
    expect(localNote({ maxLevel: 'L0', allowL3: false })).toBe('只能查看、拒绝和停止会话')
    for (const level of ['L0', 'L1', 'L2'] as const)
      expect(localNote({ maxLevel: level, allowL3: false })).not.toContain('每个完全访问的会话仍要单独确认')
    expect(remoteNote('L0')).toBe('只能查看、拒绝和停止会话；也包括这台电脑上的浏览器')
    expect(remoteNote('L1')).toBe('也包括这台电脑上的浏览器')
    expect(remoteNote('L2')).toBe('自动编辑尚未实现，目前按逐项询问执行')
  })

  it('writes both local fields in one request: full access keeps the built-in ceiling at least 逐项询问', () => {
    expect(localLadderPatch({ maxLevel: 'L0', allowL3: false }, 'L3')).toEqual({ local: { maxLevel: 'L1', allowL3: true } })
    expect(localLadderPatch({ maxLevel: 'L1', allowL3: false }, 'L3')).toEqual({ local: { maxLevel: 'L1', allowL3: true } })
    expect(localLadderPatch({ maxLevel: 'L2', allowL3: false }, 'L3')).toEqual({ local: { maxLevel: 'L2', allowL3: true } })
    for (const level of ['L0', 'L1', 'L2'] as const)
      expect(localLadderPatch({ maxLevel: 'L2', allowL3: true }, level)).toEqual({ local: { maxLevel: level, allowL3: false } })
  })

  it('writes the remote ceiling and the remote lists on their own', () => {
    expect(remoteLadderPatch('L0')).toEqual({ remote: { maxLevel: 'L0' } })
    expect(remoteListPatch('harnesses', null)).toEqual({ remote: { harnesses: null } })
    expect(remoteListPatch('workspaces', ['a', 'b', 'a'])).toEqual({ remote: { workspaces: ['a', 'b'] } })
    expect(toggledList(['standard'], 'codex', true)).toEqual(['standard', 'codex'])
    expect(toggledList(['standard', 'codex'], 'codex', true)).toEqual(['standard', 'codex'])
    expect(toggledList(['standard', 'codex'], 'standard', false)).toEqual(['codex'])
  })

  it('judges a change a raise exactly where the Host asks for a local confirmation', () => {
    const bases: Policy[] = [
      policy(),
      policy(draft => {
        draft.local = { maxLevel: 'L0', allowL3: false }
        draft.remote.maxLevel = 'L0'
        draft.remote.allowRemoteStart = false
        draft.remote.workspaces = ['default']
        draft.hostEgressAllow = ['127.0.0.1:11434']
        draft.confirmedAddresses = ['http://127.0.0.1:11434', 'https://gateway.example:443']
      }),
      policy(draft => {
        draft.remote.harnesses = null
        draft.remote.workspaces = []
      }),
    ]
    const levels: PermissionLevel[] = ['L0', 'L1', 'L2', 'L3']
    const patches = (base: Policy): PolicyPatch[] => [
      ...levels.map(level => localLadderPatch(base.local, level)),
      ...(['L0', 'L1', 'L2'] as const).map(remoteLadderPatch),
      { remote: { allowRemoteStart: true } },
      { remote: { allowRemoteStart: false } },
      remoteListPatch('harnesses', null),
      remoteListPatch('harnesses', ['standard']),
      remoteListPatch('harnesses', ['standard', 'codex']),
      remoteListPatch('harnesses', []),
      remoteListPatch('workspaces', null),
      remoteListPatch('workspaces', ['default']),
      remoteListPatch('workspaces', ['default', 'website']),
      { hostEgressAllow: { add: ['127.0.0.1:11434'] } },
      { hostEgressAllow: { add: ['192.168.1.5:8080'] } },
      { hostEgressAllow: { remove: ['127.0.0.1:11434'] } },
      { confirmedAddresses: { remove: ['http://127.0.0.1:11434'] } },
      { confirmedAddresses: { remove: ['https://not-there.example:443'] } },
    ]
    for (const base of bases)
      for (const patch of patches(base)) {
        const next = hostPatched(base, patch)
        expect({ patch, widens: widens(view(base), patch) }).toEqual({ patch, widens: !isLowering(base, next) })
        expect(applyPatch(view(base), patch)).toEqual(view(next))
      }
  })

  it('accepts only an exact host:port for the egress allow list', () => {
    for (const ok of ['127.0.0.1:11434', 'localhost:1234', 'ollama.lan:443', '[::1]:8080']) expect(isEgressTarget(ok)).toBe(true)
    for (const bad of ['127.0.0.1', 'http://127.0.0.1:1', 'Host:80', 'a:0', 'a:65536', 'a b:80', '-a:80', ':80'])
      expect(isEgressTarget(bad)).toBe(false)
  })

  it('reads only a policy that has every field the page needs', () => {
    expect(parsePolicy(defaultPolicy('linux'))).toEqual({
      local: { maxLevel: 'L2', allowL3: true },
      remote: { maxLevel: 'L1', allowRemoteStart: true, harnesses: ['standard'], workspaces: null },
      hostEgressAllow: [],
      confirmedAddresses: [],
    })
    expect(parsePolicy({ ...defaultPolicy('linux'), local: { maxLevel: 'L3', allowL3: true } })).toBeNull()
    expect(parsePolicy({ ...defaultPolicy('linux'), hostEgressAllow: 'x' })).toBeNull()
    expect(parsePolicy(null)).toBeNull()
  })

  it('sends the change as it is and reports a change the Host applied without an audit record', async () => {
    const after = policy(draft => {
      draft.remote.maxLevel = 'L0'
    })
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ policy: after, hash: 'h' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-latch-audit': 'failed' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await changePolicy(remoteLadderPatch('L0'))
    expect(result).toEqual({ policy: view(after), auditFailed: true })
    const [[url, init]] = fetchMock.mock.calls
    expect(url).toBe('/link/api/policy')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(typeof init.body === 'string' ? init.body : '')).toEqual({ remote: { maxLevel: 'L0' } })
    expect(new Headers(init.headers).has('x-latch-confirmation')).toBe(false)

    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ policy: after, hash: 'h' }), { status: 200 }))
    expect((await changePolicy(remoteLadderPatch('L0'))).auditFailed).toBe(false)
  })
})

const device = (scopes: DeviceScope[]): CurrentDevice => ({
  id: 'd',
  name: '手机',
  listener: 'tailnet-tls',
  status: 'active',
  scopes,
  dataScope: 'work',
  fingerprint: 'ABCD EFGH IJKL MNOP QRST',
  pairedBy: { method: 'invitation' },
  createdAt: '',
  lastSeenAt: '',
  credentialExpiresAt: '',
  renewAfter: '',
  current: true,
})

const snapshot = (scopes: DeviceScope[]): AppSnapshot => ({
  instanceId: 'i',
  device: device(scopes),
  host: {
    hostId: 'h',
    devMode: true,
    presence: { status: 'unavailable', message: '确认组件未安装' },
    tls: null,
    policy: { localMaxLevel: 'L2', remoteMaxLevel: 'L2', allowL3: false },
  },
  tasks: [],
  approvals: [],
  demo: false,
  hostName: 'MacBook Pro',
  catalog: {
    harnesses: [{ id: 'standard', name: 'Latch 内置', source: 'builtin', status: 'ready', modes: ['chat', 'agent'], models: 'host' }],
    providers: [],
    workspaces: [{ id: 'default', name: 'app', path: '/w' }],
    defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default' },
  },
})

describe('Settings › 电脑 on a current Host', () => {
  it('is offered to every device, next to the Host settings that need 管理此 Host', () => {
    const admin = snapshot(['view', 'run', 'admin'])
    expect(settingsSections(admin, deviceAccess(admin, null))).toEqual([
      'general',
      'computer',
      'providers',
      'agents',
      'workspaces',
      'plugins',
      'devices',
      'about',
    ])
    const viewer = snapshot(['view'])
    expect(settingsSections(viewer, deviceAccess(viewer, null))).toEqual(['general', 'computer', 'devices', 'about'])
  })

  it('says under the sections what a device without 管理此 Host does not see, and where it is granted', () => {
    const viewer = snapshot(['view', 'run'])
    expect(hiddenSectionsCaption(viewer, deviceAccess(viewer, null))).toBe(SETTINGS_ADMIN_HIDDEN)
    const html = renderToStaticMarkup(createElement(SettingsPage, { snapshot: viewer, onClose: () => {}, onChanged: () => {} }))
    expect(html).toContain(`<span>${SETTINGS_ADMIN_HIDDEN}</span>`)
    // An administrator sees every section, so the line is not there.
    const admin = snapshot(['view', 'run', 'admin'])
    expect(hiddenSectionsCaption(admin, deviceAccess(admin, null))).toBeUndefined()
    expect(renderToStaticMarkup(createElement(SettingsPage, { snapshot: admin, onClose: () => {}, onChanged: () => {} }))).not.toContain(
      SETTINGS_ADMIN_HIDDEN,
    )
  })

  it('shows a device without 管理此 Host the summary read-only, with 自动编辑 said honestly', () => {
    const viewer = snapshot(['view'])
    const html = renderToStaticMarkup(
      createElement(ComputerSettings, { snapshot: viewer, access: deviceAccess(viewer, null), onChanged: () => {} }),
    )
    expect(html).toContain('MacBook Pro')
    expect(html).toContain('确认组件未安装')
    expect(html).toContain('未配置')
    // Phone access says where it is set up, in words, and never with the start options.
    expect(html).toContain('配置方法见 设置 › 设备 › 手机配对')
    expect(html).not.toContain('--tls-cert')
    expect(html).toContain('只有能管理此 Host 的设备可以修改上限。')
    expect(html.match(/自动编辑尚未实现，目前按逐项询问执行/gu)).toHaveLength(2)
    expect(html).not.toContain('aria-haspopup')
    expect(html).not.toContain('role="switch"')
  })
})
