import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { HarnessPlugin, ModelDelta, ModelProvider, ToolDefinition } from '../core/plugins.ts'

export const LONG_TASK_MS = 30_000
const CONTENT_LIMIT = 64 * 1024

async function* textStream(text: string, signal: AbortSignal, interval = 10): AsyncIterable<ModelDelta> {
  const characters = Array.from(text)
  for (let offset = 0; offset < characters.length; offset += 12) {
    await delay(interval, undefined, { signal })
    yield { type: 'text', text: characters.slice(offset, offset + 12).join('') }
  }
  yield { type: 'usage', inputTokens: 1, outputTokens: characters.length }
  yield { type: 'finish', reason: 'stop' }
}

/** Deterministic model used only when the user chooses the demo provider. */
export function createDemoPlugin(): HarnessPlugin {
  const provider: ModelProvider = {
    id: 'demo', name: '确定性演示（不调用外部模型）', model: 'demo',
    async *stream({ messages, tools, signal }) {
      signal.throwIfAborted()
      const lastUser = messages.findLastIndex(message => message.role === 'user')
      const prompt = messages[lastUser]?.content ?? ''
      if (/流式|streaming/iu.test(prompt)) {
        const preview = [
          '## 一段工作，在不同设备上继续',
          '',
          '这是 **Latch 的流式演示**。内容来自确定性演示模型，用于检查排版、阅读位置和取消；不会调用外部模型。',
          '',
          '### 阅读与执行分开处理',
          '',
          '- 向上滚动时，新的文字不会把你拉回底部。',
          '- 点击「回到最新」后，继续跟随正在输出的内容。',
          '- 工具执行、等待确认和正文回复使用不同的状态。',
          '',
          '| 场景 | 页面行为 |',
          '| --- | --- |',
          '| 暂时离线 | 保留已读记录，恢复后同步 |',
          '| 取消任务 | 等待执行端确认，保留部分回复 |',
          '| 查看历史 | 停止自动跟随，保留阅读位置 |',
          '',
          '### 一个读取状态的例子',
          '',
          '下面是浏览器读取当前节点快照的示例，可用代码块上的按钮复制：',
          '',
          '```javascript',
          'const controller = new AbortController();',
          'const response = await fetch("/link/api/snapshot", {',
          '  signal: controller.signal,',
          '  credentials: "same-origin",',
          '});',
          'const snapshot = await response.json();',
          'console.log(snapshot.tasks);',
          '```',
          '',
          '> 页面连接与任务执行是两件事。关闭页面不会自动取消执行端上的任务。',
          '',
          '你可以继续体验 **生成报告**，在另一台设备上确认写入；也可以运行可取消长任务，检查断线后的接续。',
        ].join('\n')
        yield* textStream(preview, signal, 35)
        return
      }
      const afterPrompt = messages.slice(lastUser + 1)
      const call = afterPrompt.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : [])
        .filter(item => item.name === 'write_report' || item.name === 'long_task').at(-1)
      if (call !== undefined) {
        const result = afterPrompt.findLast(message => message.role === 'tool' && message.toolCallId === call.id)
        const text = result === undefined
          ? '上一次工具调用尚无确定结果，请核对状态；不会重复执行或报告成功。'
          : result.isError
            ? `操作未完成：${result.content}。没有确认成功写入产物。`
            : `${call.name === 'write_report' ? '审批已通过，报告已写入。' : '长任务已完成，产物已写入。'}\n${result.content}`
        yield* textStream(text, signal)
        return
      }
      const toolName = /长任务|长时间|30\s*秒|等待|\blong\b|\bwait\b/iu.test(prompt) ? 'long_task'
        : /审批|批准|报告|\bapproval\b|\breport\b/iu.test(prompt) ? 'write_report' : undefined
      if (toolName === undefined) {
        yield* textStream('当前为演示模式。发送“生成需要审批的报告”或“运行 30 秒长任务”，验证跨端审批、任务持续运行与取消。', signal)
      } else if (!tools.some(tool => tool.name === toolName)) {
        yield* textStream('此会话没有提供对应工具，未执行操作。对话模式仅生成回复；可在新建 Agent 任务中验证工具与审批。', signal)
      } else {
        yield { type: 'tool-call', call: { id: `demo-${randomUUID()}`, name: toolName, arguments: {} } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 2 }
        yield { type: 'finish', reason: 'tool-calls' }
      }
    },
  }
  return {
    id: 'demo', name: '确定性演示模型', version: '1.0.0',
    description: '无需 API Key；通过真实工具、审批与文件产物验证执行流程。用量为演示值。',
    activate(context) { context.registerProvider(provider) },
  }
}

type ExecutionContext = Parameters<ToolDefinition['execute']>[1]

async function writeArtifact(prefix: 'report' | 'completion', content: string, context: ExecutionContext): Promise<{ text: string }> {
  const { signal, sessionId } = context
  signal.throwIfAborted()
  if (!isAbsolute(context.workspaceRoot)) throw new Error('执行工作区必须是绝对路径。')
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)) throw new Error('会话标识无效。')
  const root = resolve(context.workspaceRoot)
  const directory = join(root, 'artifacts')
  await mkdir(directory, { recursive: true })
  if (await realpath(directory) !== join(await realpath(root), 'artifacts')) throw new Error('产物目录不能是符号链接。')
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
    name: 'write_report', description: '经用户审批后写入当前会话的报告。仅接受可选 content，最多 64 KiB；路径由执行节点固定。',
    requiresApproval: true,
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
    name: 'long_task', description: '运行固定 30 秒、可取消的任务，完成后写入当前会话的完成文件。不接受参数。',
    requiresApproval: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, context) {
      if (Object.keys(args).length !== 0) throw new Error('长任务不接受路径、时长或其他参数。')
      context.signal.throwIfAborted()
      await delay(LONG_TASK_MS, undefined, { signal: context.signal })
      return writeArtifact('completion', `Latch 长任务\n会话：${context.sessionId}\n固定 30 秒任务已完成。\n`, context)
    },
  }
  return {
    id: 'safe-tools', name: '安全文件工具', version: '1.0.0',
    description: '需要审批的报告写入，以及固定 30 秒的可取消任务；文件只能写入执行节点的 artifacts 目录。',
    activate(context) { context.registerTool(report); context.registerTool(longTask) },
  }
}
