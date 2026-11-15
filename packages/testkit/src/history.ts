import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Sessions the fake ACP agent had before any client (`FAKE_ACP_HISTORY_FILE`), shaped like what codex-acp replays: user
 * and agent text, thinking, tool calls with output. Written by hand from the adapters' sources, never read from a real CLI.
 */
export interface FakeHistorySession {
  sessionId: string
  cwd: string
  title?: string
  updatedAt?: string
  busy?: true
  /** Folders the session was granted over ACP, as OpenCode 2.x lists them with the session. */
  additionalDirectories?: string[]
  updates: Array<Record<string, unknown>>
}

/** Secret-shaped strings made at run time, so that no key-shaped text sits in the repository. */
export const FAKE_HISTORY_SECRETS = {
  openai: `sk-${'proj-'}${'Q'.repeat(24)}abcdEFGH1234`,
  gateway: `lmg1.${'A'.repeat(43)}`,
}

const text = (sessionUpdate: string, value: string) => ({ sessionUpdate, content: { type: 'text', text: value } })

/** One ordinary conversation: two turns, thinking, a command with output that holds secrets. */
export function fakeConversation(): FakeHistorySession['updates'] {
  return [
    text('user_message_chunk', `Fix the login bug. My key is ${FAKE_HISTORY_SECRETS.openai}`),
    text('agent_thought_chunk', 'hidden reasoning about the login'),
    text('agent_message_chunk', 'Looking at the login form.'),
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-env',
      title: 'Run printenv',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'printenv' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-env',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: `OPENAI_API_KEY=${FAKE_HISTORY_SECRETS.openai}\nTOKEN=${FAKE_HISTORY_SECRETS.gateway}` },
        },
      ],
    },
    text('agent_message_chunk', 'The bug is in the session check.'),
    text('user_message_chunk', 'Thanks, please also add a test.'),
    text('agent_message_chunk', 'Added the test.'),
  ]
}

/** `turns` turns whose every message is `bytes` long: over a preview's limits on both counts. */
export function fakeLongConversation(turns: number, bytes: number): FakeHistorySession['updates'] {
  return Array.from({ length: turns }, (_, index) => [
    text('user_message_chunk', `question ${index} ${'q'.repeat(bytes)}`),
    text('agent_message_chunk', `answer ${index} ${'a'.repeat(bytes)}`),
  ]).flat()
}

/** Writes the history file and returns its path. */
export async function writeFakeHistory(directory: string, sessions: FakeHistorySession[]): Promise<string> {
  const path = join(directory, 'fake-history.json')
  await writeFile(path, JSON.stringify({ sessions }))
  return path
}
