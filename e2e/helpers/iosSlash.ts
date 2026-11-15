import { randomUUID } from 'node:crypto'
import type { McpServersResponse, TaskDetail } from '@latch/protocol'
import { FAKE_MCP_STDIO, type TestDevice } from '@latch/testkit'
import { expect } from 'vitest'

/** Public fake-Agent input for the opt-in native GUI run, matching the browser Slash fixture. */
export const iosSlashEnvironment = {
  FAKE_ACP_COMMANDS: JSON.stringify(
    Array.from({ length: 200 }, (_, index) => ({
      name: `command-${String(index).padStart(3, '0')}`,
      description: index === 196 ? `检查方向字符 ${String.fromCodePoint(0x202e)} 提示` : `检查步骤 ${index}`,
      ...(index === 197 ? { input: { hint: '文件或目录' } } : {}),
    })),
  ),
  FAKE_ACP_CONFIG: 'options',
  FAKE_ACP_MODES: 'build,plan',
  FAKE_ACP_MCP: 'dsh',
} as const

/** Called only with the temporary Host fixture's owner; the App still reads templates through its body window. */
export async function prepareIosSlash(owner: TestDevice): Promise<void> {
  for (const template of [
    { id: 'native-review', name: '代码审查', content: '检查 $ARGUMENTS 的正确性', scope: { kind: 'all' } },
    { id: 'native-trip', name: '重庆行程', content: '先列出行程计划，不执行任何命令。', scope: { kind: 'all' } },
  ])
    await owner.json(`prompts/${template.id}`, { method: 'PUT', body: template })
}

/** Gives the phone both kinds of message through an actual local bridge, using only the fake MCP server. */
export async function seedIosPromptHistory(owner: TestDevice, harnessId: string): Promise<void> {
  const { revision } = await owner.json<McpServersResponse>('mcp/servers')
  await owner.confirmedJson('mcp/servers', {
    body: {
      requestId: randomUUID(),
      baseRevision: revision,
      name: 'files',
      command: process.execPath,
      args: [FAKE_MCP_STDIO],
      env: {},
      secrets: {},
      projectCwd: false,
      scope: { all: true, agents: [], projects: [] },
    },
  })
  const prompt = 'mcp-prompt files hello'
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { harnessId, mode: 'agent', prompt, requestId: randomUUID() },
  })
  const path = `tasks/${sessionId}`
  const detail = () => owner.json<TaskDetail>(path)
  await expect.poll(async () => (await detail()).summary.status).toBe('idle')
  const fetched = await detail()
  expect(fetched.messages.findLast(message => message.role === 'user')).toMatchObject({ text: prompt, origin: 'mcp-prompt' })
  expect(fetched.messages.findLast(message => message.role === 'assistant')?.text).toBe('files:hello: ok: Hello from the fake MCP server.')
  const plain = '普通消息对照'
  await owner.json(`${path}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt: plain } })
  await expect.poll(async () => (await detail()).messages.filter(message => message.role === 'user').length).toBe(2)
  await expect.poll(async () => (await detail()).summary.status).toBe('idle')
  const ordinary = (await detail()).messages.findLast(message => message.role === 'user')
  expect(ordinary?.text).toBe(plain)
  expect(ordinary?.origin).toBeUndefined()
  await owner.json(path, { method: 'PATCH', body: { title: 'MCP 来源对照' } })
}
