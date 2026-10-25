import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { HarnessPlugin, ToolDefinition } from '@latch/sdk'

export const LONG_TASK_MS = 30_000
const CONTENT_LIMIT = 64 * 1024

type ExecutionContext = Parameters<ToolDefinition['execute']>[1]

async function writeArtifact(prefix: 'report' | 'completion', content: string, context: ExecutionContext): Promise<{ text: string }> {
  const { signal, sessionId } = context
  signal.throwIfAborted()
  if (!isAbsolute(context.workspaceRoot)) throw new Error('执行工作区必须是绝对路径。')
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)) throw new Error('会话标识无效。')
  const root = resolve(context.workspaceRoot)
  const directory = join(root, 'artifacts')
  await mkdir(directory, { recursive: true })
  if ((await realpath(directory)) !== join(await realpath(root), 'artifacts')) throw new Error('产物目录不能是符号链接。')
  const path = join(directory, `${prefix}-${sessionId}.txt`)
  const temporary = join(directory, `.pending-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
    await file.close()
    signal.throwIfAborted()
    // Rename replaces an existing symlink rather than following it, and publishes one complete artifact.
    await rename(temporary, path)
  } finally {
    await file.close()
    await rm(temporary, { force: true })
  }
  return { text: `产物：${path}` }
}

/** Bounded tools are shared by real providers and the explicitly selected demo. */
export function createToolsPlugin(): HarnessPlugin {
  const report: ToolDefinition = {
    name: 'write_report',
    title: '写入报告',
    description: '经用户审批后写入当前会话的报告。仅接受可选 content，最多 64 KiB；路径由执行节点固定。',
    requiresApproval: true,
    kind: 'edit',
    parameters: { type: 'object', properties: { content: { type: 'string', maxLength: CONTENT_LIMIT } }, additionalProperties: false },
    async execute(args, context) {
      if (Object.keys(args).some(key => key !== 'content')) throw new Error('报告工具只接受 content，不接受路径或其他参数。')
      if (args.content !== undefined && typeof args.content !== 'string') throw new Error('报告内容必须是字符串。')
      const content = args.content ?? `Latch 报告\n会话：${context.sessionId}\n用户已批准此文件写入。\n`
      if (Buffer.byteLength(content, 'utf8') > CONTENT_LIMIT) throw new Error('报告内容不能超过 64 KiB。')
      return writeArtifact('report', content, context)
    },
  }
  const longTask: ToolDefinition = {
    name: 'long_task',
    title: '运行长任务',
    description: '运行固定 30 秒、可取消的任务，完成后写入当前会话的完成文件。不接受参数。',
    requiresApproval: false,
    kind: 'execute',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, context) {
      if (Object.keys(args).length !== 0) throw new Error('长任务不接受路径、时长或其他参数。')
      context.signal.throwIfAborted()
      await delay(LONG_TASK_MS, undefined, { signal: context.signal })
      return writeArtifact('completion', `Latch 长任务\n会话：${context.sessionId}\n固定 30 秒任务已完成。\n`, context)
    },
  }
  return {
    id: 'safe-tools',
    name: '安全文件工具',
    version: '1.0.0',
    description: '需要审批的报告写入，以及固定 30 秒的可取消任务；文件只能写入执行节点的 artifacts 目录。',
    activate(context) {
      context.registerTool(report)
      context.registerTool(longTask)
    },
  }
}
