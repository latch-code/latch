import { describe, expect, it } from 'vitest'
import { addressRows, limitRows } from '../src/core/policyView.ts'

const catalog = {
  harnesses: [
    { id: 'standard', name: 'Latch' },
    { id: 'pi', name: 'Pi' },
  ],
  workspaces: [
    { id: 'default', name: 'start' },
    { id: 'site', name: '官网' },
  ],
}
const fresh = {
  local: { maxLevel: 'L2', allowL3: true },
  remote: { maxLevel: 'L1', harnesses: ['standard'], workspaces: null },
}

describe('what the policy holds, in words', () => {
  it('says nothing about a Host at its defaults', () => {
    expect(limitRows(fresh, catalog)).toEqual([])
  })

  it('names every lowered limit', () => {
    const rows = limitRows(
      { local: { maxLevel: 'L1', allowL3: false }, remote: { maxLevel: 'L0', harnesses: [], workspaces: [] } },
      catalog,
    )
    expect(rows.map(row => row.title)).toEqual([
      '这台 Mac 不能开始完全访问会话',
      '手机和浏览器只能查看',
      '手机和浏览器不能用任何引擎',
      '手机和浏览器不能在任何项目里工作',
    ])
  })

  it('says nothing about a level that refuses nothing', () => {
    expect(limitRows({ ...fresh, local: { maxLevel: 'L1', allowL3: true } }, catalog)).toEqual([])
    expect(limitRows({ ...fresh, remote: { ...fresh.remote, maxLevel: 'L2' } }, catalog)).toEqual([])
    expect(limitRows({ ...fresh, local: { maxLevel: 'L0', allowL3: true } }, catalog).map(row => row.title)).toEqual([
      '这台 Mac 上的会话只能查看',
    ])
  })

  it('names listed projects and engines, and says when an entry no longer exists', () => {
    const rows = limitRows(
      { ...fresh, remote: { maxLevel: 'L1', harnesses: ['standard', 'pi'], workspaces: ['site', 'default', 'gone'] } },
      catalog,
    )
    expect(rows).toEqual([
      { id: 'remote-engines', title: '手机和浏览器只能用这些引擎', description: 'Latch、Pi' },
      { id: 'remote-projects', title: '手机和浏览器只能在这些项目里工作', description: '官网、不在项目里的会话、1 个已不存在的项目或引擎' },
    ])
  })

  it('also shows a limit wider than a new Host has', () => {
    const rows = limitRows({ ...fresh, remote: { ...fresh.remote, harnesses: null } }, catalog)
    expect(rows.map(row => row.id)).toEqual(['remote-engines'])
    // Full-access engines stay on this computer whatever the list says.
    expect(rows[0]!.title).toContain('完全访问以外')
  })
})

describe('confirmed addresses', () => {
  const providers = [
    { name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1/' },
    { name: 'Other', baseURL: 'https://api.example.test/v1' },
  ]

  it('pairs an address with the services at it and the allowance only it needs', () => {
    const { addresses, allowances } = addressRows(
      { confirmedAddresses: ['http://127.0.0.1:11434/v1'], hostEgressAllow: ['127.0.0.1:11434', '10.0.0.2:8080'] },
      providers,
    )
    expect(addresses).toEqual([
      { address: 'http://127.0.0.1:11434/v1', shown: 'http://127.0.0.1:11434/v1', services: ['Ollama'], allowance: '127.0.0.1:11434' },
    ])
    expect(allowances).toEqual(['10.0.0.2:8080'])
  })

  it('keeps an allowance another confirmed address still needs', () => {
    const { addresses } = addressRows(
      { confirmedAddresses: ['http://10.0.0.2:8080/a', 'http://10.0.0.2:8080/b'], hostEgressAllow: ['10.0.0.2:8080'] },
      [],
    )
    expect(addresses.map(row => row.allowance)).toEqual([undefined, undefined])
  })

  it('does not count a service at another path of the same origin as using the address', () => {
    const { addresses } = addressRows({ confirmedAddresses: ['https://api.example.test:443/v1/mine'], hostEgressAllow: [] }, providers)
    expect(addresses[0]!.services).toEqual([])
  })
})
