import { describe, expect, it } from 'vitest'
import {
  BUILTIN_MODES,
  BUILTIN_MODE_TIERS,
  LADDER_MODE,
  type DeviceScope,
  type HarnessInfo,
  type SessionConfigOption,
} from '@latch/protocol'
import { draftPermission, permissionView } from '../src/composer/permission.ts'
import { startConfig, withLadderMode } from '../src/composerChoice.ts'

const builtin = {
  id: 'standard',
  level: 'L1',
  modes: ['chat', 'agent'],
  capabilities: { display: { label: 'Latch 内置', mark: 'latch' }, models: { owner: 'latch' } },
  permission: {
    approvals: 'prompts',
    readback: 'mode',
    modeTiers: structuredClone(BUILTIN_MODE_TIERS),
    modes: [...BUILTIN_MODES],
    startMode: 'ask',
  },
} as unknown as HarnessInfo

const option = (currentValue: string): SessionConfigOption => ({
  id: 'mode',
  name: '权限',
  category: 'mode',
  currentValue,
  options: BUILTIN_MODES.map(value => ({ value, name: value })),
})
const all = new Set<DeviceScope>(['view', 'run', 'approve:standard', 'approve:elevated'])

describe('Latch 内置’s levels in the composer', () => {
  it('shows every level strict to wide, in Latch’s words, with no Harness-setting note', () => {
    const view = permissionView({
      harness: builtin,
      mode: 'agent',
      permission: { modeTiers: builtin.permission!.modeTiers! },
      config: [option('ask')],
      access: { legacy: false, local: true, scopes: all },
    })!
    expect(view.rows!.map(row => row.name)).toEqual(['只看不改', '先问你', '按规则放行', '由模型判断', '不再询问'])
    expect(view.rows!.map(row => row.icon)).toEqual(['eye', 'shield', 'list-checks', 'scale', 'shield-alert'])
    expect(view).toMatchObject({ label: '先问你', line: '读项目不问；写文件每次问你', amber: false })
    expect(view.note).toBeUndefined()
  })

  it('marks 不再询问 amber when the session is there', () => {
    const view = permissionView({
      harness: builtin,
      mode: 'agent',
      permission: { modeTiers: builtin.permission!.modeTiers! },
      config: [option('never')],
      access: { legacy: false, local: true, scopes: all },
    })!
    expect(view).toMatchObject({ label: '不再询问', amber: true, icon: 'shield-alert' })
  })

  it('offers only the levels this device may choose, and always the current one', () => {
    const rows = (scopes: DeviceScope[], current = 'ask') =>
      permissionView({
        harness: builtin,
        mode: 'agent',
        permission: { modeTiers: builtin.permission!.modeTiers! },
        config: [option(current)],
        access: { legacy: false, local: true, scopes: new Set(scopes) },
      })!.rows!.map(row => row.value)
    expect(rows(['view', 'run'])).toEqual(['plan', 'ask'])
    expect(rows(['view', 'run', 'approve:standard'])).toEqual(['plan', 'ask', 'rule'])
    expect(rows(['view', 'run'], 'never')).toEqual(['plan', 'ask', 'never'])
  })

  it('offers the levels in a draft and carries the pick to the start', () => {
    const config = withLadderMode(builtin, undefined, { [LADDER_MODE]: 'rule' })
    const view = draftPermission(builtin, 'agent', config, undefined, all)!
    expect(view.rows?.find(row => row.current)?.value).toBe('rule')
    expect(startConfig(builtin, { [LADDER_MODE]: 'rule' })).toEqual([{ configId: LADDER_MODE, value: 'rule' }])
    // Before anything is picked, the session starts at 先问你.
    expect(draftPermission(builtin, 'agent', withLadderMode(builtin, undefined, {}), undefined, all)).toMatchObject({ label: '先问你' })
    expect(draftPermission(builtin, 'chat', config)).toMatchObject({ asksNothing: true })
  })
})
