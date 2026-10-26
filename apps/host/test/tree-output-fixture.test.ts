import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'

it.each([true, false])('settles both real Host rounds in the saved project root (wait for prior settlement: %s)', async waitForPrior => {
  let source = ''
  const prompts: string[] = []
  const plugin: HarnessPlugin = {
    id: 'tree-output-model',
    name: 'Tree fixture',
    description: '',
    version: '1',
    activate(context) {
      context.registerProvider({
        id: 'tree-output-model',
        name: 'Tree fixture',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = messages.at(-1)?.content
          if (typeof prompt === 'string') {
            prompts.push(prompt)
            if (/^新增 \d+-(?:light|dark)$/u.test(prompt))
              await writeFile(join(source, 'src', `generated-${prompt.slice(3)}.txt`), 'Observed real file change\n')
          }
          yield { type: 'text', text: '已完成本地文件检查。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [plugin] })
  try {
    source = join(host.root, 'project')
    await mkdir(join(source, 'src'), { recursive: true })
    source = await realpath(source)
    await writeFile(join(source, 'src/original.ts'), 'export const original = true;\n')
    const owner = await host.enroll({ listener: 'unix' })
    const added = await owner.addFolders({ name: 'Tree output project', paths: [source] })
    expect(added.status).toBe(201)
    const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        prompt: '准备 390-light',
        mode: 'agent',
        workspaceId: project.id,
        model: { providerId: 'tree-output-model', model: 'fixture' },
      },
    })
    const detail = () => owner.json<TaskDetail>('tasks/' + sessionId)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    if (waitForPrior)
      await expect.poll(async () => (await detail()).messages.some(message => message.outputsPending), { timeout: 10_000 }).toBe(false)
    const firstId = (await detail()).messages.find(message => message.role === 'assistant')!.id
    expect((await detail()).summary).toMatchObject({ mode: 'agent', cwd: source, folders: project.folders })
    await owner.json('tasks/' + sessionId + '/prompt', { method: 'POST', body: { requestId: randomUUID(), prompt: '新增 390-light' } })
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    expect(prompts).toEqual(['准备 390-light', '新增 390-light'])
    expect(await readFile(join(source, 'src/generated-390-light.txt'), 'utf8')).toBe('Observed real file change\n')
    // Settlement intentionally follows execution; the file-tree test must await this authority rather than sleep.
    await expect
      .poll(
        async () =>
          (await detail()).messages.some(message =>
            message.outputs?.some(
              file => file.root === project.folders![0]!.id && file.path === 'src/generated-390-light.txt' && file.change === 'created',
            ),
          ),
        { timeout: 10_000 },
      )
      .toBe(true)
    await expect.poll(async () => (await detail()).messages.some(message => message.outputsPending), { timeout: 10_000 }).toBe(false)
    expect((await detail()).messages.some(message => message.id === firstId)).toBe(true)
  } finally {
    await host.close()
  }
})
