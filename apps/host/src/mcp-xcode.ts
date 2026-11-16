// 「Xcode」: one step to add Apple's own MCP bridge (`xcrun mcpbridge`, part of Xcode) as a local-command MCP server, so
// an agent can build, run and use an app on a simulator through Xcode's tools. Latch finds Xcode, reads its version and
// fills in the definition itself; the add goes through the same confirmation, audit and per-tool switches as any
// server. Latch never changes Xcode's settings (the person allows external agents there) and never runs the headless,
// sudo mode. See docs/DEVICE-PREVIEW.md.
import { execFile } from 'node:child_process'
import type { McpXcodeCheck } from '@latch/protocol'
import { compareVersions } from '@latch/harness-acp'

/** The server's name, as agents see it (`mcp__xcode__DeviceInteractionSynthesize`). */
export const XCODE_NAME = 'xcode'
export const XCODE_COMMAND = '/usr/bin/xcrun'
export const XCODE_ARGS: readonly string[] = ['mcpbridge']
/** The first Xcode whose bridge has the device interaction tools (Xcode 27; the bridge itself came with 26.3). */
const XCODE_MINIMUM = '27.0'

/**
 * The tools Xcode 27.2's bridge lists (`xcrun mcpbridge` 25464, read from outside Xcode on 2026-11-17; the shapes are in
 * `xcode-mcpbridge-tools.json` with the Host's tests). Any other name a later Xcode lists is new and off until switched on.
 */
export const XCODE_KNOWN_TOOLS: readonly string[] = [
  // Device interaction: a session on a simulator or device, install and run, input; each step leaves a screenshot and
  // the UI hierarchy in files whose paths it returns.
  'DeviceInteractionStartSession',
  'DeviceInteractionStartWorkspaceSession',
  'DeviceInteractionInstallAndRun',
  'DeviceInteractionSynthesize',
  'DeviceInteractionEndSession',
  // Building, running, testing, previews and their logs.
  'BuildProject',
  'GetBuildLog',
  'RunProject',
  'StopProject',
  'GetConsoleOutput',
  'GetTestList',
  'RunAllTests',
  'RunSomeTests',
  'RenderPreview',
  'GetTargetBuildSettings',
  'GetFileCompilerFlags',
  // Reading the project; choosing what runs where; opening the project, which is what asks the person to approve the agent.
  'XcodeRead',
  'XcodeLS',
  'XcodeGlob',
  'XcodeGrep',
  'XcodeRefreshCodeIssuesInFile',
  'XcodeListWorkspaces',
  'XcodeListSchemes',
  'XcodeListTargets',
  'XcodeListTestPlans',
  'XcodeListTemplates',
  'XcodeListRunDestinations',
  'XcodeSwitchRunDestination',
  'XcodeSwitchScheme',
  'XcodeSwitchTestPlan',
  'XcodeOpenWorkspace',
  'XcodeCloseWorkspace',
  'StringCatalogRead',
  'StringCatalogContext',
  'DocumentationSearch',
  // Off when added (below).
  'XcodeWrite',
  'XcodeUpdate',
  'XcodeMakeDir',
  'XcodeRM',
  'XcodeMV',
  'XcodeNewProject',
  'XcodeNewTarget',
  'AddEntitlement',
  'AddInfoPlist',
  'UpdateTargetBuildSetting',
  'UpdateFileCompilerFlags',
  'StringCatalogEdit',
  'LocalizationPlanner',
  'RunCodeSnippet',
  'InvokeDebuggerCommand',
  'GetCrashIssueLogs',
  'GetFieldPerformanceIssueLogs',
  'GetTopCrashIssues',
  'GetTopFieldPerformanceIssues',
]

/**
 * Off when added; the person may switch any on. Whatever creates, edits, moves or deletes project files, targets,
 * entitlements and build settings (the agent has its own file tools, which Latch's records and the person's review
 * already cover); running code in Xcode or the debugger; and reading the App Store's crash and performance reports, which
 * are the account's data.
 */
export const XCODE_TOOLS_OFF: readonly string[] = [
  'XcodeWrite',
  'XcodeUpdate',
  'XcodeMakeDir',
  'XcodeRM',
  'XcodeMV',
  'XcodeNewProject',
  'XcodeNewTarget',
  'AddEntitlement',
  'AddInfoPlist',
  'UpdateTargetBuildSetting',
  'UpdateFileCompilerFlags',
  'StringCatalogEdit',
  'LocalizationPlanner',
  'RunCodeSnippet',
  'InvokeDebuggerCommand',
  'GetCrashIssueLogs',
  'GetFieldPerformanceIssueLogs',
  'GetTopCrashIssues',
  'GetTopFieldPerformanceIssues',
]

const ACTING = new Set([
  'DeviceInteractionStartSession',
  'DeviceInteractionStartWorkspaceSession',
  'DeviceInteractionInstallAndRun',
  'DeviceInteractionSynthesize',
  'BuildProject',
  'RunProject',
  'StopProject',
  'RunAllTests',
  'RunSomeTests',
  'XcodeSwitchRunDestination',
  'XcodeSwitchScheme',
  'XcodeSwitchTestPlan',
  'XcodeOpenWorkspace',
  'XcodeCloseWorkspace',
])

/**
 * How Latch classes each of Xcode's tools in its records: looking is R0; starting a device session, input, building,
 * installing, running, testing and changing what Xcode has open or targets are R1 (they act on a device, this Mac's
 * build products or Xcode's state, not on project files); the tools that are off when added, and unknown ones, are R2.
 * A full-access session runs R0 and R1 without Latch asking (the person's chosen oversight).
 */
export function xcodeToolRisk(tool: string): 'R0' | 'R1' | 'R2' {
  if (XCODE_TOOLS_OFF.includes(tool) || !XCODE_KNOWN_TOOLS.includes(tool)) return 'R2'
  return ACTING.has(tool) ? 'R1' : 'R0'
}

/** A device session begins or ends with these: the 设备 panel says an agent is using the device in between. */
export const XCODE_SESSION_START = new Set(['DeviceInteractionStartSession', 'DeviceInteractionStartWorkspaceSession'])
export const XCODE_SESSION_END = 'DeviceInteractionEndSession'

/** The same rules as a built-in skill in `latch-skills`, for a session that has it. */
export const XCODE_GUIDE_SKILL = {
  id: 'latch-xcode-devices',
  name: 'xcode-devices',
  description: "How to use the xcode server's device tools under Latch's rules. Read before the first device call.",
} as const

/**
 * What the bridge gives the agent in place of Xcode's own `instructions` (one sentence, kept at the end): Latch's rules
 * for both tool sets, short, since the MCP `instructions` reach the model of most harnesses whole.
 */
export const XCODE_INSTRUCTIONS = [
  'Latch: rules for Xcode’s tools on this Mac.',
  '- Xcode refuses an agent it has not approved. Open the project first with XcodeOpenWorkspace (its absolute path): Xcode then asks the person to approve this agent and the folder. Wait for them; never try to get around it.',
  '- Use the simulator the person shows in Latch’s 设备 panel (device_list on the latch-browser server marks it) and pass its UDID as deviceIdentifier, never a guess by name.',
  '- Start a device session (DeviceInteractionStartWorkspaceSession to build and run the project, DeviceInteractionStartSession otherwise) and end it with DeviceInteractionEndSession when done: sessions are costly.',
  '- DeviceInteractionSynthesize leaves a screenshot and the UI hierarchy in files whose paths it returns: read the hierarchy before the next step. Tap at the hierarchy’s hitPoint of the element (by accessibility identifier, then label); estimated coordinates last.',
  '- Build, install and run with DeviceInteractionInstallAndRun or BuildProject; verify at checkpoints, not after every step.',
  '- Stop and ask the person at any sign-in, payment or system-permission dialog. Never sign in with real accounts.',
  '- Never erase, delete or shut down devices; the person starts and stops them in Latch.',
  '- Latch’s own device_* tools list devices, take a screenshot, open a URL and set light or dark without Xcode; use Xcode’s tools to build, install, run and for input.',
  '- Tools that edit project files or settings, run code or read App Store reports are switched off in Latch; use your own file tools.',
  'Xcode’s own words: Request Xcode perform the action you specify.',
].join('\n')

const RUN_MS = 5_000

function run(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      file,
      [...args],
      {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
        timeout: RUN_MS,
        maxBuffer: 4096,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => resolve(error ? undefined : String(stdout)),
    )
  })
}

/** Where the Host looks for Xcode; only the start script sets it, on macOS. */
export interface XcodeBridgeOptions {
  /** Tests: stands in for `xcrun -f mcpbridge` and `xcodebuild -version`. */
  probe?: () => Promise<{ bridge: boolean; version?: string }>
  /** Tests: a stand-in program for `/usr/bin/xcrun` in the definition. Production never sets it. */
  command?: string
}

async function probeXcode(): Promise<{ bridge: boolean; version?: string }> {
  const [bridge, about] = await Promise.all([run(XCODE_COMMAND, ['-f', 'mcpbridge']), run(XCODE_COMMAND, ['xcodebuild', '-version'])])
  const version = /^Xcode (\d+(?:\.\d+){0,2})\s*$/mu.exec(about ?? '')?.[1]
  return { bridge: !!bridge?.trim(), ...(version ? { version } : {}) }
}

/**
 * Whether Xcode's bridge is here: no Xcode or no bridge (`absent`), older than the minimum (`old`), or `ok`. Only
 * `xcrun -f` and `xcodebuild -version` run; the bridge itself does not, since it may start Xcode.
 */
export async function checkXcodeBridge(options: XcodeBridgeOptions = {}): Promise<Omit<McpXcodeCheck, 'added'>> {
  const found = await (options.probe ?? probeXcode)()
  const base = { minimum: XCODE_MINIMUM, command: `${XCODE_COMMAND} ${XCODE_ARGS.join(' ')}` }
  if (!found.bridge) return { ...base, state: 'absent' }
  const full = (version: string) => [...version.split('.'), '0', '0'].slice(0, 3).join('.')
  const order = found.version === undefined ? undefined : compareVersions(full(found.version), full(XCODE_MINIMUM))
  return { ...base, ...(found.version ? { version: found.version } : {}), state: order === undefined || order < 0 ? 'old' : 'ok' }
}
