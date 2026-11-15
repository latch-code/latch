import { AGENT_FILE_BYTES, type AgentFileMemory } from '@latch/protocol'

const AGENT_FILE_SUFFIX = '.latch-agent.json'

/**
 * The name the browser saves an export under: the Agent's name with only letters, digits, `-` and `_` kept (so no path,
 * no dot and no hidden character reaches a file name), at most 40 characters, `agent` when nothing is left.
 */
export function exportFileName(name: string): string {
  const kept = [...name.normalize('NFKC')]
    .map(letter => (/[\p{L}\p{N}_-]/u.test(letter) ? letter : '-'))
    .join('')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return `${[...kept].slice(0, 40).join('') || 'agent'}${AGENT_FILE_SUFFIX}`
}

/** What the person chose, read on this device before the Host sees it: too large, or not JSON, never reaches the Host. */
export function readAgentFileText(text: string, bytes: number): { file: unknown } | { problem: string } {
  if (bytes > AGENT_FILE_BYTES) return { problem: '文件太大，最多 4 MiB。' }
  try {
    return { file: JSON.parse(text) as unknown }
  } catch {
    return { problem: '读不了这个文件：它不是 Agent 导出文件。' }
  }
}

/** How the imported file labels the author of a memory. */
export function fileMemoryWords(memory: Pick<AgentFileMemory, 'origin'>): string {
  return memory.origin === 'user' ? '文件标注：用户' : '文件标注：Agent'
}
