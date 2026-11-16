import type { HarnessPlugin, ToolDefinition, ToolResult } from '@latch/sdk'

/** The tools' names, as the Host's classifier and audit know them. */
const DEVICE_TOOLS = ['device_list', 'device_screenshot', 'device_open_url', 'device_set_appearance'] as const
export type DeviceTool = (typeof DEVICE_TOOLS)[number]
export const isDeviceTool = (name: string): name is DeviceTool => (DEVICE_TOOLS as readonly string[]).includes(name)
/** Looking is R0; opening an address or changing the appearance acts on the device, R1. */
export const DEVICE_READS: ReadonlySet<DeviceTool> = new Set(['device_list', 'device_screenshot'])

export type DeviceOutcome = { ok: true; text: string; image?: Buffer } | { ok: false; error: string; detail?: string }

/** The Host's side of the tools: simctl through the Host's own module, with the class and the record written first. */
export interface DeviceBackend {
  call(
    tool: DeviceTool,
    args: Record<string, unknown>,
    context: { sessionId: string; callId: string; approvalId?: string; signal: AbortSignal },
  ): Promise<DeviceOutcome>
}

/** What the model hears when a call did not happen. Boot and shutdown stay with the person in this phase. */
const FAILURES: Record<string, string> = {
  'simulator-not-booted': '设备未启动，请在设备面板里启动。The device is not running; ask the person to start it in Latch’s 设备 panel.',
  'simulator-not-found': '没有这台模拟器；先用 device_list 取 UDID。No such simulator: take its UDID from device_list.',
  'simulator-unavailable': '这台 Mac 上没有可用的模拟器（未安装 Xcode）。No simulator is available on this Mac.',
  'device-unavailable': '这台 Mac 上的 Latch 窗口没有打开，请人打开后再试。The Latch window on this Mac is not open.',
  'simulator-busy': '这台设备正在处理上一个操作，请稍后再试。',
  'simulator-picture-too-large': '画面超过 5 MB，没有截图。',
  'invalid-url': '地址无效，或不能在设备上打开这种地址（file:、javascript:、data: 等）。',
  'not-local':
    '这个地址不在这台 Mac 的本机地址上（localhost、*.localhost、127.0.0.1、::1），Agent 不能在设备上打开它；请人在设备面板里打开。Only this Mac’s own addresses; ask the person to open others from the 设备 panel.',
  'deep-link':
    'Agent 不能在设备上打开深链接（如 myapp://）：不知道是哪个 App 接收它；请人在设备面板里打开。Deep links are the person’s to open from the 设备 panel.',
  'device-scope':
    '这一轮不是由能看全部数据的设备发起的，设备工具不可用：截图会进入这个会话。The device tools run only for a turn sent from a device that sees all data.',
  'invalid-input': '参数无效。',
  'no-project': '这个会话没有项目，设备工具不可用。',
  'not-full-access': '这个会话不是完全访问的外部 Harness 会话，Latch 的设备工具不经这里给它。',
  'no-turn': '这个会话现在没有在运行的一轮，这次调用没有执行。',
  stopping: '这一轮正在停止，这次调用没有执行。',
  'audit-failed': '审计记录写入失败，这次调用没有执行。',
  cancelled: '调用已取消。',
}

export function deviceFailure(outcome: Extract<DeviceOutcome, { ok: false }>): string {
  const known = FAILURES[outcome.error]
  if (known) return known
  return outcome.detail ? `设备调用失败：${outcome.detail}` : `设备调用失败（${outcome.error}）。`
}

const udid = {
  type: 'string',
  pattern: '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$',
  description: 'The UDID of a simulator from device_list.',
}
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
})

type Definition = Pick<ToolDefinition, 'name' | 'title' | 'kind' | 'description' | 'parameters'> & { returnsImages?: boolean }

/** The tools, their words and argument schemas: the built-in harness and the `latch-browser` MCP server offer the same. */
export const DEVICE_TOOL_DEFINITIONS: readonly Definition[] = [
  {
    name: 'device_list',
    title: '列出模拟器',
    kind: 'read',
    description:
      "List this Mac's iOS simulators: UDID, name, OS version, state, and which one the person's Latch 设备 panel shows. Act on that device by its UDID, never `booted`; the person starts and shuts down devices.",
    parameters: object({}),
  },
  {
    name: 'device_screenshot',
    title: '模拟器截图',
    kind: 'read',
    description: "A PNG of a running simulator's screen, to verify at checkpoints. The picture goes to the model service.",
    parameters: object({ udid }, ['udid']),
    returnsImages: true,
  },
  {
    name: 'device_open_url',
    title: '在模拟器上打开地址',
    kind: 'fetch',
    description:
      'Open an address on this Mac (localhost, *.localhost, 127.0.0.1, ::1) in a running simulator. Other addresses and deep links are refused: ask the person to open them from the 设备 panel. This cannot tap or type: build, install and run apps with xcodebuild and xcrun simctl in your own shell (or the Xcode server, which can tap).',
    parameters: object({ udid, url: { type: 'string', maxLength: 2048 } }, ['udid', 'url']),
  },
  {
    name: 'device_set_appearance',
    title: '设置模拟器外观',
    kind: 'other',
    description: "Set a running simulator's appearance to light or dark.",
    parameters: object({ udid, appearance: { type: 'string', enum: ['light', 'dark'] } }, ['udid', 'appearance']),
  },
]

/**
 * The built-in harness's simulator tools. Each call goes to the Host, which classifies it (`classifyDeviceCall`),
 * records it and runs simctl; only the Host-owned instance of this plugin gets these classes.
 */
export function createDeviceToolsPlugin(backend: DeviceBackend): HarnessPlugin {
  const tools: ToolDefinition[] = DEVICE_TOOL_DEFINITIONS.map(definition => ({
    ...definition,
    requiresApproval: false,
    async execute(args, context): Promise<ToolResult> {
      const outcome = await backend.call(definition.name as DeviceTool, args, {
        sessionId: context.sessionId,
        callId: context.callId,
        ...(context.approvalId ? { approvalId: context.approvalId } : {}),
        signal: context.signal,
      })
      if (!outcome.ok) throw new Error(deviceFailure(outcome))
      return {
        text: outcome.text,
        ...(outcome.image ? { images: [{ mimeType: 'image/png' as const, data: outcome.image.toString('base64') }] } : {}),
      }
    },
  }))
  return {
    id: 'device',
    name: '设备',
    version: '0.1.0',
    description: '内置 Agent 经 xcrun simctl 查看和操作这台 Mac 上的 iOS 模拟器：不能点按，不启动或关闭设备。',
    activate(context) {
      for (const tool of tools) context.registerTool(tool)
    },
  }
}
