// 「操控这台 Mac」: one step to add Cua Driver (MIT, installed by the person) as a local-command MCP server. Latch finds
// it at its one expected place, checks its code signature and reads its `--version`, then fills in the definition
// itself; the add goes through the same confirmation, audit and per-tool switches as any server. Latch never downloads,
// installs, upgrades or starts the driver's daemon, and builds no control layer of its own. See docs/MCP.md.
import { execFile, spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpComputerCheck } from '@latch/protocol'
import { compareVersions } from '@latch/harness-acp'

/** Where the installer puts the app; the only place Latch looks. */
export const COMPUTER_APP = '/Applications/CuaDriver.app'
const PROGRAM = join('Contents', 'MacOS', 'cua-driver')
/** The server's name, as agents see it (`mcp__computer__click`). */
export const COMPUTER_NAME = 'computer'
/**
 * The oldest driver this preset relies on: `cua-driver telemetry disable` (the daemon's own off switch, since the
 * variables below reach only the `mcp` process) appears in 0.9.0, and `cua-driver revoke --all` (the stop the docs
 * name) in 0.10.0.
 */
export const COMPUTER_MINIMUM = '0.10.0'
/** A release older than seven days when this preset was written, for the install line. */
const PINNED = '0.44.0'
/**
 * The upstream installer, pinned to a release and told not to connect any agent CLI, run its own test or edit a shell
 * profile. The person runs it; Latch only shows it.
 */
const COMPUTER_INSTALL = `CUA_DRIVER_RS_VERSION=${PINNED} CUA_DRIVER_NO_CONNECT=1 CUA_DRIVER_NO_TEST=1 CUA_DRIVER_NO_MODIFY_PATH=1 /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`
/** Its code signature: the app's identifier and its developer's team, as the releases are signed. */
const REQUIREMENT = 'identifier "com.trycua.driver" and anchor apple generic and certificate leaf[subject.OU] = "YCK386LBJ7"'
/**
 * Plain variables, so they show in the confirmation. They switch off telemetry and the update check of the `mcp`
 * process; on macOS it hands calls to the CuaDriver.app daemon, which LaunchServices starts without them.
 */
export const COMPUTER_ENV: Readonly<Record<string, string>> = {
  DO_NOT_TRACK: '1',
  CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
  CUA_TELEMETRY_ENABLED: 'false',
  CUA_DRIVER_RS_UPDATE_CHECK: 'false',
}
export const COMPUTER_ARGS: readonly string[] = ['mcp']

/**
 * The tools Cua Driver 0.44.0 documents (docs/content/docs/cua-driver/reference/mcp-tools/*.mdx at the tag
 * `cua-driver-rs-v0.44.0`). Any other name a later driver lists is new, and off until switched on.
 */
export const COMPUTER_KNOWN_TOOLS: readonly string[] = [
  // Apps, windows and screen.
  'list_apps',
  'list_windows',
  'launch_app',
  'kill_app',
  'bring_to_front',
  'set_window_frame',
  'invoke_menu',
  'debug_window_info',
  'get_window_state',
  'get_accessibility_tree',
  'verify_state',
  'parse_visual_regions',
  'get_desktop_state',
  'get_screen_size',
  'get_cursor_position',
  'zoom',
  'start_session',
  'escalate_session',
  'get_session',
  'list_sessions',
  'get_session_state',
  'end_session',
  // Click and type.
  'click',
  'double_click',
  'right_click',
  'type_text',
  'press_key',
  'hotkey',
  'set_value',
  'clipboard_read',
  'clipboard_write',
  // Pointer, cursor and browser.
  'drag',
  'scroll',
  'move_cursor',
  'mouse_button_down',
  'mouse_button_up',
  'mouse_drag',
  'parallel_mouse_drag',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_theme',
  'get_agent_cursor_state',
  'page',
  'get_browser_state',
  'browser_prepare',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_pointer',
  'browser_dialog',
  'browser_set_input_files',
  'browser_download',
  // Batches, recording and settings.
  'run_steps',
  'run_script',
  'start_recording',
  'stop_recording',
  'get_recording_state',
  'replay_trajectory',
  'install_ffmpeg',
  'get_config',
  'set_config',
  'check_permissions',
  'health_report',
  'check_for_update',
  'install_extension',
  'get_guide',
]

/**
 * Off when it is added; the person may switch any on. The clipboard; whatever runs other tools inside the driver, past
 * Latch's per-call switch and record (a script, a batch, a replayed recording, a widened session); starting or ending
 * any program (`launch_app` takes URLs and extra arguments); recording to files; hiding where the agent acts; the
 * browser tools, whose page and Electron paths are unsafe upstream; and whatever updates, installs or reconfigures the
 * driver.
 */
export const COMPUTER_TOOLS_OFF: readonly string[] = [
  'clipboard_read',
  'clipboard_write',
  'run_script',
  'run_steps',
  'replay_trajectory',
  'escalate_session',
  'launch_app',
  'kill_app',
  'start_recording',
  'set_agent_cursor_enabled',
  'page',
  'get_browser_state',
  'browser_prepare',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_pointer',
  'browser_dialog',
  'browser_set_input_files',
  'browser_download',
  'check_for_update',
  'install_ffmpeg',
  'install_extension',
  'set_config',
]

/** Where the Host looks for the driver and how it checks the signature; only the start script sets it. */
export interface ComputerDriverOptions {
  /** The app bundle; the start script passes `COMPUTER_APP` on macOS. */
  app: string
  /** Tests: stands in for the code-signature check. Production never sets it. */
  verify?: (app: string) => Promise<boolean>
}

const VERSION_MS = 5_000
const VERSION_OUTPUT = 4096

/** `codesign --verify --strict` against the driver's requirement: the app as a whole, sealed resources and program. */
function verifySignature(app: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(
      '/usr/bin/codesign',
      ['--verify', '--strict', `-R=${REQUIREMENT}`, app],
      { env: {}, timeout: VERSION_MS, maxBuffer: VERSION_OUTPUT, killSignal: 'SIGKILL' },
      error => resolve(!error),
    )
  })
}

/**
 * The program's `--version`, the only thing run: no shell, an empty working folder, the variables that switch its
 * telemetry and update check off and nothing of the Host's, at most 5 s and 4 KiB of standard output, then its whole
 * process group is ended. `cua-driver 0.44.0` → `0.44.0`; anything else is no version.
 */
function readDriverVersion(program: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(program, ['--version'], {
        cwd: tmpdir(),
        env: { ...COMPUTER_ENV, PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      })
    } catch {
      resolve(undefined)
      return
    }
    let stdout = ''
    let settled = false
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Already gone. */
      }
    }
    const done = (version: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      kill()
      resolve(version)
    }
    const timer = setTimeout(() => done(undefined), VERSION_MS)
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > VERSION_OUTPUT) done(undefined)
    })
    child.once('error', () => done(undefined))
    child.once('close', code => {
      const first = stdout.split(/\r?\n/u).find(line => line.trim()) ?? ''
      const match = /^cua-driver v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/u.exec(first.trim())
      done(code === 0 ? match?.[1] : undefined)
    })
  })
}

/**
 * What is at the expected place: no app (`absent`); not a real app holding a regular executable program, or not signed
 * as Cua Driver (`refused`); no version read (`refused`); older than the minimum (`old`); or `ok`. A check when it is
 * asked for, not a guarantee about the file later.
 */
export async function checkComputerDriver(options: ComputerDriverOptions): Promise<Omit<McpComputerCheck, 'added'>> {
  const command = join(options.app, PROGRAM)
  const base = { minimum: COMPUTER_MINIMUM, command, install: COMPUTER_INSTALL }
  try {
    const app = await lstat(options.app)
    if (!app.isDirectory() || app.isSymbolicLink()) return { ...base, state: 'refused', reason: 'bundle' }
  } catch {
    return { ...base, state: 'absent' }
  }
  try {
    const program = await lstat(command)
    if (!program.isFile() || program.isSymbolicLink() || !(program.mode & 0o100) || program.mode & 0o022)
      return { ...base, state: 'refused', reason: 'bundle' }
  } catch {
    return { ...base, state: 'refused', reason: 'bundle' }
  }
  if (!(await (options.verify ?? verifySignature)(options.app))) return { ...base, state: 'refused', reason: 'signature' }
  const version = await readDriverVersion(command)
  const order = version === undefined ? undefined : compareVersions(version, COMPUTER_MINIMUM)
  if (version === undefined || order === undefined) return { ...base, state: 'refused', reason: 'version' }
  return { ...base, version, state: order < 0 ? 'old' : 'ok' }
}
