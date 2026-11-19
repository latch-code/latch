/**
 * A Claude configuration directory of the test's own, with hand-written transcripts in the shape Claude Code 2.1 writes
 * them, for the real Agent SDK's session functions to read through Latch's store reader. Nothing here touches the
 * person's `~/.claude`: `HOME` and `CLAUDE_CONFIG_DIR` both point into the test's temporary directory.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ClaudeFixture {
  root: string
  home: string
  config: string
  project: string
  env: Record<string, string>
  /** Where Claude keeps the project's transcripts. */
  projectDir: string
  write(sessionId: string, lines: Array<Record<string, unknown>>): Promise<string>
  remove(): Promise<void>
}

export const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export async function claudeFixture(): Promise<ClaudeFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-claude-store-')))
  const home = join(root, 'home')
  const config = join(home, '.claude-test')
  const project = join(root, 'project')
  await mkdir(config, { recursive: true })
  await mkdir(project, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: project })
  const projectDir = join(config, 'projects', project.replace(/[^a-zA-Z0-9]/gu, '-'))
  await mkdir(projectDir, { recursive: true })
  return {
    root,
    home,
    config,
    project,
    projectDir,
    env: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: root },
    async write(sessionId, lines) {
      const file = join(projectDir, `${sessionId}.jsonl`)
      await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
      return file
    },
    remove: () => rm(root, { recursive: true, force: true }),
  }
}

let clock = Date.parse('2026-11-01T00:00:00Z')
const at = () => new Date((clock += 1000)).toISOString()

/** The fields every line of one session shares. */
export function line(sessionId: string, cwd: string, entrypoint = 'cli') {
  return (fields: Record<string, unknown>) => ({
    sessionId,
    cwd,
    version: '2.1.328',
    gitBranch: 'main',
    userType: 'external',
    entrypoint,
    isSidechain: false,
    timestamp: at(),
    ...fields,
  })
}

/** A person's prompt. */
export const prompt = (uuid: string, parentUuid: string | null, content: unknown) => ({
  type: 'user',
  uuid,
  parentUuid,
  message: { role: 'user', content },
})

/** Claude's answer: one message of blocks. */
export const answer = (uuid: string, parentUuid: string, id: string, content: unknown[]) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  message: { id, role: 'assistant', model: 'claude-x', content },
})

/** A tool's result, as the user line that carries it. */
export const result = (uuid: string, parentUuid: string, toolUseId: string, text: string, isError = false) => ({
  type: 'user',
  uuid,
  parentUuid,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, ...(isError ? { is_error: true } : {}) }],
  },
})
