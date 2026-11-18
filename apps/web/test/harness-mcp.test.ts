import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HarnessInfo, McpImportCandidate } from '@latch/protocol'
import { EXTENSION_COPY } from '../src/settings/extensions.ts'
import { HarnessMcpGroup, harnessMcpWord } from '../src/settings/HarnessMcp.tsx'
import { candidateLine, importedForm } from '../src/settings/McpImport.tsx'
import { hiddenCharacters } from '../src/settings/McpSettings.tsx'

function harness(change: Partial<HarnessInfo> = {}): HarnessInfo {
  return {
    id: 'codex',
    capabilities: { display: { label: 'Codex', mark: 'codex' } },
    status: 'ready',
    modes: ['agent'],
    level: 'L3',
    editable: true,
    ...change,
  } as unknown as HarnessInfo
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

describe('a Harness’s own MCP', () => {
  it('says the state in a few words, with the tool count once a server is up', () => {
    expect(harnessMcpWord({ state: 'ready', tools: 3 })).toEqual({ tone: 'done', text: '可用 · 3 个工具' })
    expect(harnessMcpWord({ state: 'needs-login' })).toEqual({ tone: 'warn', text: '需要登录' })
    expect(harnessMcpWord({ state: 'failed', tools: 2 })).toEqual({ tone: 'failed', text: '失败' })
  })

  it('says a Harness that does not report its MCP does not, and offers nothing to read', () => {
    const html = render(createElement(HarnessMcpGroup, { harness: harness(), title: 'MCP', run: true }))
    expect(html).toContain(EXTENSION_COPY.notReported)
    expect(html).not.toContain('读取')
  })

  it('lists what Codex reported, read-only, with its login command only where it asked for one', () => {
    const html = render(
      createElement(HarnessMcpGroup, {
        harness: harness({
          ownMcp: {
            last: {
              via: 'session',
              at: '2026-11-13T00:00:00.000Z',
              servers: [
                { name: 'github', state: 'ready', tools: 2, origin: 'https://api.github.com' },
                { name: 'linear', state: 'needs-login', login: 'codex mcp login linear' },
                { name: 'files', state: 'ready', tools: 1 },
              ],
            },
          },
        }),
        title: 'MCP',
        run: true,
        latchNames: ['Files'],
      }),
    )
    expect(html).toContain('可用 · 2 个工具')
    expect(html).toContain('https://api.github.com')
    expect(html).toContain('codex mcp login linear')
    expect(html).not.toContain('codex mcp login github')
    expect(html).not.toContain('codex mcp login files')
    expect(html).toContain('会话里用 Latch 的同名服务器')
    expect(html).toContain('读取')
    // Off a device that may not start sessions, nothing to read.
    expect(render(createElement(HarnessMcpGroup, { harness: harness({ ownMcp: {} }), title: 'MCP', run: false }))).not.toContain('读取</')
  })

  it('shows a read with no session as names only, the missing state behind ⓘ', () => {
    const html = render(
      createElement(HarnessMcpGroup, {
        harness: harness({
          ownMcp: {
            last: { via: 'read', namesOnly: true, at: '2026-11-13T00:00:00.000Z', servers: [{ name: 'github', state: 'unknown' }] },
          },
        }),
        title: 'MCP',
        run: true,
      }),
    )
    expect(html).toContain('github')
    expect(html).not.toContain('状态未知')
    expect(html).toContain('只有名字')
  })
})

describe('从项目导入', () => {
  const candidate: McpImportCandidate = {
    key: 'github',
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github', '${HOME}'],
    env: [
      { name: 'GITHUB_TOKEN', secret: true },
      { name: 'LOG_LEVEL', secret: false, value: 'debug' },
    ],
    flags: ['expansion'],
  }

  it('fills the form with what the file says, every secret left empty for the person to type', () => {
    const form = importedForm(candidate)
    expect(form).toMatchObject({ transport: 'stdio', name: 'github', command: 'npx' })
    expect(form.args.split('\n')).toEqual(['-y', '@modelcontextprotocol/server-github', '${HOME}'])
    expect(form.env).toEqual([
      { key: 'GITHUB_TOKEN', value: '', secret: true },
      { key: 'LOG_LEVEL', value: 'debug', secret: false },
    ])
    const remote = importedForm({
      key: 'r',
      name: '',
      transport: 'http',
      url: 'https://x.example/mcp',
      headers: ['Authorization'],
      flags: [],
    })
    expect(remote.headers).toEqual([{ key: 'Authorization', value: '' }])
    expect(remote.name).toBe('')
    expect(candidateLine(candidate)).toBe('npx -y @modelcontextprotocol/server-github ${HOME}')
  })
})

describe('the argument textarea and the command', () => {
  it('refuses what a confirmation would escape: bidi, C1 controls, line and paragraph separators', () => {
    for (const odd of ['\u202e', '\u2066', '\u0085', '\u2028', '\u2029', '\u200b']) expect(hiddenCharacters(`a${odd}b`)).toBe(true)
    expect(hiddenCharacters('@modelcontextprotocol/server-github')).toBe(false)
    expect(hiddenCharacters('${workspaceFolder}/中文')).toBe(false)
  })
})
