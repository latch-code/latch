import { posix } from 'node:path'
import { redactSecrets } from '@latch/core/node-kit'
import { SHARED_ENCODING_FILES } from './verify-plan.ts'

/**
 * Mechanical checks behind `pnpm security:scan`. They look only at the lines a change adds, so an old match is not
 * reported again, and they cannot judge intent: a finding is a place to review against AGENTS.md, not a verdict.
 */
export interface ScanRule {
  id: string
  /** Which repository paths the rule reads. */
  applies(path: string): boolean
  matches(line: string): boolean
  message: string
}

/** Test code may hold made-up credentials on purpose (the redaction tests do); a finding there asks for a look only. */
function isTestPath(path: string): boolean {
  return /^(?:tests|e2e)\//u.test(path) || /^(?:apps|packages)\/[^/]+\/test\//u.test(path) || path.startsWith('packages/testkit/')
}

const production = (path: string) => /^(?:apps|packages)\/[^/]+\/src\//u.test(path) || path.startsWith('apps/host/scripts/')
const under = (prefix: string) => (path: string) => path.startsWith(prefix)
const text = (path: string) => !/\.(?:png|jpe?g|gif|ico|icns|woff2?|ttf|zip|gz)$/u.test(path) && path !== 'pnpm-lock.yaml'

/** Key shapes of other services that may be pasted by mistake; Latch's own credential shapes come from redactSecrets. */
const FOREIGN_KEY =
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bgh[opsur]_[A-Za-z0-9]{36,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/u

const SCAN_RULES: readonly ScanRule[] = [
  {
    id: 'secret-shape',
    applies: text,
    matches: line => redactSecrets(line) !== line || FOREIGN_KEY.test(line),
    message: '新增内容中有凭据、邀请码、离线登记码或密钥的形状；秘密不进入 Git、日志与输出',
  },
  {
    id: 'event-source',
    applies: under('apps/web/src/'),
    matches: line => /\bEventSource\s*\(|\bnew\s+EventSource\b/u.test(line),
    message: '事件流只用 apps/web/src/core/eventStream.ts（fetch），不用 EventSource',
  },
  {
    id: 'proxy-header',
    applies: path => /^(?:apps\/host|packages\/[^/]+)\/src\//u.test(path),
    matches: line => /x-forwarded-|\bx-real-ip\b|['"`]forwarded['"`]/iu.test(line),
    message: '请求上下文只来自监听入口，不读取代理请求头',
  },
  {
    id: 'dynamic-code',
    applies: production,
    matches: line => /\beval\s*\(|\bnew\s+Function\s*\(/u.test(line),
    message: '不对字符串求值执行代码',
  },
  {
    id: 'plugin-network',
    applies: under('apps/host/src/plugins/'),
    matches: line => /from\s+['"](?:undici|node:(?:http|https|net|tls|dgram))['"]|\bglobalThis\.fetch\b/u.test(line),
    message: '内置插件的出站只经 Host 注入的 fetch',
  },
  {
    id: 'electron-isolation',
    applies: under('apps/desktop/src/'),
    matches: line =>
      /nodeIntegration(?:InWorker|InSubFrames)?\s*:\s*true|contextIsolation\s*:\s*false|sandbox\s*:\s*false|webSecurity\s*:\s*false|allowRunningInsecureContent\s*:\s*true|experimentalFeatures\s*:\s*true/u.test(
        line,
      ),
    message: '渲染进程保持沙箱与隔离，没有 Node 与网络',
  },
  {
    id: 'electron-navigation',
    applies: under('apps/desktop/src/'),
    matches: line => /\bshell\.openExternal\s*\(|\.loadURL\s*\(|\bwindow\.open\s*\(/u.test(line),
    message: '窗口只加载 latch://app/，外链只经主进程的确认对话框交给系统浏览器',
  },
  {
    id: 'html-injection',
    applies: under('apps/web/src/'),
    matches: line => /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=/u.test(line),
    message: '客户端不插入未转义的 HTML',
  },
  {
    id: 'agent-environment',
    applies: under('packages/harness-acp/src/'),
    matches: line => /\.\.\.\s*process\.env\b/u.test(line),
    message: 'Agent 子进程的环境只来自 agentEnvironment，不整体继承 process.env',
  },
  {
    id: 'sigusr1',
    applies: path => posix.basename(path) === 'package.json',
    matches: line => /"[^"]+"\s*:\s*"node\s(?![^"]*--disable-sigusr1)/u.test(line),
    message: '启动 Host 或处理秘密的 node 入口带 --disable-sigusr1',
  },
]

export interface Finding {
  rule: string
  path: string
  line: string
  message: string
  /** In test code, where made-up values are expected: listed for a look, not counted as a failure. */
  inTest: boolean
}

export function scanAddedLines(added: ReadonlyMap<string, readonly string[]>, rules: readonly ScanRule[] = SCAN_RULES): Finding[] {
  const findings: Finding[] = []
  for (const [path, lines] of [...added].toSorted(([a], [b]) => a.localeCompare(b))) {
    for (const rule of rules) {
      if (!rule.applies(path)) continue
      for (const line of lines) {
        if (!rule.matches(line)) continue
        const shown = rule.id === 'secret-shape' ? redactSecrets(line).replace(FOREIGN_KEY, '[redacted]') : line
        findings.push({ rule: rule.id, path, line: shown.trim().slice(0, 160), message: rule.message, inTest: isTestPath(path) })
      }
    }
  }
  return findings
}

/** Files that change together; a change to some of them is a reminder to check the rest. */
const GROUPS: ReadonlyArray<{ files: readonly string[]; message: string }> = [
  {
    files: SHARED_ENCODING_FILES,
    message: '若改的是共享安全编码（base32、指纹、canonicalJson、确认预览、hashDisplay、escapeSecurityText、签名文本），这些文件要一起改',
  },
  {
    files: ['apps/host/src/host-state.ts', 'apps/desktop/src/host.cjs'],
    message: 'host.cjs 是 host-state.ts 中 host.json 核对的 CommonJS 版，两边一起改',
  },
  {
    files: ['apps/host/test/helpers/host.ts', 'e2e/helpers/host.ts', 'apps/desktop/test/helpers/host.ts'],
    message: '三份 startTestHost 绑定除开头注释外相同，一起改',
  },
]

export interface Reminder {
  message: string
  changed: string[]
  unchanged: string[]
}

export function coChangeReminders(paths: readonly string[]): Reminder[] {
  const set = new Set(paths)
  const reminders: Reminder[] = []
  for (const group of GROUPS) {
    const changed = group.files.filter(file => set.has(file))
    const unchanged = group.files.filter(file => !set.has(file))
    if (changed.length > 0 && unchanged.length > 0) reminders.push({ message: group.message, changed, unchanged })
  }
  for (const path of paths) {
    if (/^packages\/harness-acp\/src\/profiles\/[^/]+\.ts$/u.test(path))
      reminders.push({ message: '改变 profile 行为时提高它的 version（计入 launchHash）', changed: [path], unchanged: [] })
    if (path === 'native/macos/LatchPresence.swift')
      reminders.push({
        message: '构建后确认组件的签名改变：运行中的 Host 的本机确认失效，告知用户停止 Host 后运行 pnpm latch presence repin',
        changed: [path],
        unchanged: [],
      })
  }
  return reminders
}
