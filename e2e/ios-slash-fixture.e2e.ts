import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { TaskDetail } from '@latch/protocol'
import { escapeSecurityText } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { iosSlashEnvironment, prepareIosSlash } from './helpers/iosSlash.ts'

it('prepares native Slash GUI input through real Host templates and an actual fake-Agent command report', async () => {
  const host = await startTestHost()
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await prepareIosSlash(owner)
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'native-slash', name: '菜单 Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: iosSlashEnvironment },
    })
    expect(saved.status).toBe(201)
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'native-slash', mode: 'agent', workspaceId: 'default', prompt: 'plan', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.commands).toHaveLength(200)
    expect(detail.commands?.at(-1)?.name).toBe('command-199')
    expect(detail.commands?.find(command => command.name === 'command-197')?.inputHint).toBe('文件或目录')
    const direction = detail.commands?.find(command => command.name === 'command-196')?.description ?? ''
    expect(direction).toContain(String.fromCodePoint(0x202e))
    expect(escapeSecurityText(direction)).toContain('\\u{202E}')
    expect(detail.messages.filter(message => message.role === 'user')).toHaveLength(1)
    const templates = await owner.json<{ templates: Array<{ id: string; name: string; content: string }> }>('prompts')
    expect(templates.templates.find(template => template.id === 'native-review')).toMatchObject({
      name: '代码审查',
      content: '检查 $ARGUMENTS 的正确性',
    })
    expect(templates.templates.find(template => template.id === 'native-trip')?.name).toBe('重庆行程')
  } finally {
    await host.close()
  }
})
