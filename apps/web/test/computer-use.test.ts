import { describe, expect, it } from 'vitest'
import type { HarnessInfo } from '@latch/protocol'
import { bypassesComputer } from '../src/conversation/computerBypass.ts'
import { computerHarnesses, computerToolSections, computerVersion, defaultsNote } from '../src/settings/computerTools.ts'

describe('「操控这台 Mac」 on the page', () => {
  it.each([
    ['cua-driver call click {"pid":1}', true],
    ['~/.local/bin/cua-driver list-tools', true],
    ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver call click', true],
    ["sh -c 'cua-driver click'", true],
    ['cua do screenshot', true],
    ['cd /tmp && cua mcp', true],
    ['cua sandbox list', false],
    ['echo cua-drivers', false],
    ['grep cua-driverx file', false],
    ['pnpm test', false],
    [undefined, false],
  ])('marks %j as running Cua past Latch: %s', (command, marked) => {
    expect(bypassesComputer(command)).toBe(marked)
  })

  it('groups the listed tools, in order, with any it does not know under 其他', () => {
    const sections = computerToolSections(['click', 'list_windows', 'run_steps', 'launch_app', 'browser_motion_policy', 'brand_new'])
    expect(sections.map(section => [section.label, section.tools])).toEqual([
      ['看', ['list_windows']],
      ['操作', ['click']],
      ['启动 App', ['launch_app']],
      ['批量', ['run_steps']],
      ['浏览器', ['browser_motion_policy']],
      ['其他', ['brand_new']],
    ])
  })

  it('says the driver’s version against the minimum, and which Harnesses can use it', () => {
    const check = { state: 'ok' as const, minimum: '0.37.0', pinned: '0.45.4', command: '/x', install: 'i' }
    expect(computerVersion({ ...check, version: '0.52.3' })).toEqual({
      tone: 'done',
      text: '0.52.3',
      title: '最低 0.37.0 · 安装命令 0.45.4',
    })
    expect(computerVersion({ ...check, version: '0.36.9' }).tone).toBe('warn')
    expect(computerVersion(check).text).toBe('未知')
    const harnesses = [{ id: 'codex', skills: 'server' }, { id: 'pi' }, { id: 'standard', skills: 'native' }] as HarnessInfo[]
    expect(computerHarnesses(harnesses).map(entry => [entry.harness.id, entry.usable])).toEqual([
      ['codex', true],
      ['pi', false],
      ['standard', false],
    ])
  })
  it('says in one line which switches the new defaults moved', () => {
    expect(defaultsNote(['run_steps', 'launch_app', 'get_desktop_state'])).toBe('已按新默认调整 · 批量、启动 App 已开 · 整屏已关')
    expect(defaultsNote(['get_desktop_state'])).toBe('已按新默认调整 · 整屏已关')
    expect(defaultsNote(['run_steps'])).toBe('已按新默认调整 · 批量已开')
  })
})
