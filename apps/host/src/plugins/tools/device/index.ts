import { SIMULATOR_INPUT_TOOLS } from '@latch/protocol'
import type { HarnessPlugin, ToolDefinition, ToolResult } from '@latch/sdk'

/** The tools' names, as the Host's classifier and audit know them. */
const DEVICE_TOOLS = [
  'device_list',
  'device_screenshot',
  'device_open_url',
  'device_set_appearance',
  'device_rotate',
  'device_apps',
  'device_launch',
  ...SIMULATOR_INPUT_TOOLS,
] as const
export type DeviceTool = (typeof DEVICE_TOOLS)[number]
export const isDeviceTool = (name: string): name is DeviceTool => (DEVICE_TOOLS as readonly string[]).includes(name)
/** Looking is R0 (the list, a picture, the apps); opening, turning, switching or starting acts on the device, R1. */
export const DEVICE_READS: ReadonlySet<DeviceTool> = new Set(['device_list', 'device_screenshot', 'device_apps'])
/** Tapping, swiping, typing and pressing: only for a full-access session a person started (see the Host). */
export const DEVICE_INPUTS: ReadonlySet<DeviceTool> = new Set(SIMULATOR_INPUT_TOOLS)

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
  'simulator-rotate-unsupported': '这台设备不能旋转（devicectl 没有为它提供方向）。This device cannot be rotated.',
  'simulator-rotate-failed': '设备没有转动；不要重复调用，请截图核对。The device did not turn; take a screenshot instead of retrying.',
  'simulator-app-not-found':
    '这台设备上没有这个 App；先用 device_apps 取它的 bundle id。No such app on the device: take its bundle id from device_apps.',
  'invalid-input': '参数无效（坐标用屏幕上的点，不是像素，并且要在屏幕内）。Invalid arguments: points, not pixels, inside the screen.',
  'simulator-input-unavailable':
    '这台设备现在不能输入（需要人在这台 Mac 上安装 idb_companion，或它没有回答）；不要重复调用，请人在设备面板里操作。Input is unavailable on this device; do not retry, ask the person.',
  'simulator-input-failed':
    '输入没有送到设备；不要重复发送，先截图核对。The input did not reach the device; take a screenshot before anything else.',
  'simulator-text-unsupported':
    '只能输入可打印的 ASCII 字符（字母、数字、常用标点、空格），这段文字里有别的字符，一个字都没有输入；请人在 Device Hub 里输入。Only printable ASCII can be typed; nothing was typed.',
  'simulator-input-rate': '输入太快了，稍后再试。',
  'not-full-access-input':
    '设备输入工具只给完全访问的外部 Harness 会话。The device input tools run only in a full-access session of an external harness.',
  'personal-input': '我的 Agent 的会话不能向模拟器输入。My Agent sessions cannot send input to a simulator.',
  unattended: '没有人值守的运行不能向设备输入。Unattended runs cannot send input to a device.',
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
      'Open an address on this Mac (localhost, *.localhost, 127.0.0.1, ::1) in a running simulator. Other addresses and deep links are refused: ask the person to open them from the 设备 panel. Build, install and run apps with xcodebuild and xcrun simctl in your own shell.',
    parameters: object({ udid, url: { type: 'string', maxLength: 2048 } }, ['udid', 'url']),
  },
  {
    name: 'device_set_appearance',
    title: '设置模拟器外观',
    kind: 'other',
    description: "Set a running simulator's appearance to light or dark.",
    parameters: object({ udid, appearance: { type: 'string', enum: ['light', 'dark'] } }, ['udid', 'appearance']),
  },
  {
    name: 'device_rotate',
    title: '旋转模拟器',
    kind: 'other',
    description:
      'Turn a running simulator a quarter turn left or right. The answer is the orientation read back afterwards; if it says the device did not turn, take a screenshot rather than retrying.',
    parameters: object({ udid, direction: { type: 'string', enum: ['left', 'right'] } }, ['udid', 'direction']),
  },
  {
    name: 'device_apps',
    title: '列出模拟器上的 App',
    kind: 'read',
    description:
      "The apps on a running simulator that are not hidden: bundle id, name, and whether it is the person's own or the system's.",
    parameters: object({ udid }, ['udid']),
  },
  {
    name: 'device_launch',
    title: '在模拟器上启动 App',
    kind: 'other',
    description:
      'Start an app on a running simulator by a bundle id from device_apps, with no arguments. To run a new build, install it with xcrun simctl in your own shell first.',
    parameters: object({ udid, bundleId: { type: 'string', maxLength: 155 } }, ['udid', 'bundleId']),
  },
  {
    name: 'device_tap',
    title: '点按模拟器',
    kind: 'other',
    description:
      'Tap a running simulator at a point, in points (not pixels) of the screen as it is shown, upright or turned. holdMs above 500 is a long press. Take a screenshot first and after. Within 4 points of an edge the system may take it as a gesture (back, Home, notifications). If it fails, stop and screenshot; do not repeat it.',
    parameters: object(
      {
        udid,
        x: { type: 'number', minimum: 0, maximum: 10000 },
        y: { type: 'number', minimum: 0, maximum: 10000 },
        holdMs: { type: 'integer', minimum: 0, maximum: 5000 },
      },
      ['udid', 'x', 'y'],
    ),
  },
  {
    name: 'device_swipe',
    title: '在模拟器上滑动',
    kind: 'other',
    description:
      'Drag one finger from one point to another on a running simulator, in points, over durationMs (default 300, at most 5000). Scrolling content moves the opposite way to the finger. One finger only: there is no pinch. Starting within 4 points of an edge is a system gesture.',
    parameters: object(
      {
        udid,
        fromX: { type: 'number', minimum: 0, maximum: 10000 },
        fromY: { type: 'number', minimum: 0, maximum: 10000 },
        toX: { type: 'number', minimum: 0, maximum: 10000 },
        toY: { type: 'number', minimum: 0, maximum: 10000 },
        durationMs: { type: 'integer', minimum: 50, maximum: 5000 },
      },
      ['udid', 'fromX', 'fromY', 'toX', 'toY'],
    ),
  },
  {
    name: 'device_type_text',
    title: '在模拟器上输入文字',
    kind: 'other',
    description:
      "Type printable ASCII (letters, digits, common punctuation, spaces) key by key into the focused field, at most 1000 characters. Only while the device's own keyboard is English (US) QWERTY: on any other keyboard (Pinyin, other layouts) or with any other character the call is refused whole and says why; nothing is typed in part. Tap the field first, then take a screenshot to check the result (the device may auto-correct or capitalise).",
    parameters: object({ udid, text: { type: 'string', maxLength: 1000 } }, ['udid', 'text']),
  },
  {
    name: 'device_press_key',
    title: '在模拟器上按键',
    kind: 'other',
    description:
      'Press one key on a running simulator: return, delete, tab, escape or an arrow. Check which field has focus with a screenshot first.',
    parameters: object({ udid, key: { type: 'string', enum: ['return', 'delete', 'tab', 'escape', 'left', 'right', 'up', 'down'] } }, [
      'udid',
      'key',
    ]),
  },
  {
    name: 'device_press_button',
    title: '按模拟器的硬件按钮',
    kind: 'other',
    description: 'Press a hardware button of a running simulator: home, lock, side or siri. Rotate with device_rotate.',
    parameters: object({ udid, button: { type: 'string', enum: ['home', 'lock', 'side', 'siri'] } }, ['udid', 'button']),
  },
]

/**
 * The built-in harness's simulator tools. Each call goes to the Host, which classifies it (`classifyDeviceCall`),
 * records it and runs simctl; only the Host-owned instance of this plugin gets these classes.
 */
export function createDeviceToolsPlugin(backend: DeviceBackend): HarnessPlugin {
  // Input goes only to full-access sessions, which the built-in harness never is: it gets the other tools.
  const tools: ToolDefinition[] = DEVICE_TOOL_DEFINITIONS.filter(definition => !DEVICE_INPUTS.has(definition.name as DeviceTool)).map(
    definition => ({
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
    }),
  )
  return {
    id: 'device',
    name: '设备',
    version: '0.1.0',
    description:
      '内置 Agent 经 xcrun simctl 与 devicectl 查看和操作这台 Mac 上的 iOS 模拟器；点按与按键只给完全访问的外部 Harness 会话，不启动或关闭设备。',
    activate(context) {
      for (const tool of tools) context.registerTool(tool)
    },
  }
}
