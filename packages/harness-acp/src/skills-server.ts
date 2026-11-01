import { chmod, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeFileAtomic } from '@latch/core/node-kit'
import type { AgentSkillBody } from '@latch/protocol'

/**
 * Read-only MCP over stdio: it lists an agent's skills and returns their text. No other tools, no writes, no network.
 * Passed to `node -e` so the agent starts it without any file of Latch's being on its path.
 */
const SERVER_SOURCE = String.raw`
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const skills = JSON.parse(readFileSync(join(process.argv[1], 'skills.json'), 'utf8'))
const MAX_LINE = 1024 * 1024
const tools = [
  { name: 'list_skills', description: 'List the skills this agent may use.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'read_skill',
    description: 'Read one skill by its id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
]
const text = value => ({ content: [{ type: 'text', text: value }] })
function call(params) {
  if (params?.name === 'list_skills') return text(JSON.stringify(skills.map(({ id, name, description }) => ({ id, name, description }))))
  if (params?.name === 'read_skill') {
    const found = skills.find(skill => skill.id === params.arguments?.id)
    return found ? text(found.content) : { ...text('No such skill.'), isError: true }
  }
  throw Object.assign(new Error('Unknown tool'), { code: -32602 })
}
function answer(method, params) {
  if (method === 'initialize')
    return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'latch-skills', version: '1' } }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools }
  if (method === 'tools/call') return call(params)
  throw Object.assign(new Error('Method not found'), { code: -32601 })
}
function handle(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request?.id === undefined) return
  let reply
  try {
    reply = { result: answer(request.method, request.params) }
  } catch (error) {
    reply = { error: { code: error.code ?? -32603, message: error.message } }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }) + '\n')
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (line.trim()) handle(line)
  }
  if (buffer.length > MAX_LINE) buffer = ''
})
process.stdin.on('end', () => process.exit(0))
`

export function skillsDirectory(dataDir: string, taskId: string): string {
  return join(dataDir, 'skills', createHash('sha256').update(taskId).digest('hex').slice(0, 32))
}

/** The copy this session's server reads: what the agent held when the session started, as with every other engine. */
export async function writeSessionSkills(directory: string, skills: readonly AgentSkillBody[]): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await writeFileAtomic(join(directory, 'skills.json'), JSON.stringify(skills))
}

export async function removeSessionSkills(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}

/** An entry of `mcpServers` in ACP's session/new, session/resume and session/load. */
export function skillsServer(directory: string): { name: string; command: string; args: string[]; env: never[] } {
  return { name: 'latch-skills', command: process.execPath, args: ['--disable-sigusr1', '-e', SERVER_SOURCE, directory], env: [] }
}
