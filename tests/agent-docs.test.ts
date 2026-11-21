import { describe, expect, it } from 'vitest'
import { affectedDocs, BUDGET, checkAgentDocs, headingAnchors, readDocSources, skillLinkTarget } from '../scripts/agent-docs.ts'
import { checkDocHygiene, wordHash } from '../scripts/doc-hygiene.ts'
import { directoriesOf, type Repository } from '../scripts/repository.ts'

const DOC = '---\ndescription: 测试\nsources:\n  - src\n---\n# 文档\n\n## 第一节\n'

/** An AGENTS.md of exactly `size` bytes. */
const pad = (size: number) => `# x\n${'a'.repeat(size - 4)}`
const skill = (name: string, description = '用途。') => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`

/** An in-memory checkout: `links` are symbolic links (listed as files, like git does), `ignored` are .gitignore prefixes. */
function repository(contents: Record<string, string>, options: { links?: Record<string, string>; ignored?: string[] } = {}): Repository {
  const files = new Set([...Object.keys(contents), ...Object.keys(options.links ?? {})])
  return {
    root: '/repo',
    files,
    dirs: directoriesOf(files),
    read: async path => {
      const text = contents[path]
      if (text === undefined) throw new Error(`no file ${path}`)
      return text
    },
    link: async path => options.links?.[path],
    ignored: async paths =>
      new Set(paths.filter(path => (options.ignored ?? []).some(prefix => path === prefix || path.startsWith(`${prefix}/`)))),
  }
}

/** A checkout that passes every check; each test changes one thing. */
function valid(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    '.gitignore': '/dist/\n/docs/security/\n',
    'AGENTS.md': '# AGENTS.md\n\n| 路径 | 职责 |\n| --- | --- |\n| `apps/app/` | 应用 |\n\n见 [测试](docs/TESTING.md#第一节)。\n',
    'CLAUDE.md': '@AGENTS.md\n\n## Claude Code\n',
    'apps/app/AGENTS.md': '# app\n\n- 入口 `src/main.ts`（`test/main.test.ts#main > starts`）。\n',
    'apps/app/CLAUDE.md': '@AGENTS.md\n',
    'apps/app/package.json': '{"name":"@latch/app"}',
    'apps/app/src/main.ts': 'export {}\n',
    'apps/app/test/main.test.ts': "describe('main', () => { it('starts', () => {}) })\n",
    'docs/TESTING.md': DOC,
    'src/index.ts': 'export {}\n',
    'package.json': '{"name":"latch","dependencies":{"react-dom":"1.0.0"}}',
  }
  const merged: Record<string, string> = { ...base }
  for (const [path, text] of Object.entries(overrides)) {
    if (text === undefined) delete merged[path]
    else merged[path] = text
  }
  return merged
}

describe('document hygiene checks', () => {
  const blocked = new Set([wordHash('zorblax'), wordHash('quux engine room'), wordHash('虚词')])

  it('reports a tracked file in the local-only directory, also through the agent checks, whether or not the directory exists on disk', async () => {
    const problems = await checkAgentDocs(repository(valid({ 'docs/security/NOTES.md': '# x\n' })))
    expect(problems).toEqual(['docs/security/NOTES.md：这个目录只留在本机，不能被 Git 跟踪'])
  })

  it('requires the ignore line itself, and accepts it with CRLF line ends', async () => {
    const missing = ['.gitignore：缺少 /docs/security/ 这一行']
    expect(await checkDocHygiene(repository(valid({ '.gitignore': undefined })))).toEqual(missing)
    expect(await checkDocHygiene(repository(valid({ '.gitignore': '# /docs/security/\n/docs/security\n' })))).toEqual(missing)
    expect(await checkDocHygiene(repository(valid({ '.gitignore': '/dist/\r\n/docs/security/\r\n' })))).toEqual([])
  })

  it('reports a file under docs/ that is not a listed document', async () => {
    expect(await checkDocHygiene(repository(valid({ 'docs/NOTES.md': DOC, 'docs/sub/TESTING.md': DOC })))).toEqual([
      'docs/NOTES.md：docs/ 只放机制文档；新增文档要写进 scripts/doc-hygiene.ts 的列表',
      'docs/sub/TESTING.md：docs/ 只放机制文档；新增文档要写进 scripts/doc-hygiene.ts 的列表',
    ])
  })

  it('finds a blocked phrase across case, spacing and line ends, and Chinese inside a longer run', async () => {
    const problems = await checkDocHygiene(
      repository(
        valid({
          'README.md': 'see ZORBLAX here\n',
          'README.en.md': 'a zorblax\n',
          'apps/app/AGENTS.md': 'the Quux\n  engine,  room\n',
          'docs/TESTING.md': `${DOC}这是虚词吗\n`,
        }),
      ),
      blocked,
    )
    expect(problems).toEqual([
      'README.en.md：含有不应写进仓库的词「zorblax」',
      'README.md：含有不应写进仓库的词「zorblax」',
      'apps/app/AGENTS.md：含有不应写进仓库的词「quux engine room」',
      'docs/TESTING.md：含有不应写进仓库的词「虚词」',
    ])
  })

  it('leaves a phrase alone when it only appears in part, or outside the scanned files', async () => {
    const contents = valid({
      'README.md': 'zorblaxes and the quux engine\n',
      'apps/app/README.md': 'zorblax\n',
      'apps/app/README.en.md': 'zorblax\n',
      'src/index.ts': '// zorblax\n',
    })
    expect(await checkDocHygiene(repository(contents), blocked)).toEqual([])
  })
})

describe('agent instruction checks', () => {
  it('accepts instructions within budget whose CLAUDE.md, links, paths and cited tests are all in place', async () => {
    expect(await checkAgentDocs(repository(valid()), { projects: ['.', 'apps/app'] })).toEqual([])
  })

  it('reports a file over its budget and a root-to-leaf path over the path budget', async () => {
    const problems = await checkAgentDocs(
      repository(
        valid({
          'AGENTS.md': `${valid()['AGENTS.md']}${'a'.repeat(BUDGET.root - 3000)}`,
          'apps/app/AGENTS.md': pad(BUDGET.project + 1),
          'apps/app/deep/AGENTS.md': pad(4000),
          'apps/app/deep/CLAUDE.md': '@AGENTS.md\n',
          'apps/app/deep/er/AGENTS.md': pad(4000),
          'apps/app/deep/er/CLAUDE.md': '@AGENTS.md\n',
        }),
      ),
    )
    expect(problems.filter(problem => problem.includes('字节'))).toEqual([
      expect.stringMatching(/^apps\/app\/AGENTS\.md：4097 字节，超过 4096 字节/u),
      expect.stringMatching(
        /^apps\/app\/deep\/er\/AGENTS\.md：从仓库根到这里的 AGENTS\.md 合计 \d+ 字节（\. → apps\/app → apps\/app\/deep → apps\/app\/deep\/er），超过 24576 字节$/u,
      ),
    ])
  })

  it('requires a CLAUDE.md beside each AGENTS.md that imports it, and no CLAUDE.md on its own', async () => {
    const problems = await checkAgentDocs(
      repository(
        valid({
          'CLAUDE.md': '# Claude\n@AGENTS.md\n',
          'apps/app/CLAUDE.md': '@AGENTS.md\n\nmore\n',
          'apps/other/AGENTS.md': '# other\n',
          'apps/lonely/CLAUDE.md': '@AGENTS.md\n',
        }),
      ),
    )
    expect(problems).toEqual([
      'CLAUDE.md：第一行应为 @AGENTS.md',
      'apps/app/CLAUDE.md：内容应恰为 "@AGENTS.md\\n"',
      'apps/other/AGENTS.md：同一目录缺少 CLAUDE.md（内容为 "@AGENTS.md\\n"）',
      'apps/lonely/CLAUDE.md：同一目录没有 AGENTS.md',
    ])
  })

  it('reports links to missing files and anchors that match no heading, in every Markdown file', async () => {
    const problems = await checkAgentDocs(
      repository(
        valid({
          'docs/TESTING.md': `${DOC}\n### \`startTestHost()\` 与「夹具」\n\n## 第一节\n\n[a](#starttesthost-与夹具) [b](#第一节-1) [c](#第二节) [d](missing.md) [e](https://example.com/x) \`[f](nope.md)\`\n`,
        }),
      ),
    )
    expect(problems).toEqual([
      'docs/TESTING.md:14：链接 #第二节 的锚点在 docs/TESTING.md 中没有对应的标题',
      'docs/TESTING.md:14：链接 missing.md 指向不存在的路径',
    ])
  })

  it('reports paths an instruction names that are not in the repository, but not placeholders, globs, URLs, packages or ignored paths', async () => {
    const problems = await checkAgentDocs(
      repository(
        valid({
          'apps/app/AGENTS.md':
            '# app\n\n`src/main.ts`、`main.ts`、`src/{main,index}.ts`、`src/gone.ts`、`old.ts`、`tests/helpers/host.ts`、`<目录>/x.ts`、`*.e2e.ts`、`R0/R1/R2`、`react-dom/server`、`@latch/x/y`、`latch://app/`、`dist/start.js`\n\n```sh\npnpm exec vitest run --config vitest.config.ts test/missing.test.ts\n```\n',
          'vitest.config.ts': 'export default {}\n',
        }),
        { ignored: ['dist'] },
      ),
    )
    expect(problems).toEqual([
      'apps/app/AGENTS.md:3：`src/gone.ts` 在仓库中不存在',
      'apps/app/AGENTS.md:3：`old.ts` 在仓库中不存在',
      'apps/app/AGENTS.md:3：`tests/helpers/host.ts` 在仓库中不存在',
      'apps/app/AGENTS.md:6：`test/missing.test.ts` 在仓库中不存在',
    ])
  })

  it('reports a cited test whose file is missing or whose name is not a title in it', async () => {
    const problems = await checkAgentDocs(
      repository(
        valid({
          'apps/app/AGENTS.md': '# app\n\n- `test/main.test.ts#main > stops`\n- `test/gone.test.ts#starts`\n- `test/main.test.ts#starts`\n',
        }),
      ),
    )
    expect(problems).toEqual([
      'apps/app/AGENTS.md:3：apps/app/test/main.test.ts 中没有名为 "stops" 的用例或分组',
      'apps/app/AGENTS.md:4：测试文件 test/gone.test.ts 不存在',
    ])
  })

  it('reports a workspace project that the root code map leaves out', async () => {
    expect(await checkAgentDocs(repository(valid()), { projects: ['.', 'apps/app', 'packages/new'] })).toEqual([
      'AGENTS.md：代码地图没有列出 workspace 项目 `packages/new/`',
    ])
  })

  it('keeps one link in .claude/skills for each skill in .agents/skills and nothing else', async () => {
    const contents = valid({
      '.agents/skills/good/SKILL.md': skill('good'),
      '.agents/skills/renamed/SKILL.md': skill('other'),
      '.agents/skills/Bad_Name/SKILL.md': skill('Bad_Name', ''),
      '.agents/skills/unlinked/SKILL.md': skill('unlinked'),
      '.agents/skills/empty/notes.txt': 'x',
      '.claude/skills/copied/SKILL.md': skill('copied'),
    })
    const links = {
      '.claude/skills/good': skillLinkTarget('good'),
      '.claude/skills/renamed': '../elsewhere/renamed',
      '.claude/skills/Bad_Name': skillLinkTarget('Bad_Name'),
      '.claude/skills/stale': skillLinkTarget('stale'),
    }
    expect(await checkAgentDocs(repository(contents, { links }))).toEqual([
      '.agents/skills/Bad_Name/SKILL.md：技能名只能用小写字母、数字与单个连字符，最多 64 个字符',
      '.agents/skills/Bad_Name/SKILL.md：front matter 的 description 应为 1 到 1024 个字符',
      '.agents/skills/empty：缺少 SKILL.md',
      '.agents/skills/renamed/SKILL.md：front matter 的 name 应为目录名 renamed',
      '.claude/skills/renamed：链接指向 ../elsewhere/renamed，应为 ../../.agents/skills/renamed，运行 pnpm agents:sync',
      '.claude/skills/unlinked：缺少指向 ../../.agents/skills/unlinked 的链接，运行 pnpm agents:sync',
      '.claude/skills/copied：.agents/skills 中没有这个技能；技能只写在 .agents/skills，运行 pnpm agents:sync',
      '.claude/skills/stale：.agents/skills 中没有这个技能；技能只写在 .agents/skills，运行 pnpm agents:sync',
    ])
  })

  it('reads the front matter of docs/*.md and reports a missing description, empty sources or a source that does not exist', async () => {
    const repo = repository(
      valid({
        'docs/A.md': '# 没有 front matter\n',
        'docs/B.md': '---\nsources: []\n---\n# B\n',
        'docs/C.md': '---\ndescription: C\nsources:\n  - src\n  - apps/gone\n---\n# C\n',
        'docs/sub/D.md': '# 子目录不检查\n',
      }),
    )
    const { docs, problems } = await readDocSources(repo)
    expect(problems).toEqual([
      'docs/A.md：缺少开头的 front matter（description 与 sources）',
      'docs/B.md：front matter 缺少 description',
      'docs/B.md：front matter 的 sources 应为非空的路径列表',
      'docs/C.md：sources 中的 "apps/gone" 不存在',
    ])
    expect(docs.map(doc => [doc.path, doc.sources])).toEqual([
      ['docs/B.md', []],
      ['docs/C.md', ['src', 'apps/gone']],
      ['docs/TESTING.md', ['src']],
    ])
  })

  it('gives headings GitHub anchors: lower case, punctuation removed, spaces to hyphens, numbered repeats', () => {
    expect([
      ...headingAnchors(
        '# Latch 测试指南\n## `startTestHost()`\n## Electron e2e\n## Electron e2e\n```sh\n# not a heading\n```\n### host.json 与数据目录锁\n',
      ),
    ]).toEqual(['latch-测试指南', 'starttesthost', 'electron-e2e', 'electron-e2e-1', 'hostjson-与数据目录锁'])
  })
})

describe('documents a change may affect', () => {
  it('lists docs whose sources cover a changed path, the AGENTS.md above it, and the root map when directories come or go', () => {
    const docs = [
      { path: 'docs/A.md', description: 'A', sources: ['apps/host/src'] },
      { path: 'docs/B.md', description: 'B', sources: ['apps/web/', 'README.md'] },
    ]
    const agents = ['AGENTS.md', 'apps/host/AGENTS.md', 'apps/web/AGENTS.md']
    const changes = [
      { status: 'M', path: 'apps/host/src/server.ts' },
      { status: 'R', path: 'apps/host/src/new.ts', from: 'apps/host/src/old.ts' },
      { status: 'M', path: 'apps/host/srcx/file.ts' },
      { status: 'M', path: 'docs/A.md' },
    ]
    expect(affectedDocs(docs, agents, changes, { added: ['apps/host/srcx'], removed: [] })).toEqual([
      { path: 'AGENTS.md', because: ['apps/host/srcx/'], edited: false },
      {
        path: 'apps/host/AGENTS.md',
        because: ['apps/host/src/new.ts', 'apps/host/src/old.ts', 'apps/host/src/server.ts', 'apps/host/srcx/file.ts'],
        edited: false,
      },
      { path: 'docs/A.md', because: ['apps/host/src/new.ts', 'apps/host/src/old.ts', 'apps/host/src/server.ts'], edited: true },
    ])
  })
})
