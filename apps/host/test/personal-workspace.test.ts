import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { PersonalAssistant, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).toReversed()) await host.close()
})

test('uses real workspace tools in a private no-project Agent folder while protecting Host data', async () => {
  const content = 'Personal workspace fixture content',
    secret = 'HOST PRIVATE MARKER',
    seen: ModelMessage[][] = []
  let privatePath = ''
  const provider: HarnessPlugin = {
    id: 'personal-files-provider',
    name: 'fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'personal-files-provider',
        name: 'fixture',
        model: 'fixture',
        async *stream({ messages, tools }) {
          seen.push(structuredClone(messages))
          expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['write_file', 'read_file']))
          const completed = messages.filter(message => message.role === 'tool').length
          const calls = [
            { name: 'write_file', arguments: { path: 'daily.txt', content } },
            { name: 'read_file', arguments: { path: 'daily.txt' } },
            { name: 'read_file', arguments: { path: privatePath } },
          ]
          if (completed < calls.length) {
            yield { type: 'tool-call', call: { id: `personal-file-${completed}`, ...calls[completed]! } }
            yield { type: 'finish', reason: 'tool-calls' }
          } else {
            yield { type: 'text', text: 'Files verified' }
            yield { type: 'finish', reason: 'stop' }
          }
        },
      })
    },
  }
  const host = await startTestHost({ sessionFolders: true, demo: false, plugins: [provider], providerId: 'personal-files-provider' })
  hosts.push(host)
  privatePath = join(host.dataDir, 'private-marker.txt')
  await writeFile(privatePath, secret, { mode: 0o600 })
  const owner = await host.enroll({ listener: 'unix' })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: 'File assistant',
      role: 'Organize only the selected workspace',
      mode: 'agent',
      harnessId: 'standard',
      pluginIds: ['workspace-files'],
      model: { providerId: 'personal-files-provider', model: 'fixture' },
    },
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      assistantId: assistant.id,
      prompt: 'Write and read daily.txt',
    },
  })
  const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
  await expect.poll(async () => (await detail()).approvals[0]?.toolName).toBe('write_file')
  const writing = (await detail()).approvals[0]!
  expect(writing.risk).toBe('R1')
  await owner.json(`approvals/${writing.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
  await expect.poll(async () => (await detail()).summary.runOutcome).toBe('completed')
  const value = await detail(),
    folder = value.summary.cwd!
  expect(value.summary.personal).toEqual({ assistantId: assistant.id })
  expect(value.summary.workspaceId).toBe('default')
  expect(dirname(await realpath(folder))).toBe(await realpath(host.workspaceRoot))
  expect(basename(folder)).toMatch(/^\d{8}-[a-f0-9]{4}$/u)
  expect((await stat(folder)).mode & 0o777).toBe(0o700)
  expect(await readFile(join(folder, 'daily.txt'), 'utf8')).toBe(content)
  expect(value.messages.find(message => message.toolName === 'read_file' && message.state === 'completed')?.text).toContain(content)
  expect(value.messages.some(message => message.toolName === 'read_file' && message.state === 'failed')).toBe(true)
  expect(JSON.stringify(value)).not.toContain(secret)
  expect(JSON.stringify(seen)).not.toContain(secret)
  expect(await readFile(privatePath, 'utf8')).toBe(secret)
})
