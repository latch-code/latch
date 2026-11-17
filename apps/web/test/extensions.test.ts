import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  HARNESS_EXTENSIONS,
  isShellSafeName,
  namedExtensionCommand,
  type HarnessInfo,
  type McpServerView,
  type PluginInfo,
  type PromptTemplate,
} from '@latch/protocol'
import { fillRefusal } from '../src/panel/terminal/fill.ts'
import {
  NOT_REPORTED,
  NOT_YET,
  extensionHarnesses,
  harnessKinds,
  harnessSummary,
  latchPlugins,
  pluginProvides,
} from '../src/settings/extensions.ts'
import { HarnessMcpGroup } from '../src/settings/HarnessMcp.tsx'

function harness(change: Partial<HarnessInfo> = {}, mark = 'codex'): HarnessInfo {
  return {
    id: mark,
    capabilities: { display: { label: mark, mark }, permission: { enforcement: 'harness' } },
    status: 'ready',
    modes: ['agent'],
    level: 'L3',
    editable: true,
    ...change,
  } as unknown as HarnessInfo
}

const server = (name: string, preset?: 'computer'): McpServerView =>
  ({
    id: `mcp_${name}`,
    name,
    transport: 'stdio',
    enabled: true,
    scope: { all: true, agents: [], projects: [] },
    ...(preset ? { preset } : {}),
  }) as unknown as McpServerView

const kind = (views: ReturnType<typeof harnessKinds>, name: string) => views.find(view => view.kind === name)!

describe('设置 › 扩展 model', () => {
  it('tells apart a kind the Harness does not report, one it reports with no session yet, and one reported empty', () => {
    // An ACP preset: commands only; nothing yet.
    const claude = harnessKinds(harness({}, 'claude-agent'), undefined, {})
    expect(kind(claude, 'skills').status).toBe('not-reported')
    expect(kind(claude, 'commands').status).toBe('not-yet')
    expect(kind(claude, 'mcp').status).toBe('not-reported')
    expect(kind(claude, 'plugins').status).toBe('not-reported')

    // Codex reports skills and its own MCP: before a session both are 「not yet」, never 「none」.
    const before = harnessKinds(harness({ ownMcp: {} }), undefined, {})
    expect(kind(before, 'skills').status).toBe('not-yet')
    expect(kind(before, 'mcp').status).toBe('not-yet')
    expect(harnessSummary(before)).toBe(NOT_YET)

    const reported = harnessKinds(
      harness({ ownMcp: { last: { servers: [], at: '2026-11-17T00:00:00.000Z', via: 'session' } } }),
      { commands: [], skills: [], reportedAt: '2026-11-17T00:00:00.000Z' },
      {},
    )
    for (const name of ['skills', 'commands', 'mcp']) {
      expect(kind(reported, name).status).toBe('reported')
      expect(kind(reported, name).own).toEqual([])
    }
    // Codex's protocol has its plugins and Latch does not read them yet: said so, never 「not reported」.
    expect(kind(reported, 'plugins').status).toBe('not-implemented')
    expect(kind(reported, 'plugins').reason).toContain('plugin/installed')
    expect(kind(claude, 'plugins').status).toBe('not-reported')

    // A session that could not read Codex's skill directory reports commands but no skills: unknown, not none.
    const unread = harnessKinds(harness(), { commands: [], reportedAt: '2026-11-17T00:00:00.000Z' }, {})
    expect(kind(unread, 'skills').status).toBe('unread')
    expect(kind(unread, 'skills').own).toEqual([])
  })

  it('marks what the Harness reported as its own and what Latch gives it as Latch’s, with the scope and route', () => {
    const templates: PromptTemplate[] = [
      { id: 'a', name: '审查', content: 'x', scope: { kind: 'all' } },
      { id: 'b', name: '只给 Codex', content: 'x', scope: { kind: 'agent', id: 'codex' } },
      { id: 'c', name: '项目的', content: 'x', scope: { kind: 'project', id: 'p' } },
    ]
    const views = harnessKinds(
      harness({ skills: 'server', ownMcp: { last: { servers: [{ name: 'files', state: 'ready' }], at: 'x', via: 'session' } } }),
      {
        commands: [{ name: 'compact', description: '压缩' }],
        skills: [{ name: 'review', invocation: '$review', scope: 'project' }],
        reportedAt: '2026-11-17T00:00:00.000Z',
      },
      { mcpServers: [server('github'), server('computer', 'computer')], templates },
    )
    expect(kind(views, 'skills').own).toEqual([{ key: 'skill:$review', name: 'review', mark: 'harness', detail: '项目' }])
    expect(kind(views, 'skills').latch.map(entry => [entry.name, entry.mark, entry.detail])).toEqual([
      ['我的 Agent 的技能', 'latch', '经 latch-skills'],
      ['latch-operate-this-mac', 'latch', '经 latch-skills'],
    ])
    expect(kind(views, 'commands').own.map(entry => entry.name)).toEqual(['/compact'])
    expect(kind(views, 'commands').latch.map(entry => entry.name)).toEqual(['审查', '只给 Codex'])
    expect(kind(views, 'mcp').own).toEqual([{ key: 'mcp:files', name: 'files', mark: 'harness', remove: 'codex mcp remove files' }])
    expect(kind(views, 'mcp').latch.map(entry => entry.name)).toEqual(['github', 'computer'])
  })

  it('gives a Harness that takes no Latch MCP servers none of them', () => {
    const views = harnessKinds(harness({}, 'pi'), undefined, { mcpServers: [server('github')] })
    expect(kind(views, 'mcp').latch).toEqual([])
    expect(kind(views, 'skills').latch).toEqual([])
  })

  it('offers only the vendor’s documented commands, and the reason where there are none', () => {
    const codex = harnessKinds(harness(), undefined, {})
    expect(kind(codex, 'mcp').commands?.install).toBe('codex mcp add ')
    expect(kind(codex, 'skills').commands).toBeUndefined()
    expect(kind(codex, 'skills').absent).toBeTruthy()
    const custom = harnessKinds(harness({}, 'my-agent'), undefined, {})
    expect(custom.every(view => !view.commands && view.absent?.includes('不是 Latch 的预设'))).toBe(true)
    // A preset whose vendor documents no such command is still a preset.
    const dsh = harnessKinds(harness({}, 'dsh'), undefined, {})
    expect(dsh.every(view => !view.commands && view.absent?.startsWith('它没有'))).toBe(true)
    expect(dsh.some(view => view.absent?.includes('不是 Latch 的预设'))).toBe(false)
    // Every command can be typed into the terminal as it stands.
    for (const profile of Object.values(HARNESS_EXTENSIONS))
      for (const commands of Object.values(profile.commands))
        for (const command of [commands.install, commands.update, commands.remove].filter(Boolean) as string[]) {
          expect(fillRefusal(command)).toBeUndefined()
          expect(commands.source).toBeTruthy()
        }
  })

  it('builds a command for a listed entry only from a plain name', () => {
    expect(namedExtensionCommand('codex mcp remove ', 'files')).toBe('codex mcp remove files')
    for (const name of ['-rf', 'a b', 'a;rm', '$(x)', 'a`b`', '', 'x'.repeat(200), 'é']) {
      expect(isShellSafeName(name)).toBe(false)
      expect(namedExtensionCommand('codex mcp remove ', name)).toBeUndefined()
    }
    const views = harnessKinds(
      harness({ ownMcp: { last: { servers: [{ name: 'a;b', state: 'ready' }], at: 'x', via: 'session' } } }),
      undefined,
      {},
    )
    expect(kind(views, 'mcp').own[0]!.remove).toBeUndefined()
  })

  it('lists external Harnesses only, and splits Latch’s plugins into data and trusted local code', () => {
    const builtIn = harness({ id: 'standard', capabilities: { display: { label: 'x' }, permission: { enforcement: 'latch' } } } as never)
    const offer = harness({ id: 'pi', offer: { presetId: 'pi' } })
    expect(extensionHarnesses([builtIn, offer, harness()]).map(item => item.id)).toEqual(['codex'])
    const plugin = (id: string, capabilities: string[], extra: Partial<PluginInfo> = {}): PluginInfo => ({
      id,
      name: id,
      version: '1',
      description: id,
      enabled: true,
      activeRuns: 0,
      capabilities,
      package: { formatVersion: 2 },
      ...extra,
    })
    const { data, code } = latchPlugins([
      plugin('notes', ['skill:a', 'data:b']),
      plugin('tools', ['tool:x', 'skill:a']),
      plugin('module', ['provider:p'], { package: undefined } as never),
      plugin('core', ['provider:openai'], { managed: 'provider' }),
      plugin('workspace-files', ['tool:read_file'], { package: undefined, builtIn: true } as never),
    ])
    expect(data.map(item => item.id)).toEqual(['notes'])
    expect(code.map(item => item.id)).toEqual(['tools', 'module'])
    expect(pluginProvides(plugin('notes', ['skill:a', 'data:b']), 2)).toBe('技能 1 · 数据面板 1 · 页面 2')
  })

  it('says a Harness that does not report its MCP does so plainly, and still lists what Latch gives it', () => {
    const html = renderToStaticMarkup(
      createElement(HarnessMcpGroup, { harness: harness({}, 'claude-agent'), title: 'MCP', run: true }, createElement('i', null, 'github')),
    )
    expect(html).toContain(NOT_REPORTED)
    expect(html).toContain('github')
  })
})
