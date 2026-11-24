import { LATCH_COMMAND, localLatchCommand } from './commands.ts'
import {
  escapeSecurityText,
  isAcceptableDeviceName,
  isSecurityErrorCode,
  looksSecret,
  refusedBeforeAccepting,
  RISK_REASON_TEXT,
  type ApiFailure,
  type ApprovalOptionKind,
  type ApprovalRiskReason,
  type DeviceScope,
  type PresenceAction,
} from '@latch/protocol'
import { currentLocale, defineCopy, formatList, plural } from './i18n.ts'

/**
 * Error text comes from this catalog, chosen by the Host's error code. For a code in the security class
 * (`isSecurityErrorCode`) the Host's free-text `message` is never shown; the only values substituted in are a wait time
 * and a validated `host:port` target. A code outside both takes the caller's own words, then in Chinese the Host's
 * reason (escaped and capped, see `describeFailure`), else a generic sentence with the code. The catalog follows the
 * interface glossary (`scripts/glossary.ts`).
 */

/** Why this browser is on the enrollment page: the Host's 401 code or a local cause. */
export type EnrollmentReason =
  | 'unauthorized'
  | 'device-revoked'
  | 'credential-expired'
  | 'listener-mismatch'
  | 'legacy-reconfirm'
  | 'key-missing'
  | 'credential-not-stored'
  | 'renewal-not-stored'

export const ENROLLMENT_REASON_TEXT = defineCopy<Partial<Record<EnrollmentReason, string>>>(
  {
    'device-revoked': '这台设备已被移除。要继续使用，请重新连接。',
    'credential-expired': '这台设备已连接满 30 天，请重新连接。',
    'listener-mismatch': '这台设备的凭据属于另一个访问地址，请重新连接。',
    'key-missing': '这个浏览器丢失了设备密钥，请重新连接。',
    'credential-not-stored': '已经连上，但这个浏览器没有保存设备凭据（可能禁止了 Cookie）。请允许此网站保存 Cookie 后重新连接。',
    'renewal-not-stored':
      '设备凭据已续期，但这个浏览器没有保存新的凭据（可能禁止了 Cookie）。请允许此网站保存 Cookie 后重新加载页面；仍连不上时再重新连接。',
  },
  {
    'device-revoked': 'This device was removed. Connect again to keep using it.',
    'credential-expired': 'This device has been connected for 30 days. Connect again.',
    'listener-mismatch': 'This device’s credential is for another address. Connect again.',
    'key-missing': 'This browser lost its device key. Connect again.',
    'credential-not-stored':
      'Connected, but this browser did not save the device credential (cookies may be blocked). Allow this site to save cookies, then connect again.',
    'renewal-not-stored':
      'The device credential was renewed, but this browser did not save the new one (cookies may be blocked). Allow this site to save cookies and reload the page; if it still cannot connect, connect again.',
  },
)

export const NOTICE_COPY = defineCopy(
  {
    /** A change that reduced permissions applied while its record could not be written (`x-latch-audit: failed`). */
    auditNotRecorded: '改动已生效，但没有写入记录',
    localOnly: '只能在 Mac 上的 Latch 里操作',
    /** The same stop after a mode change, where no message was on its way. */
    configUnverified: '没能确认权限已经切换',
    deviceNameInvalid: '设备名称不能包含换行、不可见字符或改变文字方向的字符。',
  } as const,
  {
    auditNotRecorded: 'The change took effect, but no record was written',
    localOnly: 'Only in Latch on the Mac',
    configUnverified: 'Could not confirm the permission changed',
    deviceNameInvalid: 'A device name cannot contain line breaks, invisible characters or characters that change text direction.',
  },
)

/** A fact as the UI shows it: a short label always, and the fine print one press away (`Hint`), if any. */
export interface Brief {
  label: string
  detail?: string
  /** A Harness's mark to lead the label, where the fact is about that Harness. */
  mark?: string
}

/**
 * The computer's own name (`snapshot.hostName`), or a display fallback if the name is missing or would need escaping.
 * A sentence sending another device there defaults to 「Mac」; the local phrasing is in `computerLabel`.
 */
export function computerName(hostName?: string, fallback = 'Mac'): string {
  return typeof hostName === 'string' && isAcceptableDeviceName(hostName) ? hostName.trim() : fallback
}

const COMPUTER_COPY = defineCopy(
  {
    thisMac: '这台 Mac',
    /** Where a Harness or plugin runs, for `RUNS_AS_YOU_COPY`: 「这台 Mac 上」 or 「 <name> 上」. */
    onThisMac: '这台 Mac 上',
    onComputer: (computer: string) => ` ${computer} 上`,
  } as const,
  {
    thisMac: 'This Mac',
    onThisMac: 'on this Mac',
    onComputer: (computer: string) => `on ${computer}`,
  },
)

/** 「这台 Mac」 in the Latch app on the Host's computer (`DeviceAccess.local`), the computer's name everywhere else. */
export const computerLabel = (local: boolean, hostName?: string): string => (local ? COMPUTER_COPY.thisMac : computerName(hostName))

/** Where code runs, for `RUNS_AS_YOU_COPY.about` and `.engines`: 「这台 Mac 上」, or 「 <name> 上」 on another device. */
export const runsOn = (local: boolean, hostName?: string): string =>
  local ? COMPUTER_COPY.onThisMac : COMPUTER_COPY.onComputer(computerName(hostName))

/**
 * Restrictions and consequences shown while choosing or adding an agent, project or model service. Each `…Elsewhere`
 * line is read on another device and names the computer (`computerName`).
 */
export const SETUP_COPY = defineCopy(
  {
    modelNeedsAdmin: (computer = 'Mac') => `在 ${computer} 的 设置 › 模型 里添加`,
    /** A device whose data scope leaves out the session's folders: where its 「可以看项目文件」 is turned on. */
    filesNeedScope: (computer = 'Mac') => `在 ${computer} 上开启：设置 › 设备`,
    harnessNeedsAdmin: (computer = 'Mac') => `在 ${computer} 的 设置 › Harness 里查看`,
    addAgentElsewhere: (computer = 'Mac') => `在 ${computer} 的 设置 › Harness 里添加`,
    addProviderElsewhere: (computer = 'Mac') => `在 ${computer} 的 设置 › 模型 里添加`,
    keyElsewhere: (computer = 'Mac') => `密钥在 ${computer} 的 设置 › 模型 里填写`,
    addProjectElsewhere: (computer = 'Mac') => `在 ${computer} 上的 Latch 里添加项目`,
    confirmAddressElsewhere: (computer = 'Mac') => `先在 ${computer} 的 设置 › 模型 里确认这个地址`,
    /** The add-Harness panel: that Latch does not isolate it stays in sight, what it can reach one press away. */
    agentFullAccess: { label: 'Latch 不隔离它', detail: '它可以读写这台 Mac 上的文件并运行命令。' } satisfies Brief,
    /** 设置 › Harness, a definition's page: what a session started with it is. */
    externalNote: { label: '外部 Harness', detail: '用它开始的会话由它自己决定执行范围，Latch 不隔离它。' } satisfies Brief,
    /** 设置 › 项目, a project's folders for each Harness. */
    externalFolders: {
      label: '由各 Harness 执行',
      detail: '外部 Harness 的文件夹范围由它自己执行，Latch 不隔离它。',
    } satisfies Brief,
  },
  {
    modelNeedsAdmin: (computer = 'Mac') => `Add it in Settings › Models on ${computer}`,
    filesNeedScope: (computer = 'Mac') => `Turn on in Settings › Devices on ${computer}`,
    harnessNeedsAdmin: (computer = 'Mac') => `See Settings › Harness on ${computer}`,
    addAgentElsewhere: (computer = 'Mac') => `Add it in Settings › Harness on ${computer}`,
    addProviderElsewhere: (computer = 'Mac') => `Add it in Settings › Models on ${computer}`,
    keyElsewhere: (computer = 'Mac') => `Keys are entered in Settings › Models on ${computer}`,
    addProjectElsewhere: (computer = 'Mac') => `Add projects in Latch on ${computer}`,
    confirmAddressElsewhere: (computer = 'Mac') => `Confirm this address in Settings › Models on ${computer} first`,
    agentFullAccess: { label: 'Latch does not isolate it', detail: 'It can read and write files on this Mac and run commands.' },
    externalNote: { label: 'External Harness', detail: 'The Harness controls what it runs and can access. Latch does not isolate it.' },
    externalFolders: {
      label: 'Set by each Harness',
      detail: 'An external Harness applies its own folder limits. Latch does not isolate it.',
    },
  },
)

/**
 * Approvals: the words of each kind of request, the drawer's lines, and the reasons that replace an allow button this
 * device does not get.
 */
export const APPROVAL_COPY = defineCopy(
  {
    /** The card's state, the session's live status and a sub-agent's row: one phrase for every wait on the person. */
    waiting: '等你处理',
    highRisk: '高风险',
    /** A high-risk request is never remembered: the short fact beside its reason, the Host's sentence behind ⓘ. */
    confirmEachTime: '每次都要确认',
    advisory: '仅提示',
    check: '需要核对',
    /** On an agent's ask: the fact in a few words, why one press away. */
    advisoryNote: {
      label: '拒绝只会转达，拦不住它',
      detail: 'Harness 的询问只是提示：拒绝会转达给它，但不能阻止它执行其他操作。',
    },
    hiddenCharacters: '含有不可见字符，已标出',
    /** One name for the card's other choices at every width. */
    moreChoices: '更多',
    allowSession: '这个会话都允许这类操作',
    moreBusy: '正在提交另一个选择',
    noStandard: '这台设备不能允许这一步',
    noElevated: '这台设备不能允许这一步',
    noRun: '这台设备不能允许这一步',
    /** The choice whose outcome is unknown, by the label of its button. */
    uncertainTitle: (choice: string) => `「${choice}」的结果未知`,
    uncertainApproval: '审批结果尚未确认',
    retry: '重试',
    /** An unknown choice that cannot be sent again from here: read the session from the Host again. */
    recheck: '核对',
    /** The drawer above the composer. */
    drawerCount: (index: number, total: number) => `${index}/${total}`,
    allow: '允许',
    reject: '拒绝',
    stop: '停止',
    rejectAndSend: '拒绝并发送',
    stopTurn: '停止这一轮',
    hidePreview: '收起',
    viewDetail: '查看详情',
    rejectPlaceholder: '拒绝并说明改做什么…',
    viewChange: '查看改动',
    /** The one name of the action that opens the changes panel, on a turn's card, on ⌘K and on an approval that opens it. */
    openChanges: '打开改动',
    /** The proposal's label in 改动 while it waits. */
    proposal: '待允许',
    allowedAt: (time: string) => `已允许 · ${time}`,
    rejectedAt: (time: string) => `已拒绝 · ${time}`,
  },
  {
    waiting: 'Needs you',
    highRisk: 'High risk',
    confirmEachTime: 'Confirm each time',
    advisory: 'Advisory',
    check: 'Check this',
    advisoryNote: {
      label: 'Denying only tells it; it cannot stop it',
      detail: 'A Harness’s ask is only advisory: a denial is passed on to it, but cannot stop it from doing other things.',
    },
    hiddenCharacters: 'Contains invisible characters, marked',
    moreChoices: 'More',
    allowSession: 'Allow this kind of action for this session',
    moreBusy: 'Another choice is being sent',
    noStandard: 'This device cannot allow this step',
    noElevated: 'This device cannot allow this step',
    noRun: 'This device cannot allow this step',
    uncertainTitle: (choice: string) => `Result of “${choice}” unknown`,
    uncertainApproval: 'Approval outcome unconfirmed',
    retry: 'Retry',
    recheck: 'Check',
    drawerCount: (index: number, total: number) => `${index}/${total}`,
    allow: 'Allow',
    reject: 'Deny',
    stop: 'Stop',
    rejectAndSend: 'Deny and send',
    stopTurn: 'Stop this turn',
    hidePreview: 'Hide',
    viewDetail: 'View details',
    rejectPlaceholder: 'Deny and say what to do instead…',
    viewChange: 'View changes',
    openChanges: 'Open changes',
    proposal: 'Awaiting approval',
    allowedAt: (time: string) => `Allowed · ${time}`,
    rejectedAt: (time: string) => `Denied · ${time}`,
  },
)

/**
 * How a decided approval reads on its tool row, and its tooltip. A person's choice says when; an answer nobody gave (a
 * time limit, the session stopping) is never worded as anyone's choice. Where a person decided is told without a device
 * name. None of it says the call did not run: only the built-in harness holds a call back, and an agent's ask is
 * advisory, so a call the agent reports as started keeps its own state with `ranDespite` beside the record.
 */
export const DECISION_COPY = defineCopy(
  {
    allowed: '已允许',
    rejected: '已拒绝',
    expired: '已过期',
    cancelled: '已取消（会话停止）',
    cancelledSubagent: '已取消（子 Agent 停止）',
    viaThisMac: '在这台 Mac 上决定',
    viaOtherDevice: '在其他设备上决定',
    expiredNote: '没有人在时限内回答',
    ranDespite: 'Harness 报告仍执行了这次调用',
    /** The same on the row's own line, where the call is the row. */
    ranDespiteLabel: 'Harness 报告仍执行了',
    ranDespiteNote: 'Harness 的询问只是提示：拒绝会转达给它，但不能阻止它执行。这一行显示的是 Harness 自己的报告。',
    /** Why what was typed cannot go with a rejection. */
    noteInvalid: '说明最多 500 个字，不能包含控制字符、不可见字符或改变文字方向的字符',
  },
  {
    allowed: 'Allowed',
    rejected: 'Denied',
    expired: 'Expired',
    cancelled: 'Cancelled (session stopped)',
    cancelledSubagent: 'Cancelled (sub-agent stopped)',
    viaThisMac: 'Decided on this Mac',
    viaOtherDevice: 'Decided on another device',
    expiredNote: 'Nobody answered in time',
    ranDespite: 'The Harness reports it ran this call anyway',
    ranDespiteLabel: 'Harness reports it ran anyway',
    ranDespiteNote:
      'A Harness’s ask is only advisory: a denial is passed on to it, but cannot stop it. This row shows the Harness’s own report.',
    noteInvalid: 'Up to 500 characters, with no control characters, invisible characters or characters that change text direction',
  },
)

const RISK_REASON_COPY = defineCopy<Readonly<Record<ApprovalRiskReason, string>>>(RISK_REASON_TEXT, {
  'code-root': 'Latch’s own code',
  'protected-path': 'Protected file',
  'outside-workspace': 'Outside the project folder',
  'unresolved-path': 'Not a relative path in the project',
  'unlisted-tool': 'A tool Latch does not know',
  'unparsable-arguments': 'Arguments cannot be read',
  'sensitive-field': 'Sensitive input, such as a password',
  'mcp-tool': 'Tool from a remote MCP server',
})

/**
 * The high-risk pill: 高风险 with the Host's reason (「高风险 · Latch 程序目录内」), or alone when there is none or the code
 * is not one this page knows. The words come from @latch/protocol, the same the system sheet uses.
 */
export function highRiskLabel(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(RISK_REASON_TEXT, reason)
    ? `${APPROVAL_COPY.highRisk} · ${RISK_REASON_COPY[reason as ApprovalRiskReason]}`
    : APPROVAL_COPY.highRisk
}

/** A risky request's reason on its own line; the words come from @latch/protocol, the same the system sheet uses. */
export function RISK_CLAUSE(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(RISK_REASON_TEXT, reason)
    ? RISK_REASON_COPY[reason as ApprovalRiskReason]
    : APPROVAL_COPY.highRisk
}

/**
 * The words of an agent's options, by their kind: an agent names its options in its own language (「Reject」), and
 * the card shows the product's words, with the agent's own in the tooltip. 本会话始终允许 only reaches a card from
 * the built-in harness.
 */
export const APPROVAL_OPTION_LABELS = defineCopy<Record<ApprovalOptionKind, string>>(
  {
    reject_once: '拒绝',
    allow_once: '允许一次',
    reject_always: '始终拒绝',
    allow_always: '本会话始终允许',
  },
  {
    reject_once: 'Deny',
    allow_once: 'Allow once',
    reject_always: 'Always deny',
    allow_always: 'Always allow in this session',
  },
)

/**
 * The local confirmation has no window of Latch's own: the button that asked shows pending and the system sheet is the
 * only UI. These are the lines left for a screen reader and for a confirmation that could not start.
 */
export const CONFIRMATION_COPY = defineCopy(
  {
    label: '在 Mac 上确认',
    /** Either window: the helper's Touch ID sheet, or the desktop's own 取消/允许 sheet. */
    waiting: '在系统窗口中确认',
    /** Above what a system form's sentence leaves out. */
    details: '确认详情',
    confirmed: '已确认，正在',
    cooldown: '连续取消 3 次，暂停询问',
    /** How long the pause still lasts, 「4:05 后再试」. */
    cooldownWait: (wait: string) => `${wait} 后再试`,
    cooldownOver: '现在可以再试',
    busy: '另一个确认还没完成，先完成或取消它。',
    /** The same, as the line where a confirmation would start. */
    busyShort: '另一个确认进行中',
    blocked: '有外部 Harness 的会话正在运行或等你处理，结束后才能确认。',
    untitled: '未命名会话',
    openSession: '查看',
    stopSession: '停止',
    close: '关闭',
  },
  {
    label: 'Confirm on the Mac',
    waiting: 'Confirm in the system window',
    details: 'Confirmation details',
    confirmed: 'Confirmed. ',
    cooldown: 'Cancelled 3 times in a row, asking paused',
    cooldownWait: (wait: string) => `Try again in ${wait}`,
    cooldownOver: 'You can try again now',
    busy: 'Another confirmation is not finished. Finish or cancel it first.',
    busyShort: 'Another confirmation in progress',
    blocked: 'A session with an external Harness is running or needs you. You can confirm once it ends.',
    untitled: 'Untitled session',
    openSession: 'View',
    stopSession: 'Stop',
    close: 'Close',
  },
)

/** The confirmations a refusal may name; anything else is dropped from the details (`core/blocking.ts`). */
export const BLOCKED_VERBS = defineCopy<Record<'device.enroll' | 'device.grant' | 'policy.change' | 'provider.confirm-origin', string>>(
  {
    'device.enroll': '配对新设备',
    'device.grant': '为设备增加权限',
    'policy.change': '放宽设置',
    'provider.confirm-origin': '确认模型服务地址',
  },
  {
    'device.enroll': 'Pair a new device',
    'device.grant': 'Add device permissions',
    'policy.change': 'Relax settings',
    'provider.confirm-origin': 'Confirm a model service address',
  },
)

/** What the request does once the confirmation passes, for 「已确认，正在…」. */
export const CONFIRMATION_VERBS = defineCopy<Record<PresenceAction, string>>(
  {
    'plugin.package.apply': '应用插件',
    'device.enroll-native': '配对手机',
    'device.enroll': '连接设备',
    'device.grant': '更新权限',
    'policy.change': '更新设置',
    'provider.confirm-origin': '保存',
    'mcp.server.apply': '保存',
    'harness.command.apply': '保存',
  },
  {
    'plugin.package.apply': 'Applying plugin',
    'device.enroll-native': 'Pairing phone',
    'device.enroll': 'Connecting device',
    'device.grant': 'Updating permissions',
    'policy.change': 'Updating settings',
    'provider.confirm-origin': 'Saving',
    'mcp.server.apply': 'saving',
    'harness.command.apply': 'saving',
  },
)

/** What a confirmation held back by a running agent was for, in 「…，结束后才能放宽设置。」. */
export const BLOCKED_ACTION_TEXT = defineCopy<Record<PresenceAction, string>>(
  {
    'plugin.package.apply': '应用自定义插件',
    'device.enroll-native': '配对手机',
    'device.enroll': '配对新设备',
    'device.grant': '为设备增加权限',
    'policy.change': '放宽设置',
    'provider.confirm-origin': '确认模型服务地址',
    'mcp.server.apply': '添加 MCP 服务器',
    'harness.command.apply': '确认 Harness 命令',
  },
  {
    'plugin.package.apply': 'apply custom plugins',
    'device.enroll-native': 'pair a phone',
    'device.enroll': 'pair a new device',
    'device.grant': 'add device permissions',
    'policy.change': 'relax settings',
    'provider.confirm-origin': 'confirm the model service address',
    'mcp.server.apply': 'add an MCP server',
    'harness.command.apply': 'confirm the Harness command',
  },
)

/** A session named in the copy: its title and agent, already escaped and shortened (`core/blocking.ts`). */
export interface NamedSession {
  title: string
  agent?: string
  /** It waits for the person rather than runs, so the line does not say it is running. */
  waiting?: boolean
}

/**
 * A confirmation the Host holds back while an agent runs or waits for an answer: one line where the person acted, with
 * the ways out beside it (open it, stop it). Where the Host named no session (an older Host), the line says so in general.
 */
export const BLOCKED_COPY = defineCopy(
  {
    /** 「Codex 正在运行「修复设置页密钥丢失」，结束后才能放宽设置。」 */
    line: (sessions: readonly NamedSession[], action?: PresenceAction): string => {
      const [first] = sessions
      const then = `结束后才能${action ? BLOCKED_ACTION_TEXT[action] : '继续'}。`
      if (!first) return `有外部 Harness 的会话正在运行或等你处理，${then}`
      const more = sessions.length > 1 ? `等 ${sessions.length} 个会话` : ''
      const agent = first.agent ? `${first.agent} ` : ''
      if (first.waiting) return `${agent}在「${first.title}」${more}里等你处理，${then}`
      return `${agent}正在运行「${first.title}」${more}，${then}`
    },
    /** Above the list of every session holding it back, one row each (设置 › 设备). */
    headline: (action: PresenceAction) => `有外部 Harness 的会话正在运行或等你处理，结束后才能${BLOCKED_ACTION_TEXT[action]}。`,
    running: '正在运行',
    waiting: '等你处理',
    view: '查看',
    stop: '停止',
    stopping: '正在停止…',
    /** The stop went to the Host; the session ends once the agent has settled. */
    stopRequested: (session: NamedSession) => `正在停止「${session.title}」。它停下后，再试一次。`,
    /** Pairing: the invitation is not spent by a refused enrollment, so the same QR still works. */
    stopRequestedPairing: (session: NamedSession) => `正在停止「${session.title}」。它停下后就能配对，二维码仍然有效。`,
    /** Every named session has ended: the action can be asked for again from where it started. */
    ended: (sessions: readonly NamedSession[]) =>
      `${sessions.length === 1 ? `「${sessions[0]!.title}」` : '这些会话'}已经结束，可以再试一次了。`,
    ok: '好',
  },
  {
    line: (sessions: readonly NamedSession[], action?: PresenceAction): string => {
      const [first] = sessions
      const then = `You can ${action ? BLOCKED_ACTION_TEXT[action] : 'continue'} once it ends.`
      if (!first) return `A session with an external Harness is running or needs you. ${then}`
      const others = sessions.length - 1
      const more = others > 0 ? plural(others, { one: ' and {n} other session', other: ' and {n} other sessions' }) : ''
      const where = `“${first.title}”${more}`
      if (first.waiting) return first.agent ? `${first.agent} needs you in ${where}. ${then}` : `Waiting for you in ${where}. ${then}`
      return first.agent ? `${first.agent} is running ${where}. ${then}` : `Running ${where}. ${then}`
    },
    headline: (action: PresenceAction) =>
      `A session with an external Harness is running or needs you. You can ${BLOCKED_ACTION_TEXT[action]} once it ends.`,
    running: 'Running',
    waiting: 'Needs you',
    view: 'View',
    stop: 'Stop',
    stopping: 'Stopping…',
    stopRequested: (session: NamedSession) => `Stopping “${session.title}”. Try again once it stops.`,
    stopRequestedPairing: (session: NamedSession) => `Stopping “${session.title}”. You can pair once it stops; the QR code still works.`,
    ended: (sessions: readonly NamedSession[]) =>
      `${sessions.length === 1 ? `“${sessions[0]!.title}” has` : 'These sessions have'} ended. You can try again now.`,
    ok: 'OK',
  },
)

/**
 * Why a confirmation ended without the request running; the place that asked shows it and the caller gets it as the
 * error. A denial covers every way the confirmation did not pass: 取消 in the system sheet, a failed Touch ID or password,
 * or the system cancelling it.
 */
export const CONFIRMATION_RESULT_TEXT = defineCopy(
  {
    denied: '没有执行：确认没有通过。',
    expired: '没有执行：2 分钟内没有确认。',
    cancelled: '没有执行：确认已取消。',
    error: '没有执行：确认没有完成，请重试。',
    /** Touch ID locked after too many failed tries: the next confirmation takes the login password, which unlocks it. */
    lockout: '没有执行：Touch ID 已锁定。再试一次时用这台 Mac 的登录密码确认，Touch ID 也会随之恢复。',
  },
  {
    denied: 'Not done: the confirmation did not pass.',
    expired: 'Not done: nobody confirmed within 2 minutes.',
    cancelled: 'Not done: the confirmation was cancelled.',
    error: 'Not done: the confirmation did not finish. Try again.',
    lockout: 'Not done: Touch ID is locked. Try again and confirm with this Mac’s login password; that also unlocks Touch ID.',
  },
)

/** Whole minutes and seconds of a wait, 「4:05」. */
export function waitText(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** The enrollment page. */
export const ENROLLMENT_COPY = defineCopy(
  {
    title: '连接到 Latch',
    local: '在 Mac 上允许一次，之后直接打开',
    /** The desktop app on its first launch, one sentence and one button; nothing else is asked until another device connects. */
    desktopTitle: 'Latch',
    desktopFirst: '第一次在这台 Mac 上打开 Latch。',
    desktopAgain: '用 Touch ID 继续',
    desktopSubmit: '继续',
    /** The intro while local confirmation is unavailable: the offline code is the way in. */
    offline: '用离线连接码连接',
    /** Why only the offline code is accepted, with the Host's reason (trailing full stops removed). */
    unavailable: (reason: string) =>
      `Mac 现在不能确认：${reason || '未知原因'}。停止 Latch 服务后，在 Mac 上运行 ${localLatchCommand()} device enroll --offline，把生成的离线连接码填在下面。`,
    /** The same, where the Host takes no offline code (every listener but host.sock): nothing here can be submitted yet. */
    unavailableRemote: (reason: string) => `Mac 现在不能确认：${reason || '未知原因'}。要等它能确认后才能连接。`,
    invitationRequired: '这台设备还没连接到 Latch。用运行 Latch 的人发来的链接打开这一页，就能连接。',
    /** A browser on loopback is not this computer either: the desktop app makes its link, or the command line where there is none. */
    browserNotConnected: '这个浏览器还没连接到 Latch。在 Mac 上的 Latch 里点「在浏览器中打开」，或在终端运行：',
    browserLinkCommand: `${LATCH_COMMAND} device invite --loopback`,
    name: '设备名称',
    namePlaceholder: '例如：我的手机',
    connectBrowser: '连接这个浏览器',
    /** The link lets this browser ask for management, and pressing the button would. Never left to the system sheet. */
    linkCanManage: '这个链接还可以管理这台 Mac',
    declineManage: '不要',
    manageDeclined: '这个浏览器不会管理这台 Mac',
    undoDecline: '还是要',
    waiting: '在 Mac 上确认',
    cancel: '取消',
    retry: '重试',
    compare: '用 Touch ID 或登录密码允许',
    completing: '正在完成连接…',
    connecting: '正在连接…',
    confirmFailed: '已经连上，但还没能读取 Mac 上的状态。',
    denied: 'Mac 上取消了连接。',
    expired: 'Mac 上没有确认，请重新开始。',
    offlineField: '离线连接码',
    offlineSubmit: '使用离线连接码',
    unsupported: '此浏览器无法在当前地址安全地保存设备密钥。请使用最新版 Chrome、Edge、Firefox 或 Safari，或使用 Mac 上的 Latch。',
    mismatch: '这台设备的密钥和 Mac 读到的不一致，已停止连接。',
    legacyTitle: '这台设备要在 Mac 上重新确认',
    legacyBody: '连接方式已更新',
    legacySubmit: '重新确认',
    oldHost: '这台 Mac 上的 Latch 版本太旧，请重新启动它。',
  },
  {
    title: 'Connect to Latch',
    local: 'Allow once on the Mac, then open it directly',
    desktopTitle: 'Latch',
    desktopFirst: 'Opening Latch on this Mac for the first time.',
    desktopAgain: 'Continue with Touch ID',
    desktopSubmit: 'Continue',
    offline: 'Connect with an offline code',
    unavailable: (reason: string) =>
      `The Mac cannot confirm right now: ${reason || 'unknown reason'}. Stop the Latch service, run ${localLatchCommand()} device enroll --offline on the Mac, and enter the offline code it prints below.`,
    unavailableRemote: (reason: string) =>
      `The Mac cannot confirm right now: ${reason || 'unknown reason'}. You can connect once it can confirm again.`,
    invitationRequired:
      'This device is not connected to Latch yet. Open this page from the link sent by the person who runs Latch to connect.',
    browserNotConnected:
      'This browser is not connected to Latch yet. In Latch on the Mac, click “Open in browser”, or run this in Terminal:',
    browserLinkCommand: `${LATCH_COMMAND} device invite --loopback`,
    name: 'Device name',
    namePlaceholder: 'e.g. My phone',
    connectBrowser: 'Connect this browser',
    linkCanManage: 'This link can also manage this Mac',
    declineManage: 'Don’t',
    manageDeclined: 'This browser will not manage this Mac',
    undoDecline: 'Allow it',
    waiting: 'Confirm on the Mac',
    cancel: 'Cancel',
    retry: 'Retry',
    compare: 'Allow with Touch ID or login password',
    completing: 'Finishing connection…',
    connecting: 'Connecting…',
    confirmFailed: 'Connected, but the Mac’s state could not be read yet.',
    denied: 'The connection was cancelled on the Mac.',
    expired: 'Nobody confirmed on the Mac. Start again.',
    offlineField: 'Offline code',
    offlineSubmit: 'Use offline code',
    unsupported:
      'This browser cannot safely save a device key at this address. Use the latest Chrome, Edge, Firefox or Safari, or Latch on the Mac.',
    mismatch: 'This device’s key does not match what the Mac read. Connection stopped.',
    legacyTitle: 'Confirm this device again on the Mac',
    legacyBody: 'The way devices connect has changed',
    legacySubmit: 'Confirm again',
    oldHost: 'Latch on this Mac is out of date. Restart it.',
  },
)

/**
 * 连接详情, folded on the connecting device and in the Mac's pairing panel. The system sheet shows only the name a device
 * gave itself, so the code is the way left to tell this device from another holding the same link.
 */
export const CONNECTION_DETAILS_COPY = defineCopy(
  {
    title: '连接详情',
    name: '名称',
    code: '校验码',
    /** On the connecting device. */
    compareOnMac: '和 Mac 上 Latch 的 设置 › 设备 里的校验码相同，才是这台设备。',
    /** In the Mac's panel. */
    compareOnDevice: '和那台设备页面上的校验码相同，才是它。',
    sheet: '系统窗口写的是',
    granted: '可以',
    data: '能看到',
    dataText: { all: '全部，含私有内容', files: '会话与项目的文件', work: '会话' },
  },
  {
    title: 'Connection details',
    name: 'Name',
    code: 'Check code',
    compareOnMac: 'It is this device only if the code matches the one in Settings › Devices in Latch on the Mac.',
    compareOnDevice: 'It is that device only if the code matches the one on its page.',
    sheet: 'The system window says',
    granted: 'Can',
    data: 'Can see',
    dataText: { all: 'Everything, including private content', files: 'Session and project files', work: 'Sessions' },
  },
)

/** What a device may do once connected, in the words of a person deciding about it. */
export const GRANTED_TEXT = defineCopy<Record<DeviceScope, string>>(
  {
    view: '查看会话',
    run: '开始和继续会话',
    'approve:standard': '批准普通操作',
    'approve:elevated': '批准高风险操作',
    admin: '管理这台 Mac（模型服务、插件、项目和设备）',
    secrets: '设置密钥',
  },
  {
    view: 'View sessions',
    run: 'Start and continue sessions',
    'approve:standard': 'Approve standard actions',
    'approve:elevated': 'Approve high-risk actions',
    admin: 'Manage this Mac (model services, plugins, projects and devices)',
    secrets: 'Set keys',
  },
)

/** The Mac's list of devices asking to connect. */
export const WAITING_DEVICES_COPY = defineCopy(
  {
    asking: '想连接这台 Mac',
    approved: '已允许，等它完成连接…',
    confirm: '在系统窗口中确认',
    canManage: '它还可以管理这台 Mac',
  },
  {
    asking: 'Wants to connect to this Mac',
    approved: 'Allowed, waiting for it to finish connecting…',
    confirm: 'Confirm in the system window',
    canManage: 'It can also manage this Mac',
  },
)

const SETTINGS_HIDDEN_COPY = defineCopy(
  {
    adminHidden: (computer: string) => `其他设置在 ${computer} 上的 Latch 里`,
    presenceUnavailable: (message: string) => `这台 Mac 暂时不能确认：${message}`,
    presenceUnavailableBare: '这台 Mac 暂时不能确认，需要它确认的操作都不能进行。',
  } as const,
  {
    adminHidden: (computer: string) => `Other settings are in Latch on ${computer}`,
    presenceUnavailable: (message: string) => `This Mac cannot confirm right now: ${message}`,
    presenceUnavailableBare: 'This Mac cannot confirm right now, so nothing that needs its confirmation can go ahead.',
  },
)

/** Under the settings sections of a device that cannot change them: why the others are not listed, and where they are. */
export const SETTINGS_ADMIN_HIDDEN = (computer = 'Mac') => SETTINGS_HIDDEN_COPY.adminHidden(computer)

/** This Mac cannot confirm anything now, in the Host's words when it gave some. */
export const presenceUnavailableText = (message: string | undefined) =>
  message ? SETTINGS_HIDDEN_COPY.presenceUnavailable(message) : SETTINGS_HIDDEN_COPY.presenceUnavailableBare

/** 设置 › 设备: the devices that use this Mac. It names no address, relay or scope; a waiting device's code is folded. */
export const DEVICES_COPY = defineCopy(
  {
    shelf: '设备',
    /** The list's heading on the Latch app on this Mac. */
    listTitle: '连到这台 Mac 的设备',
    /** The Latch app on this Mac is not in its own list, so a fresh one has none. */
    empty: '还没有别的设备连接这台 Mac。',
    /** Any other device, in place of 「连接新设备」: where new devices are connected. */
    pairElsewhere: (computer = 'Mac') => `在 ${computer} 上的 Latch 里连接`,
    /** 「连接新设备」: only the ways that work in this build. */
    connectTitle: '连接新设备',
    thisBrowser: '这台 Mac 的浏览器',
    /** A browser connected this way has `dataScope: 'files'`. */
    thisBrowserNote: '能看项目文件',
    /** Only while the Host reports an HTTPS entry; the link goes to the clipboard through the Latch app, never to the page. */
    otherComputer: '另一台电脑',
    otherComputerNote: '链接只复制到剪贴板',
    copyLink: '复制链接',
    /** After 复制链接: the page holds nothing to copy again, so a second press makes a new link. */
    linkCopied: '已复制：10 分钟内有效，只能用一次',
    phone: '连接手机',
    phoneNote: 'iPhone App 还没有可安装的版本',
    /** The QR sheet stays reachable for an iPhone app built from source. */
    phoneQr: '显示二维码',
    name: '名称',
    nameLabel: '设备名称',
    unnamed: '未命名设备',
    online: '在线',
    lastSeen: '上次在线',
    state: '状态',
    /** `native.input` and `status` a person can act on; a healthy device says nothing about them. */
    verificationRequired: '只能查看，去手机上验证',
    review: '只能查看，等你恢复',
    reviewNote: { label: '连接它的设备已移除', detail: '恢复后可以继续运行和允许操作。' } satisfies Brief,
    restore: '恢复使用',
    legacy: '要在这台设备上重新确认',
    manage: '可以管理这台 Mac',
    /** On another device the switch names the computer it manages. */
    manageOf: (local: boolean, computer = 'Mac') => (local ? '可以管理这台 Mac' : `可以管理 ${computer}`),
    manageNote: {
      label: '能改设置，密钥除外',
      detail: '修改模型、Harness、插件、项目和设备。密钥和连接新地址仍只能在 Mac 上操作。',
    } satisfies Brief,
    /** `dataScope: 'files'`: the files and changes of the sessions' project folders. */
    files: '可以看项目文件',
    filesNote: {
      label: '文件、改动与 @ 文件',
      detail: '能看项目里的文件和每个会话的改动，能在消息里 @ 文件；能开始会话的设备还能撤销、重做或丢弃某一轮的改动。',
    } satisfies Brief,
    /** `dataScope: 'all'`: also what is outside the project folders. */
    private: '也能看私有内容',
    privateNote: {
      label: '我的 Agent、终端与接入的会话',
      detail: '能看我的 Agent 和它们的记忆，能打开终端，能接入其他 CLI 的已有会话。',
    } satisfies Brief,
    /** A switch only the Latch app on that computer turns on. */
    raiseOnMac: (computer = 'Mac') => `在 ${computer} 上开启`,
    remove: '移除',
    rename: '重命名',
    removeTitle: (name: string) => `移除「${name}」？`,
    removePhone: '它会立即断开，之后要重新扫码才能连接。',
    removeBrowser: '它会立即断开，之后要重新发链接才能连接。',
    removeDesktop: '它会立即断开，之后要在那台电脑的 Latch 里重新确认才能连接。',
    removeSelf: '这台设备会立即断开，之后要重新发链接才能连接。',
    /** Added when other devices were invited by this one. */
    removeCascade: '由它连接的设备会降为只能查看，等你恢复。',
    removed: (name: string) => `已移除「${name}」`,
    about: '关于连接',
    /** 「关于连接」: what the rows above do not say. No HTTPS entry: the installed app cannot open one yet. */
    aboutOtherComputerMissing: {
      label: '另一台电脑：尚未实现',
      detail: '要先有「让其他电脑连接这台 Mac」，今天的安装包打不开这个入口。',
    } satisfies Brief,
    aboutPhone: { label: '首次连接用同一 Wi‑Fi 或数据线热点，连接端到端加密' } satisfies Brief,
    savedRelay: '已保存的中继',
    savedDirectory: '已保存的地址目录',
    browser: '在浏览器中打开',
    browserOpened: '已在浏览器中打开。在那里点「连接这个浏览器」后，这台 Mac 会请你确认。',
  },
  {
    shelf: 'Devices',
    listTitle: 'Devices connected to this Mac',
    empty: 'No other device is connected to this Mac yet.',
    pairElsewhere: (computer = 'Mac') => `Connect in Latch on ${computer}`,
    connectTitle: 'Connect a new device',
    thisBrowser: 'A browser on this Mac',
    thisBrowserNote: 'Can see project files',
    otherComputer: 'Another computer',
    otherComputerNote: 'The link is only copied to the clipboard',
    copyLink: 'Copy link',
    linkCopied: 'Copied: works once, for 10 minutes',
    phone: 'Connect a phone',
    phoneNote: 'The iPhone app has no installable version yet',
    phoneQr: 'Show QR code',
    name: 'Name',
    nameLabel: 'Device name',
    unnamed: 'Unnamed device',
    online: 'Online',
    lastSeen: 'Last online',
    state: 'Status',
    verificationRequired: 'View only, verify on the phone',
    review: 'View only, waiting for you to restore it',
    reviewNote: {
      label: 'The device that connected it was removed',
      detail: 'Once restored, it can run sessions and allow actions again.',
    },
    restore: 'Restore',
    legacy: 'Confirm again on this device',
    manage: 'Can manage this Mac',
    manageOf: (local: boolean, computer = 'Mac') => (local ? 'Can manage this Mac' : `Can manage ${computer}`),
    manageNote: {
      label: 'Can change settings, except keys',
      detail:
        'Changes models, Harnesses, plugins, projects and devices. Keys and connecting to new addresses still happen only on the Mac.',
    },
    files: 'Can see project files',
    filesNote: {
      label: 'Files, changes and file mentions',
      detail:
        'This device can read project files and session changes, and mention files in messages. If it can start sessions, it can also undo, redo or discard changes from a turn.',
    },
    private: 'Also see private content',
    privateNote: {
      label: 'My Agents, terminal and imported sessions',
      detail: 'This device can view My Agents and their memories, open the terminal and import existing CLI sessions.',
    },
    raiseOnMac: (computer = 'Mac') => `Turn on from ${computer}`,
    remove: 'Remove',
    rename: 'Rename',
    removeTitle: (name: string) => `Remove “${name}”?`,
    removePhone: 'It disconnects right away. To connect it again, scan the code again.',
    removeBrowser: 'It disconnects right away. To connect it again, send a new link.',
    removeDesktop: 'It disconnects right away. To connect it again, confirm again in Latch on that computer.',
    removeSelf: 'This device disconnects right away. To connect it again, send a new link.',
    removeCascade: 'Devices it connected become view only until you restore them.',
    removed: (name: string) => `Removed “${name}”`,
    about: 'About connections',
    aboutOtherComputerMissing: {
      label: 'Other computers: not built yet',
      detail: '“Let other computers connect to this Mac” has to come first; today’s installer cannot open that entry.',
    },
    aboutPhone: { label: 'First connection over the same Wi-Fi or a wired Personal Hotspot. End-to-end encrypted.' },
    savedRelay: 'Saved relays',
    savedDirectory: 'Saved address directory',
    browser: 'Open in browser',
    browserOpened: 'Opened in the browser. After you click “Connect this browser” there, this Mac asks you to confirm.',
  },
)

/** The pairing sheet, one state per sentence. */
export const NATIVE_LINK_COPY = defineCopy(
  {
    title: '连接手机',
    enable: '连接手机',
    scan: '用 iPhone 或 iPad 上的 Latch 扫码',
    sameWifi: '和这台 Mac 连同一个 Wi‑Fi',
    /** The QR's address is the iPhone's Personal Hotspot over USB. */
    byCable: '用数据线连接这台 Mac，并打开设备上的个人热点',
    /** The known cost of trusting a device once, said where that trust is given. */
    drivesAgents: '连接后，拿着这台解锁手机的人可以操作这台 Mac 上的 Agent，直到你移除它。',
    qrAlt: '原生客户端配对二维码',
    qrFailed: '二维码生成失败，请关闭后重新打开。',
    connecting: '正在连接…',
    /** Neutral on purpose: the snapshot does not say whether this Mac has Touch ID or takes the login password. */
    confirming: '在系统窗口中确认',
    /** A phone has claimed the QR and has not said its name yet. */
    someDevice: '一台设备',
    contended: '有两台设备扫了同一个二维码，已全部取消。请重新扫码。',
    cancelled: '已取消。可以重新扫码。',
    timedOut: '没有确认，已取消。可以重新扫码。',
    offNetwork: 'Mac 无法确认扫码设备在同一网络。请按下面的方式连接后再扫码。',
    noNetwork: '这台 Mac 暂时没有可用于配对的网络。',
    networkHelp: '让两台设备连同一个 Wi‑Fi，或用数据线连接并打开手机或平板的个人热点。',
    connectedBefore: '已连接「',
    closingQuote: '」',
    done: '好',
    retry: '重试',
  },
  {
    title: 'Connect a phone',
    enable: 'Connect a phone',
    scan: 'Scan with Latch on your iPhone or iPad',
    sameWifi: 'Use the same Wi‑Fi as this Mac',
    byCable: 'Connect to this Mac by cable and turn on Personal Hotspot on the device',
    drivesAgents: 'Once connected, whoever holds this unlocked phone can operate the Agents on this Mac until you remove it.',
    qrAlt: 'QR code for pairing Latch on iPhone or iPad',
    qrFailed: 'Could not make the QR code. Close this and open it again.',
    connecting: 'Connecting…',
    confirming: 'Confirm in the system window',
    someDevice: 'A device',
    contended: 'Two devices scanned the same QR code, so both were cancelled. Scan again.',
    cancelled: 'Cancelled. You can scan again.',
    timedOut: 'Not confirmed, so it was cancelled. You can scan again.',
    offNetwork: 'The Mac couldn’t verify that the scanning device is on the same network. Connect as shown below and scan again.',
    noNetwork: 'This Mac doesn’t currently have a network it can use for pairing.',
    networkHelp: 'Put both devices on the same Wi-Fi, or connect by cable and turn on Personal Hotspot on your iPhone or iPad.',
    connectedBefore: 'Connected “',
    closingQuote: '”',
    done: 'OK',
    retry: 'Retry',
  },
)

/**
 * A folder inside Latch's program directory: every write by the built-in agent needs an answer on this Mac and other
 * agents cannot start there. The start directory comes from the start options, so the way out is a project.
 */
export const CODE_ROOT_COPY = defineCopy(
  {
    badge: '程序目录内',
    notice: '在程序目录里，每次写入都问你',
    startDir: 'Latch 启动时的文件夹',
    chooseProject: '默认文件夹与 Latch 程序目录重叠，请选择其他项目。',
    newProject: '添加项目…',
  },
  {
    badge: 'In program folder',
    notice: 'In the program folder, every write asks you',
    startDir: 'Folder Latch started in',
    chooseProject: 'The default folder overlaps the Latch program folder. Choose another project.',
    newProject: 'Add project…',
  },
)

/** File chips in replies: copying a path, and the desktop app's menu of what is allowed for that file. */
export const FILE_COPY = defineCopy(
  {
    copy: '复制路径',
    copied: '已复制',
    copiedPath: '已复制路径',
    copyFailed: '复制不可用，请手动选择',
    image: '图片',
    quickLook: '快速查看',
    open: '用默认应用打开',
    checking: '正在检查…',
    busy: '上一个操作还没有完成，请稍后再试。',
    /** Phones, other computers and the browser: where the file can be previewed and opened. */
    elsewhere: (computer = 'Mac') => `在 ${computer} 上的 Latch 里可以快速查看和打开。`,
    /** A desktop shell from before file actions. */
    shellOutdated: '重新启动 Latch 后，可以在这里快速查看和打开。',
  },
  {
    copy: 'Copy path',
    copied: 'Copied',
    copiedPath: 'Path copied',
    copyFailed: 'Copy is unavailable; select it by hand',
    image: 'Image',
    quickLook: 'Quick Look',
    open: 'Open with default app',
    checking: 'Checking…',
    busy: 'The last action has not finished. Try again shortly.',
    elsewhere: (computer = 'Mac') => `Quick Look and open it in Latch on ${computer}.`,
    shellOutdated: 'Restart Latch to Quick Look and open files here.',
  },
)

/**
 * How a note at the foot of a file menu is marked: `lock` for what Latch refuses on purpose (the only place the lock
 * appears), `info` for where or how something can be done, `alert` for something that went wrong.
 */
export type FileNoteTone = 'lock' | 'info' | 'alert'
export interface FileNote {
  /** A few words, always in view. */
  text: string
  tone: FileNoteTone
  /** Why, and the way left to the reader, behind ⓘ. */
  detail?: string
}
interface FileNoteContext {
  /** The file's name, for reasons that depend on its type. */
  name?: string
  /** `latchShell.platform`: where the reader can go to find the file. */
  platform?: string
}

const extensionOf = (name: string | undefined) => {
  const dot = name?.lastIndexOf('.') ?? -1
  return name && dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
const WEB_TYPES = new Set(['html', 'htm', 'xhtml', 'svg', 'webarchive'])
const MACRO_TYPES = new Set(['doc', 'xls', 'ppt', 'docm', 'xlsm', 'pptm', 'potm', 'ppsm', 'rtf'])

/** Which of the type refusals a file's name gets. */
const typeKind = (name: string | undefined): 'web' | 'macro' | 'other' => {
  const ext = extensionOf(name)
  return WEB_TYPES.has(ext) ? 'web' : MACRO_TYPES.has(ext) ? 'macro' : 'other'
}

const FILE_TYPE_COPY = defineCopy(
  {
    reveal: (platform: string | undefined) =>
      platform === 'darwin' ? '在访达中显示' : platform === 'win32' ? '在资源管理器中显示' : '在文件管理器中显示',
    web: (reveal: string) => `网页和 SVG 用浏览器打开时可以联网；可以${reveal}后自己打开。`,
    macro: (reveal: string) => `这种 Office 文件可以带宏或嵌入的对象；可以${reveal}后自己打开。`,
    other: (reveal: string) => `Latch 只直接打开常见的文档、图片和音视频，不打开程序、脚本或没有扩展名的文件；可以${reveal}后自己决定。`,
  },
  {
    reveal: (platform: string | undefined) =>
      platform === 'darwin' ? 'show it in Finder' : platform === 'win32' ? 'show it in File Explorer' : 'show it in your file manager',
    web: (reveal: string) =>
      `Web pages and SVG files can access the network when opened in a browser. You can ${reveal} and open it yourself.`,
    macro: (reveal: string) => `This Office file type can contain macros or embedded objects. You can ${reveal} and open it yourself.`,
    other: (reveal: string) =>
      `Latch opens common documents, images, and media. It leaves programs, scripts, and files without an extension for you to inspect. You can ${reveal} to decide what to do.`,
  },
)

/** Why Latch does not open a type, with the way left to the reader. */
function typeRefusal({ name, platform }: FileNoteContext): string {
  return FILE_TYPE_COPY[typeKind(name)](FILE_TYPE_COPY.reveal(platform))
}

/** The note for each code the Host or the shell gave; anything else is a plain failure. */
type FileNoteWords = Omit<FileNote, 'tone'>
const FILE_NOTES = defineCopy<Record<string, (context: FileNoteContext) => FileNoteWords>>(
  {
    'file-outside-folders': ({ platform }) => ({
      text: '不在会话的文件夹里',
      detail: `Latch 不替你打开它。${platform === 'darwin' ? '复制路径后，可以在访达中按 ⇧⌘G 前往。' : '复制路径后，可以在文件管理器中前往。'}`,
    }),
    'file-folder-removed': () => ({
      text: '文件夹已不在项目里',
      detail: 'Latch 不再替你打开这个会话文件夹中的文件。',
    }),
    'file-protected': () => ({ text: '这是 Latch 的私有数据。' }),
    'file-secret': () => ({ text: '这个文件可能含密钥，不提供快速查看和打开。' }),
    'file-type-refused': context => ({ text: 'Latch 不直接打开', detail: typeRefusal(context) }),
    'file-preview-unverified': () => ({
      text: '暂不快速查看这种文件',
      detail: '还没有确认系统的预览不会加载文件里引用的网络资源。',
    }),
    'file-content-mismatch': () => ({ text: '文件内容与扩展名不符，Latch 不直接打开它。' }),
    'file-not-text': () => ({ text: '这不是文本文件，不用编辑器打开。' }),
    'no-editor': () => ({ text: '这台 Mac 上没有找到支持的编辑器。' }),
    'gesture-required': () => ({ text: '请在页面上点按后再试。' }),
    'file-scope': () => ({ text: '这台设备不能打开会话文件夹中的文件。' }),
    'local-only': () => ({ text: NOTICE_COPY.localOnly }),
    'file-folder': ({ platform }) => ({ text: `这是文件夹；Latch 只${FILE_TYPE_COPY.reveal(platform)}项目的文件夹。` }),
    'file-not-regular': () => ({ text: '这不是普通文件。' }),
    'file-unreadable': () => ({ text: 'Latch 没有读取这个文件的权限。' }),
    unsupported: () => ({ text: '这台 Mac 上还不能这样打开文件。' }),
    'host-outdated': () => ({ text: '重新启动 Latch 后可以在这里打开文件。' }),
    'file-missing': () => ({ text: '找不到这个文件。' }),
    'file-invalid': () => ({ text: '这不是有效的文件路径。' }),
    'file-changed': () => ({ text: '文件刚刚发生了变化，请重试。' }),
    'file-handle-expired': () => ({ text: '文件已不可用，请重新打开。' }),
    'file-image-dimensions': () => ({ text: '无法确认图片尺寸，已停止解码。可以下载文件后查看。' }),
    'file-handle-foreign': () => ({ text: '文件已不可用，请重新打开。' }),
    'open-failed': () => ({ text: '没有找到能打开这个文件的应用。' }),
    'task-not-found': () => ({ text: '找不到这个会话。' }),
    'audit-unavailable': () => ({ text: '没有写入记录，操作没有执行。' }),
    'rate-limited': () => ({ text: '操作太频繁，请稍后再试。' }),
    busy: () => ({ text: FILE_COPY.busy }),
    fallback: () => ({ text: '没有完成，请重试。' }),
  },
  {
    'file-outside-folders': ({ platform }) => ({
      text: 'Not in the session’s folders',
      detail: `Latch does not open it for you. ${platform === 'darwin' ? 'Copy the path, then press ⇧⌘G in Finder to go there.' : 'Copy the path, then go there in your file manager.'}`,
    }),
    'file-folder-removed': () => ({
      text: 'The folder is no longer in the project',
      detail: 'Latch no longer opens files in this session folder for you.',
    }),
    'file-protected': () => ({ text: 'This is Latch’s private data.' }),
    'file-secret': () => ({ text: 'This file may contain keys, so Quick Look and Open are not offered.' }),
    'file-type-refused': context => ({ text: 'Latch doesn’t open this type', detail: typeRefusal(context) }),
    'file-preview-unverified': () => ({
      text: 'No Quick Look for this kind of file yet',
      detail: 'It is not yet confirmed that the system preview does not load network resources the file refers to.',
    }),
    'file-content-mismatch': () => ({ text: 'The file’s content does not match its extension, so Latch does not open it directly.' }),
    'file-not-text': () => ({ text: 'This is not a text file. Latch cannot open it in an editor.' }),
    'no-editor': () => ({ text: 'No supported editor was found on this Mac.' }),
    'gesture-required': () => ({ text: 'Try again after clicking on the page.' }),
    'file-scope': () => ({ text: 'This device cannot open files in the session’s folders.' }),
    'local-only': () => ({ text: NOTICE_COPY.localOnly }),
    'file-folder': ({ platform }) => ({
      text: `This is a folder; Latch only ${platform === 'darwin' ? 'shows project folders in Finder' : platform === 'win32' ? 'shows project folders in File Explorer' : 'shows project folders in your file manager'}.`,
    }),
    'file-not-regular': () => ({ text: 'This is not a regular file.' }),
    'file-unreadable': () => ({ text: 'Latch has no permission to read this file.' }),
    unsupported: () => ({ text: 'Files cannot be opened this way on this Mac yet.' }),
    'host-outdated': () => ({ text: 'Restart Latch to open files here.' }),
    'file-missing': () => ({ text: 'This file cannot be found.' }),
    'file-invalid': () => ({ text: 'This is not a valid file path.' }),
    'file-changed': () => ({ text: 'The file just changed. Try again.' }),
    'file-handle-expired': () => ({ text: 'The file is no longer available. Open it again.' }),
    'file-image-dimensions': () => ({ text: 'Could not confirm the image size, so decoding stopped. Download the file to view it.' }),
    'file-handle-foreign': () => ({ text: 'The file is no longer available. Open it again.' }),
    'open-failed': () => ({ text: 'No app was found to open this file.' }),
    'task-not-found': () => ({ text: 'This session cannot be found.' }),
    'audit-unavailable': () => ({ text: 'No record could be written, so nothing was done.' }),
    'rate-limited': () => ({ text: 'Too many actions. Try again shortly.' }),
    busy: () => ({ text: FILE_COPY.busy }),
    fallback: () => ({ text: 'Not done. Try again.' }),
  },
)

const FILE_NOTE_TONES: Record<string, FileNoteTone> = {
  'file-outside-folders': 'lock',
  'file-folder-removed': 'lock',
  'file-protected': 'lock',
  'file-secret': 'lock',
  'file-type-refused': 'lock',
  'file-preview-unverified': 'lock',
  'file-content-mismatch': 'lock',
  'file-not-text': 'lock',
  'no-editor': 'info',
  'gesture-required': 'info',
  'file-scope': 'lock',
  'local-only': 'lock',
  'file-folder': 'info',
  'file-not-regular': 'info',
  'file-unreadable': 'info',
  unsupported: 'info',
  'host-outdated': 'info',
  'file-missing': 'alert',
  'file-invalid': 'alert',
  'file-changed': 'alert',
  'file-handle-expired': 'alert',
  'file-image-dimensions': 'alert',
  'file-handle-foreign': 'alert',
  'open-failed': 'alert',
  'task-not-found': 'alert',
  'audit-unavailable': 'alert',
  'rate-limited': 'alert',
  busy: 'alert',
}

/** A file refusal uses the safe interpretation of its code. */
export function fileNote(code: string, context: FileNoteContext = {}): FileNote {
  if (!Object.hasOwn(FILE_NOTE_TONES, code)) return { ...FILE_NOTES.fallback!(context), tone: 'alert' }
  return { ...FILE_NOTES[code]!(context), tone: FILE_NOTE_TONES[code]! }
}

const FILE_NOTE_JOIN = defineCopy({ join: (text: string, detail: string) => `${text}：${detail}` } as const, {
  join: (text: string, detail: string) => `${text}: ${detail}`,
})

/** The note a file menu shows for a code; the Host's words are never shown. */
/** The note as one sentence, where there is no ⓘ to hold its detail (a preview's error). */
export function fileRefusalText(code: string, context: FileNoteContext = {}): string {
  const { text, detail } = fileNote(code, context)
  return detail ? FILE_NOTE_JOIN.join(text, detail) : text
}

/**
 * Where a plugin's parts run and who receives them, for the plugin form. Plain facts rather than a warning: a page module
 * is delivered to every device that may view sessions and runs with that page's rights; nothing isolates it.
 */
export const PLUGIN_REACH_COPY = defineCopy(
  {
    title: '代码在哪里运行',
    page: {
      title: '界面面板',
      label: '每台能看会话的设备，不隔离',
      body: '代码会发到每台能查看会话的设备，在那台设备的 Latch 页面里运行：这台 Mac 上的 Latch，以及手机和其他电脑的浏览器。那个页面能做的事它都能做，没有隔离。iPhone App 不运行它。',
    },
    host: {
      title: '工具和后台代码',
      label: '在这台 Mac 上运行，不隔离',
      body: '在这台 Mac 上运行，权限和 Latch 相同：可以读写你的文件、运行程序、访问网络，也可以注册界面面板，发到能查看会话的设备。',
    },
    text: {
      title: '技能和静态面板',
      label: '只是文字，不运行代码',
      body: '只是文字，不运行代码。技能交给这台 Mac 上的 Latch 内置；静态面板每台能查看会话的设备都能看到。',
    },
    unread: {
      title: '没能读取这个插件的声明',
      body: '上面的内容可能不完整。',
      retry: '重试',
    },
  },
  {
    title: 'Where the code runs',
    page: {
      title: 'Interface panels',
      label: 'Every device that can see sessions, not isolated',
      body: 'The code is sent to every device that can view sessions and runs in Latch’s page there: Latch on this Mac, and browsers on phones and other computers. It can do anything that page can do; nothing isolates it. The iPhone app does not run it.',
    },
    host: {
      title: 'Tools and background code',
      label: 'Runs on this Mac, not isolated',
      body: 'Runs on this Mac with the same rights as Latch: it can read and write your files, run programs and reach the network, and it can also register interface panels that are sent to devices that can view sessions.',
    },
    text: {
      title: 'Skills and static panels',
      label: 'Only text, runs no code',
      body: 'Only text, runs no code. Skills go to Latch’s built-in Harness on this Mac; static panels are visible on every device that can view sessions.',
    },
    unread: {
      title: 'Could not read this plugin’s declaration',
      body: 'What is shown above may be incomplete.',
      retry: 'Retry',
    },
  },
)

/**
 * Model services: where keys are typed and how an address becomes usable. Keys are typed only in the Latch app on this
 * Mac; a known service's HTTPS address and an address confirmed once take a key directly; any other address is confirmed
 * once (Touch ID or the login password), together with its key. Every restricted control says why and where to go.
 */
export const PROVIDER_COPY = defineCopy(
  {
    keyHeld: { label: '只存在这台 Mac 上', detail: '密钥不会发给浏览器或手机。' } satisfies Brief,
    /** Other devices: the key field becomes this line. */
    keyElsewhere: (computer = 'Mac') => `在 ${computer} 上的 Latch 里填写`,
    /** Without Touch ID or a password to confirm with, for an address not confirmed yet: the key goes in with the address. */
    keyOffline: (id: string) =>
      `地址确认之前不能在这里填写密钥：停止 Latch 服务后运行 ${localLatchCommand()} provider set-key ${id}，密钥与地址一起确认。`,
    /** The add form on a device that cannot type keys, for a service that needs one. */
    keyAfterSave: (computer = 'Mac') => `保存后在 ${computer} 上填写密钥`,
    /** A saved service at a known address without a key: it is not offered. */
    missingKey: '还没有密钥，Latch 不会使用它',
    missingKeyBadge: '缺密钥',
    missingKeyElsewhere: (name: string, computer = 'Mac') => `在 ${computer} 上的 Latch 里填写密钥：设置 › 模型 › ${name}。`,
    /** The check is a model listing: a service without one is not a failed connection. */
    listingUnavailable: '这个服务不提供模型列表',
    /** 已连接 comes from a listing, and some services list their models without looking at the key. */
    connectedReason: '服务刚刚回答了模型列表请求。有些服务列出模型不需要密钥，所以这不证明密钥能用于对话。',
    checkNeedsAddress: '确认地址后才能检测',
    checkNeedsKey: '填写密钥后才能检测',
    /** The probe met a local or private address: not an error, it is confirmed with the save. The sentence is the probe's. */
    localAddress: (target: string) => `这是这台 Mac 或局域网上的地址。确认后 Latch 才会访问 ${target}。`,
    localNote: (target: string): Brief => ({ label: '这台 Mac 或局域网上的地址', detail: `确认后 Latch 才会访问 ${target}。` }),
    localNoteAtSave: (target: string): Brief => ({
      label: '这台 Mac 或局域网地址，保存时确认',
      detail: `确认后 Latch 才会访问 ${target}。`,
    }),
    allowAndFetch: '用 Touch ID 允许并获取模型',
    saveWithTouchID: '用 Touch ID 保存',
    confirmAddress: '用 Touch ID 确认地址',
    waitingTouchID: '等待 Touch ID…',
    save: '保存',
    unconfirmed: '地址还没确认，Latch 不会使用它',
    unconfirmedNote: { label: '确认后才会发出请求', detail: 'localhost 或局域网地址确认后，Latch 同时可以访问它。' } satisfies Brief,
    unconfirmedBadge: '未确认',
    unconfirmedRow: (computer = 'Mac') => `需要在 ${computer} 上确认这个地址`,
    /** Other devices: where the address is confirmed. */
    confirmElsewhere: (name: string, computer = 'Mac') => `需要在 ${computer} 上确认这个地址：设置 › 模型 › ${name}。`,
    /** A computer without Touch ID or a password to confirm with: the offline command. */
    confirmOffline: (id: string) =>
      `这台电脑不能用 Touch ID 或登录密码确认。停止 Latch 服务后运行 ${localLatchCommand()} provider confirm ${id}（或用 set-key 同时保存密钥），再启动 Latch。`,
    confirmOfflineNew: () =>
      `这台电脑不能用 Touch ID 或登录密码确认。先不填密钥保存，再停止 Latch 服务，运行 ${localLatchCommand()} provider confirm <服务 ID>。`,
    /** A Mac whose confirmation component needs fixing (rebuilt, signature lost): the given reason, with its fix. */
    presenceBroken: (message: string) => `这台 Mac 暂时不能确认：${message}`,
    savedUnconfirmed: (computer = 'Mac') => `保存后在 ${computer} 上确认这个地址`,
    /** A confirmed address whose allowance was removed. */
    allowAgain: (target: string) => `用 Touch ID 允许访问 ${target}`,
    allowElsewhere: (computer = 'Mac') => `需要在 ${computer} 上的 Latch 里允许这个地址。`,
    confirmedAddressesTitle: '已确认的地址',
    confirmedAddressesCaption: {
      label: '确认一次后才能使用',
      detail: '自定义和这台 Mac 上的模型服务，地址确认一次后才能使用。移除后，用它的服务随即停止。',
    } satisfies Brief,
    addressUse: (services: readonly string[], allowance?: string) =>
      [
        services.length ? `${services.map(escapeSecurityText).join('、')} 在用` : '没有服务在用',
        ...(allowance ? [`Latch 可以连接 ${allowance}`] : []),
      ].join(' · '),
    removeAddress: (services: readonly string[]) =>
      `${services.length ? `${services.map(name => `「${escapeSecurityText(name)}」`).join('、')}随即停止发送请求，正在运行的会话下一次请求会失败。` : ''}要再用这个地址，保存模型服务时重新确认。`,
    allowanceRow: 'Latch 可以连接这个地址',
    removeAllowance: '依赖这个地址的连接随即断开。要再用它，需要在这台 Mac 上重新确认。',
  },
  {
    keyHeld: { label: 'Stored only on this Mac', detail: 'Keys are never sent to browsers or phones.' },
    keyElsewhere: (computer = 'Mac') => `Enter it in Latch on ${computer}`,
    keyOffline: (id: string) =>
      `A key cannot be entered here before the address is confirmed: stop the Latch service and run ${localLatchCommand()} provider set-key ${id}; the key is confirmed together with the address.`,
    keyAfterSave: (computer = 'Mac') => `Enter the key on ${computer} after saving`,
    missingKey: 'No key yet, so Latch will not use it',
    missingKeyBadge: 'No key',
    missingKeyElsewhere: (name: string, computer = 'Mac') => `Enter the key in Latch on ${computer}: Settings › Models › ${name}.`,
    listingUnavailable: 'This service does not list its models',
    connectedReason:
      'The service just answered a model list request. Some services list models without checking the key, so this does not prove the key works for chat.',
    checkNeedsAddress: 'Confirm the address to check',
    checkNeedsKey: 'Enter a key to check',
    localAddress: (target: string) =>
      `This is an address on this Mac or the local network. Latch reaches ${target} only after you confirm it.`,
    localNote: (target: string): Brief => ({
      label: 'Address on this Mac or the local network',
      detail: `Latch reaches ${target} only after you confirm it.`,
    }),
    localNoteAtSave: (target: string): Brief => ({
      label: 'Local address, confirmed when you save',
      detail: `Latch reaches ${target} only after you confirm it.`,
    }),
    allowAndFetch: 'Allow with Touch ID and fetch models',
    saveWithTouchID: 'Save with Touch ID',
    confirmAddress: 'Confirm address with Touch ID',
    waitingTouchID: 'Waiting for Touch ID…',
    save: 'Save',
    unconfirmed: 'Address not confirmed, so Latch will not use it',
    unconfirmedNote: {
      label: 'No requests until confirmed',
      detail: 'Once a localhost or local network address is confirmed, Latch can also reach it.',
    },
    unconfirmedBadge: 'Unconfirmed',
    unconfirmedRow: (computer = 'Mac') => `Confirm this address on ${computer}`,
    confirmElsewhere: (name: string, computer = 'Mac') => `Confirm this address on ${computer}: Settings › Models › ${name}.`,
    confirmOffline: (id: string) =>
      `This computer cannot confirm with Touch ID or a login password. Stop the Latch service, run ${localLatchCommand()} provider confirm ${id} (or set-key to save the key at the same time), then start Latch again.`,
    confirmOfflineNew: () =>
      `This computer cannot confirm with Touch ID or a login password. Save without a key first, then stop the Latch service and run ${localLatchCommand()} provider confirm <service ID>.`,
    presenceBroken: (message: string) => `This Mac cannot confirm right now: ${message}`,
    savedUnconfirmed: (computer = 'Mac') => `Confirm this address on ${computer} after saving`,
    allowAgain: (target: string) => `Allow access to ${target} with Touch ID`,
    allowElsewhere: (computer = 'Mac') => `This address has to be allowed in Latch on ${computer}.`,
    confirmedAddressesTitle: 'Confirmed addresses',
    confirmedAddressesCaption: {
      label: 'Usable after one confirmation',
      detail:
        'Custom model services and those on this Mac can be used once their address is confirmed. Remove it and the services using it stop at once.',
    },
    addressUse: (services: readonly string[], allowance?: string) =>
      [
        services.length ? `In use by ${formatList(services.map(escapeSecurityText))}` : 'No service uses it',
        ...(allowance ? [`Latch can connect to ${allowance}`] : []),
      ].join(' · '),
    removeAddress: (services: readonly string[]) =>
      `${services.length ? `${formatList(services.map(name => `“${escapeSecurityText(name)}”`))} stop sending requests at once, and running sessions fail on their next request. ` : ''}To use this address again, confirm it again when you save a model service.`,
    allowanceRow: 'Latch can connect to this address',
    removeAllowance: 'Connections that rely on this address end at once. To use it again, confirm it again on this Mac.',
  },
)

/** 设置 › 关于 and 设置 › Harness: who the code runs as. `on` is 「这台 Mac 上」 or 「 <name> 上」. */
export const RUNS_AS_YOU_COPY = defineCopy(
  {
    about: (on: string): Brief => ({ label: 'Harness 和插件以你的权限运行', detail: `它们在${on}运行，Latch 不隔离它们。` }),
    engines: (on: string): Brief => ({
      label: 'Harness 以你的权限运行',
      detail: `Harness 是${on}已安装的程序。Latch 不会替你安装它们，也不隔离它们。`,
    }),
    /** Beside the 开发版 mark, which says it only on hover: what a development run means for whoever reads it. */
    devMode: { label: '其他程序可以修改 Latch 的代码' } satisfies Brief,
  },
  {
    about: (on: string): Brief => ({
      label: 'Harnesses and plugins run with your permissions',
      detail: `They run ${on}; Latch does not isolate them.`,
    }),
    engines: (on: string): Brief => ({
      label: 'Harnesses run with your permissions',
      detail: `Harnesses are programs installed ${on}. Latch does not install them for you or isolate them.`,
    }),
    devMode: { label: 'Other programs can change Latch’s code' },
  },
)

/** Why a session no longer accepts input, as an error elsewhere (`describeFailure`). */
export const SESSION_STOP_TEXT = defineCopy(
  {
    'permission-drift': '这个 Harness 的设置变了，为了安全换个新会话继续',
    'agent-definition-changed': '这个 Harness 的设置变了，为了安全换个新会话继续',
    'project-config-changed': '项目里的 Harness 配置变了，为了安全换个新会话继续',
    'l3-confirmation-missing': '这个会话缺少启动记录，不能继续。换个新会话继续',
    'permission-unverified': '确认不了 Harness 的权限，这一轮没有发送',
    'harness-session-lost': '这个 Harness 已找不到原来的会话，换个新会话继续',
  },
  {
    'permission-drift': 'This Harness’s settings changed; to be safe, continue in a new session',
    'agent-definition-changed': 'This Harness’s settings changed; to be safe, continue in a new session',
    'project-config-changed': 'The project’s Harness configuration changed; to be safe, continue in a new session',
    'l3-confirmation-missing': 'This session has no start record and cannot continue. Continue in a new session',
    'permission-unverified': 'Could not confirm the Harness’s permissions, so this turn was not sent',
    'harness-session-lost': 'The Harness can no longer find this session. Start a new session to continue.',
  },
)
export const DOCUMENT_PREVIEW_ERRORS = defineCopy(
  {
    'document-too-complex': '这份演示文稿的内容过于复杂，暂时无法预览。可以下载或在电脑上打开。',
    'zip-refused': '文档压缩结构超出预览上限，可以下载或在电脑上打开。',
    fallback: '无法显示这个文档，请下载或在 Mac 上打开。',
  },
  {
    'document-too-complex': 'This presentation is too complex to preview for now. Download it or open it on a computer.',
    'zip-refused': 'The document’s compressed structure is beyond the preview limit. Download it or open it on a computer.',
    fallback: 'This document cannot be shown. Download it or open it on the Mac.',
  },
)
export type SessionStopCode = keyof typeof SESSION_STOP_TEXT
/** The same as the line above the input: a few words beside the shield, with 「在新会话中继续」 after them. */
export const SESSION_STOP_LABEL = defineCopy<Record<SessionStopCode, string>>(
  {
    'permission-drift': 'Harness 的设置变了',
    'agent-definition-changed': 'Harness 的设置变了',
    'project-config-changed': '项目的 Harness 配置变了',
    'l3-confirmation-missing': '会话缺少启动记录',
    'permission-unverified': '没能确认权限，这一轮没发送',
    'harness-session-lost': 'Harness 找不到原来的会话了',
  },
  {
    'permission-drift': 'Harness settings changed',
    'agent-definition-changed': 'Harness settings changed',
    'project-config-changed': 'Project’s Harness config changed',
    'l3-confirmation-missing': 'Session has no start record',
    'permission-unverified': 'Permissions not confirmed, turn not sent',
    'harness-session-lost': 'Harness lost the session',
  },
)
/** The same stop after a mode change, where no message was on its way. */
export const isSessionStopCode = (code: string): code is SessionStopCode => code in SESSION_STOP_TEXT
/** A mode that could not be read back this once: nothing went out, the session may read true on the next try. */
export const stopLocksInput = (code: SessionStopCode) => code !== 'permission-unverified'

/** Disabled controls: the hover reason, for a control the Mac alone can change. */
export const HOVER_REASONS = defineCopy(
  {
    onMac: (computer = 'Mac') => `在 ${computer} 上的 Latch 里操作`,
    confirmOnMac: (computer = 'Mac') => `在 ${computer} 上确认`,
    macOnly: '只能在这台 Mac 上改',
    openInLatch: '在 Latch 中打开',
    noView: '这台设备不能查看',
  },
  {
    onMac: (computer = 'Mac') => `Do this in Latch on ${computer}`,
    confirmOnMac: (computer = 'Mac') => `Confirm on ${computer}`,
    macOnly: 'Only changeable on this Mac',
    openInLatch: 'Open in Latch',
    noView: 'This device cannot view this',
  },
)

/** The composer's 权限 chip and its rows with the agent as subject. */
export const MODE_COPY = defineCopy(
  {
    launchSetting: {
      label: '启动设置 · 未独立读回',
      detail: '通过启动参数或私有配置应用；Agent 不独立报告该参数的有效值。',
    } satisfies Brief,
    menuTitle: '什么时候问你？',
    noFiles: '不读写文件',
    noFilesLine: '只回复文字',
    askFirst: '先问你',
    askFirstLine: '改文件或运行命令前问你',
    /** The built-in engine has no way to run a command, so its mode cannot speak of one. */
    askBeforeWritesLine: '读项目不问；写文件每次问你',
    /** Any Harness but Latch 内置: a fact about who decides, not a warning. */
    fullAccess: '外部 Harness',
    agentDecides: (agent: string) => `不询问 · 由 ${agent} 决定`,
    /** Only pi declares this: its tools never ask, but an extension's confirmation reaches the person. */
    agentDecidesLine: (agent: string) => `${agent} 执行工具前不询问，只有扩展要求确认时才问你；Latch 不限制它`,
    /**
     * The timeline's first row, once per launch in a project: the 权限 chip and the heading must not read as a limit, so
     * the label itself says 不隔离; what it can do stays one press away.
     */
    firstStart: (agent: string): Brief => ({
      label: `Latch 不隔离 ${agent}`,
      detail: `${agent} 能读写这台 Mac 上的文件并运行命令。权限是 ${agent} 自己的设置。`,
    }),
    /** The same for a Harness that never asks (pi). */
    firstStartUnasked: (agent: string): Brief => ({
      label: `${agent} 不询问，Latch 不隔离它`,
      detail: `${MODE_COPY.agentDecidesLine(agent)}。`,
    }),
    /** The same as the 权限 row says it: the label already says it never asks; who sets the limits stays one press away. */
    agentDecidesRow: '只有扩展要求确认时才问你',
    agentDecidesNote: (agent: string): Brief => ({ label: `${agent} 自己决定`, detail: 'Latch 不限制它，也不隔离它。' }),
    unverifiable: '权限无法确认',
    unverifiableLine: '设为只读，但读不回来',
    /** A draft on a Harness whose modes nothing has reported yet: it starts in its own default, which is all there is to show. */
    afterStart: '默认',
    /** The same for a Harness whose lists can be read before a session: opening the menu reads them, modes included. */
    afterRead: '默认',
    reading: '正在读取…',
    modesReading: (agent: string): Brief => ({ label: `正在读取 ${agent} 的权限…` }),
    modesUnread: (agent: string): Brief => ({ label: `没有读到 ${agent} 的权限` }),
    /**
     * Under the rows of a running agent: whose setting it is, with the mark; that Latch checks only which row it picked
     * and does not isolate it stays one press away (no isolation may be implied).
     */
    agentOwnSetting: (agent: string): Brief => ({
      label: `${agent} 自己的设置`,
      detail: 'Latch 只核对它选的是哪一项，不核对它实际怎么做，也不隔离它。',
    }),
    /** Latch's word for each tier of a harness's modes; the line under it is the harness's own. */
    tierTitles: { plan: '只看不改', ask: '先问你', rule: '按规则放行', model: '由模型判断', never: '不再询问' },
    /** A fork onto a Harness without the source's row: the row it takes instead, never a wider one unless there is none. */
    forkOtherRow: (was: string, agent: string, now: string, stricter: boolean) =>
      stricter ? `权限「${was}」→ 更严的「${now}」` : `权限「${was}」→ ${agent} 最严的「${now}」`,
    forkNoRow: (was: string, agent: string) => `权限「${was}」→ ${agent} 的默认项`,
    forkDrifted: (agent: string) => `来源权限被改过，用 ${agent} 的默认项`,
    forkFromChat: (agent: string) => `来源不读写文件，用 ${agent} 的默认项`,
  },
  {
    launchSetting: {
      label: 'Set at launch',
      detail: 'Applied through startup options or private configuration. The Agent does not report the effective value separately.',
    },
    menuTitle: 'When should it ask you?',
    noFiles: 'No file access',
    noFilesLine: 'Replies with text only',
    askFirst: 'Ask first',
    askFirstLine: 'Asks before changing files or running commands',
    askBeforeWritesLine: 'Reads the project freely; asks before every write',
    fullAccess: 'External Harness',
    agentDecides: (agent: string) => `Never asks · ${agent} decides`,
    agentDecidesLine: (agent: string) =>
      `${agent} runs tools without asking and asks you only when an extension requires confirmation; Latch does not limit it`,
    firstStart: (agent: string): Brief => ({
      label: `Latch does not isolate ${agent}`,
      detail: `${agent} can read and write files on this Mac and run commands. Its permissions are ${agent}’s own settings.`,
    }),
    firstStartUnasked: (agent: string): Brief => ({
      label: `${agent} never asks; Latch does not isolate it`,
      detail: `${MODE_COPY.agentDecidesLine(agent)}.`,
    }),
    agentDecidesRow: 'Asks you only when an extension requires it',
    agentDecidesNote: (agent: string): Brief => ({ label: `${agent} decides`, detail: 'Latch does not limit it or isolate it.' }),
    unverifiable: 'Permissions cannot be confirmed',
    unverifiableLine: 'Set to read only, but could not be read back',
    afterStart: 'Default',
    afterRead: 'Default',
    reading: 'Reading…',
    modesReading: (agent: string): Brief => ({ label: `Reading ${agent}’s permissions…` }),
    modesUnread: (agent: string): Brief => ({ label: `Could not read ${agent}’s permissions` }),
    agentOwnSetting: (agent: string): Brief => ({
      label: `${agent}’s own setting`,
      detail: 'Latch checks only which option it picked, not what it actually does, and does not isolate it.',
    }),
    tierTitles: { plan: 'Read only', ask: 'Ask first', rule: 'Allow by rules', model: 'Model decides', never: 'Never ask' },
    forkOtherRow: (was: string, agent: string, now: string, stricter: boolean) =>
      stricter ? `Permissions “${was}” → stricter “${now}”` : `Permissions “${was}” → ${agent}’s strictest “${now}”`,
    forkNoRow: (was: string, agent: string) => `Permissions “${was}” → ${agent}’s default`,
    forkDrifted: (agent: string) => `The source’s permissions were changed; using ${agent}’s default`,
    forkFromChat: (agent: string) => `The source had no file access; using ${agent}’s default`,
  },
)

/**
 * The model menu's one folded row for the saved services a Harness cannot use, and the reason on each when it opens. A
 * reason that names a key or an unconfirmed address points to where that is done; it never offers to do it here.
 */
export const MODEL_MENU_COPY = defineCopy(
  {
    unusable: (count: number) => `${count} 个服务用不了`,
    /** The Harness speaks a protocol the service does not: which ones each speaks. */
    wrongProtocol: (agent: string, speaks: readonly string[], service: string) =>
      `${agent} 只说 ${speaks.join('、')}，这个服务是 ${service}`,
    /** A Harness or service Latch does not forward between: no Harness chosen yet, or a plugin's own provider. */
    notRouted: (agent: string) => `转发 ${agent} 的请求尚未实现`,
    missingKey: '没有密钥 · 在设置 › 模型里添加',
    unconfirmed: (computer = 'Mac') => `地址还没确认 · 在 ${computer} 上确认`,
  },
  {
    unusable: (count: number) => plural(count, { one: '{n} service unavailable', other: '{n} services unavailable' }),
    wrongProtocol: (agent: string, speaks: readonly string[], service: string) =>
      `${agent} speaks ${formatList(speaks)}. This service uses ${service}.`,
    notRouted: (agent: string) => `Routing ${agent}’s requests is not implemented yet`,
    missingKey: 'No key · add one in Settings › Models',
    unconfirmed: (computer = 'Mac') => `Address not confirmed · confirm on ${computer}`,
  },
)

/**
 * A call no person was asked about, as its row in the timeline says it: the harness's own model reviewing a request, or a
 * call that ran unasked while that model decides. Never words for a person's approval.
 */
export const JUDGED_COPY = defineCopy(
  {
    review: (agent: string) => `${agent} 的模型审阅`,
    approved: '放行',
    denied: '拦下',
    none: '没有判断',
    referred: '交给你',
    /** Latch 内置's model judged the row's own call: who decided in a few words, its reason behind ⓘ. */
    ownBrief: (outcome: 'approved' | 'denied' | 'none' | 'unasked' | 'referred', reason?: string): Brief => ({
      label: outcome === 'approved' ? '模型放行，不是你的批准' : outcome === 'referred' ? '模型交给你决定' : '模型没有判断，问了你',
      detail: reason ? `模型的理由：${reason}` : '模型的回答无法使用，这次调用照常问你。',
    }),
    /** In a folded turn's words. */
    deniedCount: (count: number) => `模型拦下 ${count} 次`,
    reviewNote: (agent: string) => `这是 ${agent} 自己的模型代你做的判断，不是你的批准；它拦下的在这里不能改为允许。`,
    unasked: '没有问你',
    unaskedNote: (agent: string) => `${agent} 当时由它的模型代你决定，没有问你就运行了；Latch 不知道是它的规则还是模型放行的。`,
    /** The opened row's line: who decided in a few words, the note behind ⓘ. */
    reviewBrief: (agent: string): Brief => ({ label: '模型的判断，不是你的批准', detail: JUDGED_COPY.reviewNote(agent) }),
    unaskedBrief: (agent: string): Brief => ({ label: '由模型代你决定', detail: JUDGED_COPY.unaskedNote(agent) }),
    ruleBrief: (agent: string): Brief => ({ label: '要放行，换权限或改规则', detail: JUDGED_COPY.ruleNote(agent) }),
    /** The line under a call the Harness refused itself before it ran, with its own words for why. */
    blockedByModel: (agent: string, reason?: string) => `${agent} 的模型审阅${reason ? `：${reason}` : '拦下了这次调用'}`,
    blockedByRule: (agent: string, reason?: string) => `被 ${agent} 自己的规则或当前模式拦下${reason ? `：${reason}` : ''}`,
    ruleNote: (agent: string) =>
      `${agent} 按它自己的权限规则或当前模式拦下了这次调用，没有运行；模式拦下的，在「权限」换一档后可以放行，规则拦下的要改 ${agent} 自己的权限设置。`,
    /** In a folded turn's words. */
    ruleBlockedCount: (count: number) => `规则拦下 ${count} 次`,
  },
  {
    review: (agent: string) => `${agent}’s model review`,
    approved: 'Let through',
    denied: 'Blocked',
    none: 'No judgment',
    referred: 'Left to you',
    ownBrief: (outcome: 'approved' | 'denied' | 'none' | 'unasked' | 'referred', reason?: string): Brief => ({
      label:
        outcome === 'approved'
          ? 'The model let it through, not your approval'
          : outcome === 'referred'
            ? 'The model left it to you'
            : 'The model did not judge; you were asked',
      detail: reason ? `The model’s reason: ${reason}` : 'The model’s answer could not be used, so you were asked as usual.',
    }),
    deniedCount: (count: number) => plural(count, { one: 'Model blocked {n} time', other: 'Model blocked {n} times' }),
    reviewNote: (agent: string) =>
      `This is ${agent}’s own model judging for you, not your approval; what it blocked cannot be changed to allowed here.`,
    unasked: 'Did not ask you',
    unaskedNote: (agent: string) =>
      `${agent}’s model decided for you then, and it ran without asking you; Latch does not know whether its rules or its model let it through.`,
    reviewBrief: (agent: string): Brief => ({ label: 'The model’s judgment, not your approval', detail: JUDGED_COPY.reviewNote(agent) }),
    unaskedBrief: (agent: string): Brief => ({ label: 'The model decided for you', detail: JUDGED_COPY.unaskedNote(agent) }),
    ruleBrief: (agent: string): Brief => ({ label: 'To allow it, change permissions or rules', detail: JUDGED_COPY.ruleNote(agent) }),
    blockedByModel: (agent: string, reason?: string) => `${agent}’s model review${reason ? `: ${reason}` : ' blocked this call'}`,
    blockedByRule: (agent: string, reason?: string) => `Blocked by ${agent}’s own rules or current mode${reason ? `: ${reason}` : ''}`,
    ruleNote: (agent: string) =>
      `${agent} blocked this call by its own permission rules or current mode, and it did not run. If the mode blocked it, choose another level in Permissions to allow it; if a rule blocked it, change ${agent}’s own permission settings.`,
    ruleBlockedCount: (count: number) => plural(count, { one: 'Rules blocked {n} time', other: 'Rules blocked {n} times' }),
  },
)

/** The drawer's one line when a session cannot go on as it is, and what it offers. */
export const RECOVERY_COPY = defineCopy(
  {
    folderMissing: (project: string) => `项目文件夹「${project}」找不到了`,
    continueInNew: '在新会话中继续',
  },
  {
    folderMissing: (project: string) => `Project folder “${project}” cannot be found`,
    continueInNew: 'Continue in new session',
  },
)

/**
 * 接入已有会话: the session brought in is private from the start, so only a device that may see private sessions lists,
 * previews or imports. A device without that sees the entry locked, with where it is opened.
 */
export const HISTORY_COPY = defineCopy(
  {
    entry: '接入已有会话',
    locked: (computer = 'Mac') =>
      `接入的会话只对能看私有内容的设备可见。在 ${computer} 上的 Latch 里，为这台设备开启「也能看私有内容」后可用。`,
    busy: '这个会话正在别处使用',
    busyDetail: (from: string) => `先在那里退出（例如终端里的 ${from}），再回来接入。Latch 不会接管正在使用的会话。`,
  },
  {
    entry: 'Import a session',
    locked: (computer = 'Mac') =>
      `Imported sessions are visible to devices that can read private content. In Latch on ${computer}, enable “Also see private content” for this device.`,
    busy: 'This session is in use elsewhere',
    busyDetail: (from: string) =>
      `Exit the session there, for example in ${from} in the terminal, and try again. Latch leaves active sessions alone.`,
  },
)

const FIXED = defineCopy<Record<string, string>>(
  {
    'file-too-large': '文件或图片超过这台设备的预览上限，请在 Mac 上查看。',
    'file-edit-elevated': '这个文件需要能批准高风险操作的设备',
    'file-code-root': 'Latch 程序目录里的文件不能在这里编辑',
    'file-mixed-eol': '混用换行符的文件不能在这里编辑',
    'file-edit-scope': '这台设备不能发起会话，不能编辑文件',
    'file-edit-data-scope': '这台设备不能编辑会话文件夹中的文件',
    unauthorized: '这台设备还没有连接到这台 Mac',
    'renewal-required': '这台设备需要重新连接',
    'legacy-reconfirm': '这台设备需要重新连接',
    'policy-changed': '设置刚被修改过，这次更改没有应用。请查看最新的设置后重试。',
    'presence-unavailable': '这台 Mac 暂时不能确认',
    'origin-unconfirmed': '这个模型服务的地址还没有确认，Latch 不会向它发送请求。请在 Mac 上的 Latch 里确认：设置 › 模型。',
    'provider-target-required': '请更新并重新打开 Latch 后再修改模型服务的地址、协议或密钥。',
    'provider-target-changed': '模型服务的地址或协议已更改。请核对当前设置后重试。',
    'confirmation-not-found': '找不到该确认',
    'confirmation-pending': '还没有确认',
    'confirmation-mismatch': '确认内容与本次请求不一致，请重新确认',
    'confirmation-used': '该确认已使用',
    'confirmation-os-required': '这项操作要用 Touch ID 或登录密码确认，请重试。',
    'confirmation-signature-invalid': '没有执行：确认无效。',
    'confirmation-shell-unavailable': '请更新 Mac 上的 Latch 后再确认。',
    'device-changed': '这台设备的权限刚被改过，这次没有应用。请看过最新的设置后再试。',
    'scope-not-grantable': '这种连接方式不能有这项权限。',
    'tls-not-configured': '这台 Mac 还不能让其他电脑连接，所以不能生成链接。',
    'shell-managed': '这一步由 Mac 上的 Latch 自己完成，页面不能直接做。',
    'enrollment-denied': 'Mac 上取消了连接。',
    'enrollment-not-found': '找不到这个连接请求',
    'enrollment-pending': 'Mac 上尚未确认',
    'enrollment-completed': '这次连接已完成',
    'enrollment-expired': '连接请求已超时，请重新提交',
    'enrollment-cancelled': '连接已取消。',
    'invitation-required': '这台设备还没连接到 Latch。请在 Mac 上的 Latch 里连接它。',
    'invitation-invalid': '这个链接已失效或已用过，请重新获取。',
    'offline-code-invalid': '离线连接码无效或已过期',
    'approval-settled': '该审批已结束',
    'fingerprint-mismatch': '这台设备的密钥和 Mac 读到的不一致，已停止连接。',
    'work-computer-unavailable': '无法打开该助手。请检查工作电脑上的 Latch 版本、助手和本设备的查看与运行权限。',
    'host-unavailable': '连不上这台 Mac 上的 Latch，请确认它还在运行。',
    'credential-store-failed': '无法安全保存设备凭据，连接未完成。',
    'browser-open-unsupported': `此系统上不能从 Latch 应用直接打开浏览器，请运行 ${LATCH_COMMAND} device invite --loopback。`,
    'browser-open-failed': '无法在浏览器中打开 Latch，请重试。',
    'copy-link-unsupported': `此系统上不能从 Latch 应用复制链接，请运行 ${LATCH_COMMAND} device invite。`,
    'copy-link-failed': '无法复制链接，请重试。',
    'native-not-configured': '请先在 设置 › 设备 中设置手机的连接方式。',
    'native-config-changed': '手机连接配置已变化。请重新打开设置连接，再核对后保存。',
    'native-relay-duplicate': '每个中继节点只能添加一次。',
    'native-relay-limit': '最多添加四个自建中继。',
    'native-relay-pending': '先继续验证或放弃当前的中继添加。',
    'native-relay-owner': '请使用开始添加的设备继续验证。',
    'native-relay-request-missing': '没有找到这次添加，请检查已保存的中继。',
    'native-relay-cancelled': '这次中继添加已放弃。',
    'native-relay-egress': '当前的出站规则不允许连接这个中继。',
    'native-relay-unconfirmed': '还无法确认中继可用。请核对地址、证书和注册令牌，然后继续验证。',
    'native-relay-write-unknown': '中继配置的保存结果尚未确认，请继续原请求。',
    'native-relay-address': '这个中继的地址不符合连接簿格式，手机无法使用。请移除后用新的中继文件添加。',
    'native-relay-testing': '另一项中继测试正在进行，请稍后再试。',
    'native-managed': '这个地址由启动参数管理，需要停止 Latch 服务后修改参数。',
    'native-address-unavailable': '原来的局域网地址已不可用，请重新选择当前地址。',
    'native-listener-unavailable': '无法启用所选地址或端口，请核对网络后重试。',
    'native-not-ready': '手机连接服务正在准备，请稍后重试。',
    'native-verification-required': '请先在手机完成身份验证，再查看正文或操作。',
  },
  {
    'file-too-large': 'The file or image is over this device’s preview limit. View it on the Mac.',
    'file-edit-elevated': 'This file needs a device that can approve high-risk actions.',
    'file-code-root': 'Files in the Latch program directory cannot be edited here.',
    'file-mixed-eol': 'Files with mixed line endings cannot be edited here.',
    'file-edit-scope': 'This device cannot start sessions or edit files.',
    'file-edit-data-scope': 'This device cannot edit files in session folders.',
    unauthorized: 'This device is not connected to this Mac yet',
    'renewal-required': 'This device needs to connect again',
    'legacy-reconfirm': 'This device needs to connect again',
    'policy-changed': 'Settings were just changed, so this change was not applied. Check the latest settings and try again.',
    'presence-unavailable': 'This Mac cannot confirm right now',
    'origin-unconfirmed':
      'This model service’s address is not confirmed yet, so Latch will not send it requests. Confirm it in Latch on the Mac: Settings › Models.',
    'provider-target-required': 'Update and reopen Latch before changing the model service address, protocol or key.',
    'provider-target-changed': 'The model service address or protocol changed. Check the current settings and try again.',
    'confirmation-not-found': 'Confirmation not found',
    'confirmation-pending': 'Not confirmed yet',
    'confirmation-mismatch': 'The confirmation does not match this request. Confirm again',
    'confirmation-used': 'This confirmation was already used',
    'confirmation-os-required': 'This needs confirming with Touch ID or a login password. Try again.',
    'confirmation-signature-invalid': 'Not done: the confirmation is invalid.',
    'confirmation-shell-unavailable': 'Update Latch on the Mac, then confirm again.',
    'device-changed': 'This device’s permissions were just changed, so this was not applied. Check the latest settings and try again.',
    'scope-not-grantable': 'This kind of connection cannot have this permission.',
    'tls-not-configured': 'This Mac cannot let other computers connect yet, so no link can be made.',
    'shell-managed': 'Latch on the Mac does this step itself; the page cannot do it directly.',
    'enrollment-denied': 'The connection was cancelled on the Mac.',
    'enrollment-not-found': 'Connection request not found',
    'enrollment-pending': 'Not confirmed on the Mac yet',
    'enrollment-completed': 'This connection is already complete',
    'enrollment-expired': 'The connection request timed out. Send it again',
    'enrollment-cancelled': 'Connection cancelled.',
    'invitation-required': 'This device is not connected to Latch yet. Connect it in Latch on the Mac.',
    'invitation-invalid': 'This link has expired or was already used. Get a new one.',
    'offline-code-invalid': 'The offline code is invalid or has expired',
    'approval-settled': 'This approval has already ended',
    'fingerprint-mismatch': 'This device’s key does not match what the Mac read. Connection stopped.',
    'work-computer-unavailable':
      'Cannot open this assistant. Check the Latch version, assistant, and this device’s view and run access on the work computer.',
    'host-unavailable': 'Cannot reach Latch on this Mac. Check that it is still running.',
    'credential-store-failed': 'The device credential could not be saved safely, so the connection did not finish.',
    'browser-open-unsupported': `The Latch app cannot open a browser on this system. Run ${LATCH_COMMAND} device invite --loopback.`,
    'browser-open-failed': 'Could not open Latch in the browser. Try again.',
    'copy-link-unsupported': `The Latch app cannot copy a link on this system. Run ${LATCH_COMMAND} device invite.`,
    'copy-link-failed': 'Could not copy the link. Try again.',
    'native-not-configured': 'Set up how phones connect in Settings › Devices first.',
    'native-config-changed': 'The phone connection settings changed. Open the connection settings again, check them and save.',
    'native-relay-duplicate': 'Each relay can be added only once.',
    'native-relay-limit': 'You can add up to four self-hosted relays.',
    'native-relay-pending': 'Continue verifying the current relay or cancel it first.',
    'native-relay-owner': 'Continue verification on the device that started it.',
    'native-relay-request-missing': 'This relay request is missing. Check the saved relays.',
    'native-relay-cancelled': 'The relay request was cancelled.',
    'native-relay-egress': 'The current network rules do not allow a connection to this relay.',
    'native-relay-unconfirmed': 'The relay is still unverified. Check the address, certificate and registration token, then continue.',
    'native-relay-address':
      'This relay’s address is outside the address-book format, so phones can’t use it. Remove it and add a new relay file.',
    'native-relay-testing': 'Another relay test is running. Try again shortly.',
    'native-relay-write-unknown': 'Saving the relay is still unconfirmed. Continue the original request.',
    'native-managed': 'This address is set by launch options. Stop the Latch service to change them.',
    'native-address-unavailable': 'The previous local network address is no longer available. Choose a current one.',
    'native-listener-unavailable': 'Could not use the chosen address or port. Check the network and try again.',
    'native-not-ready': 'The phone connection service is getting ready. Try again shortly.',
    'native-verification-required': 'Verify on the phone first, then view the content or act.',
  },
)

const EXTRA_FAILURES: Readonly<Record<string, string>> = defineCopy(
  {
    'add-busy': '正在添加另一台电脑。',
    'add-cancelled': '已取消添加。',
    'add-denied': '那台电脑拒绝了这台设备。',
    'add-expired': '等待确认超时，请在那台电脑上重新复制链接。',
    'add-failed': '没有添加成功，请在那台电脑上重新复制链接后再试。',
    'add-used': '这个连接链接已使用，请在那台电脑上重新复制链接。',
    'agent-start-failed': 'Harness 未能启动，消息没有发出。',
    'agent-timeout': 'Harness 没有在时限内答复。',
    'body-too-large': '请求内容过长。',
    'command-queued': '这条命令不能排队或追加，请等本轮结束后发送。',
    busy: '另一个对话框正在打开。',
    'host-updating': '这台电脑正在安装更新，安装完成后再试。',
    'gh-unreachable': '暂时无法读取 PR',
    'cert-changed': '这台电脑的 HTTPS 证书已更换，请在「设置 › 电脑」中重新确认。',
    'cert-error': '这台电脑的 HTTPS 证书不受信任或与地址不符，已停止连接。',
    'cli-link-failed': '无法创建命令行链接，请检查 ~/.local/bin 的权限。',
    'certificate-refused': '这个地址上的服务器没能证明它是那台电脑，新证书没有被信任。',
    'computer-not-found': '找不到这台电脑。',
    'computer-refused': '无法添加这台电脑，请在「设置 › 电脑」中检查。',
    'computer-switch-failed': '无法切换到这台电脑，请重试。',
    'computers-read-only': '打不开设备凭据，电脑列表只能查看。检查后重新打开 Latch。',
    forbidden: 'Latch 拒绝了这次请求。',
    'gesture-required': '请在 Latch 页面上点按后再试。',
    'host-busy': '有会话正在运行或等待审批，结束后再重新启动 Latch 服务。',
    'host-environment': 'Latch 服务使用了启动环境变量。请在原来的终端里重新启动。',
    'host-external': '请在启动 Latch 服务的终端中重新启动。',
    'host-start-failed': 'Latch 服务没有启动，请查看数据目录中的 host.log。',
    'host-starting': 'Latch 服务正在启动，请稍候。',
    'host-stop-timeout': 'Latch 服务没有在 60 秒内停止，未重新启动。',
    'host-unverified': '无法通过 host.sock 核对正在运行的 Latch 服务，未重新启动。',
    'internal-error': '请求未完成。请刷新页面，核对当前状态后重试。',
    'invalid-input': '输入格式不正确，请检查必填内容。',
    'invalid-json': '请求不是有效的 JSON。',
    'invalid-link': '没有找到电脑链接。请在另一台电脑上的 Latch 里复制链接，或选用它生成的连接文件。',
    'item-changed': '待办已被修改，请刷新后再试。',
    'login-item-failed': '无法更改登录项，请在「系统设置 › 通用 › 登录项」中检查。',
    offline: '无法连接到这台电脑，请确认它已开机并运行 Latch。',
    outdated: '请先更新那台电脑上的 Latch，再试一次。',
    'post-not-found': '找不到这条发言。',
    'post-page-not-found': '找不到这页发言。',
    'post-query-invalid': '讨论读取位置无效，请重新打开待办。',
    'post-reply-not-found': '找不到这条回复。',
    'simulator-not-booted': '模拟器未启动。',
    'simulator-control-required': '请先在设备面板里接管这台设备。',
    'preferences-failed': '无法保存设置，请重试。',
    'too-many-computers': '已连接的电脑太多，请先移除一台。',
    'workspace-invalid': '这个目录不能添加到项目。',
    'workspace-overlap': '该目录与不能添加到项目的目录重叠。',
    'workspace-code-root': '该目录与 Latch 程序目录重叠，不能作为项目',
    'terminal-open-failed': '没有打开终端。请自己在终端里运行这条命令。',
    'workspace-unprintable': '目录路径包含无法显示的字符，不能添加到项目。',
    'worktree-include-if': '仓库配置（.git/config）里有 includeIf，未新建工作树。请把 includeIf 移到全局配置或删除后再试。',
    'branches-unreadable': '读不到这个仓库的分支。',
    'branch-switch-unknown': '这个仓库里没有这个本地分支，没有切换。',
    'branch-switch-checked-out': '这个分支已在另一个工作树检出，没有切换。',
    'branch-switch-config': '仓库配置了切换时会运行的程序（filter 驱动或钩子），没有切换。请在终端里切换。',
    'branch-switch-moved': '这个分支刚刚变了，没有切换。重新打开列表再试。',
    'branch-switch-local-changes': '有未提交的改动会被这个分支覆盖，没有切换。先提交或移走这些改动。',
    'branch-switch-failed': 'Git 没有完成切换，文件夹仍在原来的分支上。',
    'branch-switch-turn-running': '这个文件夹里有会话正在运行或等待审批，结束后再切换。',
    'branch-switch-worktree': '工作树的分支属于它的会话，不在这里切换。',
    'branch-switching': '正在切换这个项目文件夹的分支，结束后再试。',
    'preview-unavailable': '文档预览器不可用。',
    'app-frame-unavailable': '插件页面运行环境不可用。',
    'ui-panel-failed': '扩展面板暂时无法读取，请稍后重试。',
    'untrusted-frame': '文档预览不能访问工作台接口。',
    'wrong-host': '这个地址上的不是添加时的那台电脑，已停止连接。',
  },
  {
    'add-busy': 'Another computer is being added. Try again when it finishes.',
    'add-cancelled': 'Adding the computer was cancelled.',
    'add-denied': 'The other computer did not confirm this device.',
    'add-expired': 'Confirmation timed out. Copy a new link on the other computer.',
    'add-failed': 'Couldn’t add this computer. Copy a new link on that computer and try again.',
    'add-used': 'This connection link was already used. Copy a new link on the other computer.',
    'agent-start-failed': 'The Harness couldn’t start. The message was not sent.',
    'agent-timeout': 'The Harness didn’t respond in time.',
    'body-too-large': 'The request is too large.',
    'command-queued': 'This command can’t be queued or added to a running turn. Send it when the turn finishes.',
    busy: 'Another dialog is open. Close it and try again.',
    'host-updating': 'This computer is installing an update. Try again when it finishes.',
    'gh-unreachable': 'Couldn’t read the pull request. Try again.',
    'cert-changed': 'The HTTPS certificate changed. Confirm it in Settings › Computers to reconnect.',
    'cert-error': 'The HTTPS certificate is untrusted or does not match this address. The connection stopped.',
    'cli-link-failed': 'Couldn’t create the command link. Check permissions for ~/.local/bin.',
    'certificate-refused': 'The server could not prove its identity. Latch did not trust the new certificate.',
    'computer-not-found': 'This computer could not be found.',
    'computer-refused': 'Latch cannot add this computer. Check it in Settings › Computers.',
    'computer-switch-failed': 'Couldn’t switch to this computer. Try again.',
    'computers-read-only':
      'The computer list is read-only because its device credentials could not be opened. Check them and reopen Latch.',
    forbidden: 'Latch refused this request.',
    'gesture-required': 'Click the action in Latch and try again.',
    'host-busy': 'Wait for running sessions and pending approvals before restarting Latch.',
    'host-environment': 'The Latch service was started with environment variables. Restart it in the terminal that started it.',
    'host-external': 'Restart the Latch service in the terminal that started it.',
    'host-start-failed': 'The Latch service didn’t start. Check host.log in the data folder.',
    'host-starting': 'The Latch service is starting. Wait and try again.',
    'host-stop-timeout': 'The Latch service did not stop within 60 seconds. It was not restarted.',
    'host-unverified': 'Latch could not verify the running service through host.sock. It was not restarted.',
    'internal-error': 'The request did not finish. Refresh the page and check the current state before trying again.',
    'invalid-input': 'Check the required fields and try again.',
    'invalid-json': 'The request was not valid JSON.',
    'invalid-link': 'No connection link was found. Copy a link in Latch on the other computer, or choose a connection file it created.',
    'item-changed': 'This task changed. Refresh and try again.',
    'login-item-failed': 'Couldn’t change the login item. Check System Settings › General › Login Items.',
    offline: 'This computer could not be reached. Check that it is on and running Latch.',
    outdated: 'Update Latch on the other computer and try again.',
    'post-not-found': 'This post could not be found.',
    'post-page-not-found': 'This page of posts could not be found.',
    'post-query-invalid': 'This discussion position is invalid. Reopen the to-do and try again.',
    'post-reply-not-found': 'This reply could not be found.',
    'simulator-not-booted': 'The simulator is not running.',
    'simulator-control-required': 'Take control of this device in its panel first.',
    'preferences-failed': 'Couldn’t save settings. Try again.',
    'too-many-computers': 'Too many computers are connected. Remove one before adding another.',
    'workspace-invalid': 'This path cannot be added to a project.',
    'workspace-overlap': 'This folder overlaps a folder that cannot be added to a project.',
    'workspace-code-root': 'This folder overlaps the Latch installation and cannot be added to a project.',
    'terminal-open-failed': 'Couldn’t open the terminal. Run this command in your terminal.',
    'workspace-unprintable': 'The folder path contains characters that cannot be displayed. It cannot be added to a project.',
    'worktree-include-if':
      'The repository configuration (.git/config) uses includeIf, so no worktree was created. Move includeIf to your global Git configuration or remove it, then try again.',
    'branches-unreadable': 'Couldn’t read this repository’s branches.',
    'branch-switch-unknown': 'This repository has no such local branch. Nothing was switched.',
    'branch-switch-checked-out': 'This branch is checked out in another worktree. Nothing was switched.',
    'branch-switch-config':
      'The repository sets programs a switch would run (a filter driver or hooks). Nothing was switched. Switch in a terminal.',
    'branch-switch-moved': 'The branch just moved. Nothing was switched. Open the list again and retry.',
    'branch-switch-local-changes':
      'Uncommitted changes would be overwritten by this branch. Nothing was switched. Commit or move them first.',
    'branch-switch-failed': 'Git didn’t finish the switch. The folder is still on its branch.',
    'branch-switch-turn-running': 'A session in this folder is running or waiting for approval. Switch when it finishes.',
    'branch-switch-worktree': 'A worktree’s branch belongs to its session and isn’t switched here.',
    'branch-switching': 'This project folder is switching branches. Try again when it finishes.',
    'preview-unavailable': 'The document preview is unavailable.',
    'app-frame-unavailable': 'The app page runtime is unavailable.',
    'ui-panel-failed': 'Couldn’t read the extension panel. Try again shortly.',
    'untrusted-frame': 'Document previews cannot access the workbench API.',
    'wrong-host': 'This address points to a different computer. The connection stopped.',
  },
)

/**
 * The security class (`isSecurityErrorCode`) that has no entry above, and Host refusals a person meets in daily use:
 * worded here so both languages say what happened and what to do. `pnpm error-copy` fails on a security-class code the
 * Host throws without an entry.
 */
const HOST_REFUSALS: Readonly<Record<string, string>> = defineCopy<Record<string, string>>(
  {
    // Connecting a device and its credential.
    'credential-rotated': '凭据已在另一个页面续期，请刷新。',
    'current-device': '这是正在使用的设备，不能这样移除。',
    'device-not-found': '找不到这台设备。',
    'device-scope-changed': '这台设备的权限刚变了，请重试。',
    'invalid-pairing': '连接方式无效。',
    'invalid-public-key': '设备密钥无效。',
    'invalid-signature': '签名没有通过校验，请重新连接。',
    'invalid-origin': 'Latch 不接受来自其他网站的请求。',
    'pairing-contended': '有两台设备扫了同一个二维码，都已取消。请重新扫码。',
    'pairing-device-unknown': '找不到这次连接的设备，请在设备列表里移除它。',
    'pairing-not-nearby': '手机要和这台 Mac 连同一个 Wi‑Fi。',
    'revocation-not-persisted': '已撤销，但没能写入磁盘。重启 Latch 前请检查数据目录。',
    'native-credential-route': '手机身份不能用浏览器凭据续期。',
    'native-identity-conflict': '手机身份有冲突，请重新配对。',
    'native-identity-invalid': '手机身份无效，请重新配对。',
    'native-identity-required': '手机连接缺少身份，请重新配对。',
    'native-verification-invalid': '验证已过期或无效，请在手机上重新验证。',
    'native-verification-superseded': '这次验证已被更新的一次替换，请在手机上重新验证。',
    // What a device may see and do.
    'agent-work-computer': '请在这个助手的工作电脑上继续。',
    'agent-work-computer-local': '请选择另一台电脑，或清除工作电脑以使用本机。',
    'agent-scope-required': '这台设备不能看全部数据。',
    'file-scope': '这台设备不能浏览项目文件。',
    'history-scope': '接入已有会话需要这台设备能查看全部数据。',
    'invalid-data-scope': '设备能看的范围无效。',
    'invalid-scope': '未知的设备权限。',
    'plugin-package-scope': '这台设备已不能编辑插件。',
    'simulator-scope': '这台设备不能使用模拟器。',
    'terminal-scope': '这台设备不能打开终端。',
    // Confirmation on the Mac, approvals and plugin pages.
    'harness-unconfirmed': '这个 Harness 还没在 Mac 上确认。先在 Mac 上用它开始一个会话。',
    'mcp-unconfirmed': '这个 MCP 服务器还没在 Mac 上确认。',
    'plugin-package-untrusted': '请先在 Mac 上批准插件的代码。',
    'plugin-package-capabilities': '页面要的能力还没在 Mac 上确认。',
    'app-capability-denied': '这个插件页面没有这项能力。',
    'approval-always-unavailable': '高风险操作不能始终允许。',
    'approval-option-hidden': '这个选项会长期保存授权，Latch 不提供。',
    'approval-option-invalid': '这个审批选项不存在。',
    'approval-option-mismatch': '审批选项和决定不一致。',
    'approval-option-required': '请选一个具体的选项。',
    // Outbound addresses and the audit log.
    'egress-full': '允许访问的地址已满（64 个）。请在 设置 › 模型 › 已确认的地址 里移除不用的。',
    'origins-full': '已确认的模型服务地址已满（256 个）。请在 设置 › 模型 › 已确认的地址 里移除不用的。',
    'key-origin-mismatch': '保存的密钥只发往保存时的地址，请重新输入密钥。',
    'audit-unavailable': '没能写入记录，这一步没有执行。请稍后再试。',
    'audit-failed': '没能写入记录，这次调用没有执行。',
    'audit-chain-broken': '记录无法核对，这一步没有执行。请在 Mac 上检查 Latch 的数据目录。',
    'audit-detail-invalid': '记录内容无效，这一步没有执行。',
    // Secrets.
    'agent-export-secret': '定义里有像密钥的内容，没有导出。改掉后再导出。',
    'agent-import-secret': '文件里有像密钥的内容，没有导入。',
    'agent-memory-secret': '内容像密钥，没有记下。',
    'app-import-secret': '草稿里有文件像含有密钥，没有导入。',
    'clone-url-credentials': '地址里带有凭据，没有克隆。请用这台电脑上 Git 自己的登录。',
    'file-secret': '这个文件可能含密钥，只能在 Mac 上确认后显示。',
    'item-secret': '标题像含有密钥，没有保存。',
    'mcp-secret-not-allowed': '这个变量决定加载什么，或它的值像路径或地址。请作为普通变量填写，它会出现在确认里。',
    'note-secret': '备注像含有密钥，没有保存。',
    'post-secret': '发言像含有密钥，没有发出。',
    'proposal-secret': '内容像密钥，没有提出。',
    'tag-secret': '标签像密钥，没有保存。',
    // Daily refusals.
    'workspace-permission': '没有权限访问这个文件夹。请在 系统设置 › 隐私与安全性 里允许 Latch 访问。',
    'workspace-folder-chars': '路径含逗号、* 或 ? 的文件夹只能作为主文件夹。',
    'post-target-busy': '它正在运行，这一轮结束后再发。',
    'budget-exceeded': '本月预算已用完。',
    'harness-busy': 'Harness 正忙，请稍后再试。',
    'task-running': '请等这一轮结束。',
    'queue-full': '排队已满。请删除不需要的旧会话后再试。',
    'queue-order': '请核对最新的队列顺序后重试。',
    'queue-content-changed': '这条排队消息已被编辑。请核对文字后再追加。',
    'queue-steer-unavailable': '这条消息现在无法追加到本轮，请查看队列。',
    'steer-unknown': '追加结果未确认，请核对会话记录。',
    'port-in-use': '端口已被占用，Latch 没有启动。',
    // A session's folder, and an Agent's work folder (its home), which the Host sets up itself.
    'workspace-changed': '这个会话的文件夹已不在项目中或找不到了，不能继续。',
    'helper-home-unavailable': 'Agent 的工作文件夹被改动过（权限、替换或链接），Latch 不会接手它。原文件已保留，请在这台 Mac 上检查。',
    'helper-home-overlap': 'Agent 的工作文件夹与一个项目重叠，请在这台 Mac 上检查项目。',
    'helper-home-moved': 'Agent 的工作文件夹在另一个默认文件夹里，请在它的聊天里重新发送。',
    'agent-chat-move-pending': '旧聊天里还有进行中、排队或结果未核对的消息。处理完再发送。',
    'agent-chat-move-project': '这个 Agent 的聊天要先在它的家里重新开始。这条消息不选项目再发送。',
    // Opening a terminal.
    'terminal-limit': '这里的终端已到上限，请先关掉一个。',
    'terminal-total-limit': '这台电脑上打开的终端太多了，请先关掉不用的。',
    'terminal-folder-unavailable': '文件夹已不可用，不能在这里打开终端。',
    'terminal-personal-session': '这个会话没有项目文件夹，不能打开终端。',
    'terminal-session-archived': '会话已归档，不能打开终端。',
    'terminal-shell-unavailable': '没能启动 shell，终端没有打开。',
    'terminal-start-failed': '终端没有启动，请重试。',
    'terminal-unsupported': '终端尚未实现：目前只支持 macOS。',
    'terminal-unavailable': '终端组件不可用，请重新构建 Latch。',
    'terminal-stopping': 'Latch 正在停止，不能打开终端。',
    'terminal-closed': '终端已关闭。',
    'permission-ask-unavailable': '这条路线不会逐次问你，请从它自己的档位里选。',
  },
  {
    'credential-rotated': 'The credential was renewed in another page. Reload.',
    'current-device': 'This is the device in use, so it cannot be removed this way.',
    'device-not-found': 'This device could not be found.',
    'device-scope-changed': 'This device’s permissions just changed. Try again.',
    'invalid-pairing': 'Invalid connection method.',
    'invalid-public-key': 'The device key is invalid.',
    'invalid-signature': 'The signature did not pass the check. Connect again.',
    'invalid-origin': 'Latch does not accept requests from other sites.',
    'pairing-contended': 'Two devices scanned the same code, so both were cancelled. Scan again.',
    'pairing-device-unknown': 'The device for this connection could not be found. Remove it from the device list.',
    'pairing-not-nearby': 'The phone must be on the same Wi‑Fi as this Mac.',
    'revocation-not-persisted': 'Revoked, but it could not be saved to disk. Check the data folder before restarting Latch.',
    'native-credential-route': 'A phone identity cannot be renewed with a browser credential.',
    'native-identity-conflict': 'The phone identity conflicts. Pair again.',
    'native-identity-invalid': 'The phone identity is invalid. Pair again.',
    'native-identity-required': 'The phone connection has no identity. Pair again.',
    'native-verification-invalid': 'Verification expired or is invalid. Verify again on the phone.',
    'native-verification-superseded': 'A newer verification replaced this one. Verify again on the phone.',
    'agent-work-computer': 'Continue on this assistant’s work computer.',
    'agent-work-computer-local': 'Select another computer, or clear the work computer to use this one.',
    'agent-scope-required': 'This device cannot view all data.',
    'file-scope': 'This device cannot browse project files.',
    'history-scope': 'Adding existing sessions needs a device that can view all data.',
    'invalid-data-scope': 'Invalid device access.',
    'invalid-scope': 'Unknown device permission.',
    'plugin-package-scope': 'This device can no longer edit plugins.',
    'simulator-scope': 'This device cannot use simulators.',
    'terminal-scope': 'This device cannot open the terminal.',
    'harness-unconfirmed': 'This Harness is not confirmed on the Mac yet. Start a session with it on the Mac first.',
    'mcp-unconfirmed': 'This MCP server is not confirmed on the Mac yet.',
    'plugin-package-untrusted': 'Approve the plugin’s code on the Mac first.',
    'plugin-package-capabilities': 'The page’s capabilities are not confirmed on the Mac yet.',
    'app-capability-denied': 'This plugin page does not have this capability.',
    'approval-always-unavailable': 'High-risk actions cannot be always allowed.',
    'approval-option-hidden': 'This option would keep the permission, so Latch does not offer it.',
    'approval-option-invalid': 'This approval option does not exist.',
    'approval-option-mismatch': 'The approval option does not match the decision.',
    'approval-option-required': 'Choose a specific option.',
    'egress-full': 'The allowed addresses are full (64). Remove unused ones in Settings › Models › Confirmed addresses.',
    'origins-full': 'The confirmed model service addresses are full (256). Remove unused ones in Settings › Models › Confirmed addresses.',
    'key-origin-mismatch': 'A saved key is sent only to the address it was saved for. Enter the key again.',
    'audit-unavailable': 'No record could be written, so this was not done. Try again shortly.',
    'audit-failed': 'No record could be written, so this call was not made.',
    'audit-chain-broken': 'The records could not be verified, so this was not done. Check the Latch data folder on the Mac.',
    'audit-detail-invalid': 'The record was invalid, so this was not done.',
    'agent-export-secret': 'The definition contains something that looks like a key, so it was not exported. Change it and export again.',
    'agent-import-secret': 'The file contains something that looks like a key, so it was not imported.',
    'agent-memory-secret': 'It looks like a key, so it was not kept.',
    'app-import-secret': 'A file in the draft looks like it contains a key, so nothing was imported.',
    'clone-url-credentials': 'The address contains credentials, so nothing was cloned. Use Git’s own sign-in on this computer.',
    'file-secret': 'This file may contain keys. It is shown only after confirming on the Mac.',
    'item-secret': 'The title looks like it contains a key, so it was not saved.',
    'mcp-secret-not-allowed':
      'This variable decides what loads, or its value looks like a path or address. Add it as a plain variable; it shows in the confirmation.',
    'note-secret': 'The note looks like it contains a key, so it was not saved.',
    'post-secret': 'The post looks like it contains a key, so it was not sent.',
    'proposal-secret': 'It looks like a key, so it was not proposed.',
    'tag-secret': 'A tag looks like a key, so it was not saved.',
    'workspace-permission': 'Latch has no access to this folder. Allow it in System Settings › Privacy & Security.',
    'workspace-folder-chars': 'A folder whose path contains a comma, * or ? can only be the main folder.',
    'post-target-busy': 'It is running. Send when this turn ends.',
    'budget-exceeded': 'This month’s budget is used up.',
    'harness-busy': 'The Harness is busy. Try again shortly.',
    'task-running': 'Wait for this turn to end.',
    'queue-full': 'The queue is full. Delete old sessions you no longer need, then try again.',
    'queue-order': 'Check the current queue order, then try again.',
    'queue-content-changed': 'This queued message was edited. Review its text before adding it to the turn.',
    'queue-steer-unavailable': 'This message cannot be added to the current turn. Check the queue.',
    'steer-unknown': 'Delivery to the current turn is unconfirmed. Check the conversation.',
    'port-in-use': 'The port is in use, so Latch did not start.',
    'workspace-changed': 'This session’s folder is no longer in the project or cannot be found, so it cannot continue.',
    'helper-home-unavailable':
      'The Agent’s work folder was changed (permissions, replaced or a link), so Latch will not take it over. The files are kept; check it on this Mac.',
    'helper-home-overlap': 'The Agent’s work folder overlaps a project. Check the projects on this Mac.',
    'helper-home-moved': 'The Agent’s work folder is in another default folder. Send the message again in its chat.',
    'agent-chat-move-pending':
      'The old chat still has a turn under way, a queued message or an unchecked result. Deal with it, then send again.',
    'agent-chat-move-project': 'This Agent’s chat restarts in its home first. Send this message without a project.',
    'terminal-limit': 'This has reached its terminal limit. Close one first.',
    'terminal-total-limit': 'Too many terminals are open on this computer. Close ones you don’t use.',
    'terminal-folder-unavailable': 'The folder is no longer available, so the terminal cannot open here.',
    'terminal-personal-session': 'This session has no project folder, so the terminal cannot open.',
    'terminal-session-archived': 'This session is archived, so the terminal cannot open.',
    'terminal-shell-unavailable': 'The shell did not start, so the terminal did not open.',
    'terminal-start-failed': 'The terminal did not start. Try again.',
    'terminal-unsupported': 'Terminal is not implemented yet: only macOS is supported.',
    'terminal-unavailable': 'The terminal component is unavailable. Rebuild Latch.',
    'terminal-stopping': 'Latch is stopping, so the terminal cannot open.',
    'terminal-closed': 'The terminal is closed.',
    'permission-ask-unavailable': 'This route never asks before each action. Pick one of its own modes.',
  },
)

const FIXED_SHARED: Record<string, () => string> = {
  'history-session-busy': () => HISTORY_COPY.busy,
  'file-image-dimensions': () => fileNote('file-image-dimensions').text,
  'credential-expired': () => ENROLLMENT_REASON_TEXT['credential-expired']!,
  'device-revoked': () => ENROLLMENT_REASON_TEXT['device-revoked']!,
  'listener-mismatch': () => ENROLLMENT_REASON_TEXT['listener-mismatch']!,
  'local-only': () => NOTICE_COPY.localOnly,
  'presence-busy': () => CONFIRMATION_COPY.busy,
  'presence-blocked': () => CONFIRMATION_COPY.blocked,
  'confirmation-denied': () => CONFIRMATION_RESULT_TEXT.denied,
  'confirmation-expired': () => CONFIRMATION_RESULT_TEXT.expired,
  'confirmation-cancelled': () => CONFIRMATION_RESULT_TEXT.cancelled,
  'confirmation-failed': () => CONFIRMATION_RESULT_TEXT.error,
  'permission-drift': () => SESSION_STOP_TEXT['permission-drift'],
  'permission-unverified': () => SESSION_STOP_TEXT['permission-unverified'],
  'agent-definition-changed': () => SESSION_STOP_TEXT['agent-definition-changed'],
  'project-config-changed': () => SESSION_STOP_TEXT['project-config-changed'],
  'l3-confirmation-missing': () => SESSION_STOP_TEXT['l3-confirmation-missing'],
}

const fixedText = (code: string): string | undefined =>
  Object.hasOwn(FIXED_SHARED, code) ? FIXED_SHARED[code]!() : Object.hasOwn(FIXED, code) ? FIXED[code] : undefined

const FAILURE_COPY = defineCopy(
  {
    attachmentClaimed: '附件已保留给另一条提交。请重试原提交，或移除附件后重新添加。',
    attachmentSecret: '附件可能包含密钥。请检查内容，并明确确认后再添加。',
    fileReferenceRefused: '引用文件已不存在、不在当前会话文件夹内，或可能包含密钥。请重新选择。',
    attachmentPublishUnknown: '会话已开始，附件记录尚未确认。请重试同一次提交。',
    stepupRequired: '需要在 Mac 上确认',
    cooldown: (minutes: number) => `连续取消了 3 次，请 ${minutes} 分钟后再试`,
    egressDenied: (target?: string) =>
      `Latch 不会访问${target === undefined ? '这个地址' : ` ${target}`}：这是这台 Mac、局域网或云元数据地址。这台 Mac 和局域网上的地址要在 Mac 上确认后才能使用。`,
    rateLimited: '请求过于频繁，请稍后再试',
    rateLimitedWait: (seconds: number) => `请求过于频繁，请 ${seconds} 秒后再试。`,
    /** What a device cannot do, by the scope it lacks. */
    scopeRefusals: {
      view: '这台设备不能查看',
      run: '这台设备不能发送消息',
      'approve:standard': '这台设备不能允许这一步',
      'approve:elevated': '这台设备不能允许这一步',
      admin: '这台设备不能改设置',
      secrets: '这台设备不能改密钥',
    } satisfies Record<DeviceScope, string>,
    scopeRefusalOther: '这台设备不能这样做',
    /** Prefix families in the catalog; an unlisted member still never shows server text. */
    presenceFamily: '这台 Mac 暂时不能确认，请稍后重试',
    enrollmentFamily: '连接未完成，请重新提交',
    invitationFamily: '配对码无效或已过期',
    /** A result that may be unknown, by the Host's code or else the HTTP status. */
    unknown: (label?: string | number) => (label === undefined ? '请求未完成，请重试。' : `请求未完成（${label}），请重试。`),
    /** A definite refusal without words of its own: trying again would not help. */
    refused: (code?: string) => (code === undefined ? '没有完成。' : `没有完成（${code}）。`),
  } as const,
  {
    attachmentClaimed: 'The attachment is held for another submission. Retry that submission, or remove the attachment and add it again.',
    attachmentSecret: 'The attachment may contain keys. Check its content and confirm explicitly before adding it.',
    fileReferenceRefused: 'The referenced file no longer exists, is outside this session’s folders, or may contain keys. Choose it again.',
    attachmentPublishUnknown: 'The session started, but the attachment record is not confirmed yet. Retry the same submission.',
    stepupRequired: 'Needs confirming on the Mac',
    cooldown: (minutes: number) =>
      plural(minutes, {
        one: 'Cancelled 3 times in a row. Try again in {n} minute',
        other: 'Cancelled 3 times in a row. Try again in {n} minutes',
      }),
    egressDenied: (target?: string) =>
      `Latch will not reach ${target === undefined ? 'this address' : target}: it is an address on this Mac, the local network or a cloud metadata service. Addresses on this Mac and the local network can be used only after they are confirmed on the Mac.`,
    rateLimited: 'Too many requests. Try again shortly',
    rateLimitedWait: (seconds: number) =>
      plural(seconds, { one: 'Too many requests. Try again in {n} second.', other: 'Too many requests. Try again in {n} seconds.' }),
    scopeRefusals: {
      view: 'This device cannot view this',
      run: 'This device cannot send messages',
      'approve:standard': 'This device cannot allow this step',
      'approve:elevated': 'This device cannot allow this step',
      admin: 'This device cannot change settings',
      secrets: 'This device cannot change keys',
    },
    scopeRefusalOther: 'This device cannot do this',
    presenceFamily: 'This Mac cannot confirm right now. Try again shortly',
    enrollmentFamily: 'The connection did not finish. Send it again',
    invitationFamily: 'The pairing code is invalid or has expired',
    unknown: (label?: string | number) =>
      label === undefined ? 'The request did not finish. Try again.' : `The request did not finish (${label}). Try again.`,
    refused: (code?: string) => (code === undefined ? 'Not done.' : `Not done (${code}).`),
  },
)

/** Prefix families in the catalog; an unlisted member still never shows server text. */
const FAMILY_FALLBACK: Array<[prefix: string, text: () => string]> = [
  ['presence-', () => FAILURE_COPY.presenceFamily],
  ['confirmation-', () => CONFIRMATION_RESULT_TEXT.error],
  ['enrollment-', () => FAILURE_COPY.enrollmentFamily],
  ['invitation-', () => FAILURE_COPY.invitationFamily],
]

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/

/** `host:port` (IPv6 in brackets) without control or bidirectional characters, ≤ 260 chars. */
export function safeTarget(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 260 || UNSAFE_TEXT.test(value)) return
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value)
  if (!match || Number(match[2]) > 65_535) return
  return value
}

/** A user-chosen device name shown in approval receipts; refused when the security-text rule would have to escape it. */
export function safeDeviceName(value: unknown): string | undefined {
  return typeof value === 'string' && isAcceptableDeviceName(value) ? value.trim() : undefined
}

const scopeRefusal = (scope: unknown) =>
  typeof scope === 'string' && Object.hasOwn(FAILURE_COPY.scopeRefusals, scope)
    ? FAILURE_COPY.scopeRefusals[scope as DeviceScope]
    : FAILURE_COPY.scopeRefusalOther
const seconds = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined)

/** True when the code's text comes from the catalog rather than the Host. */
export function isCatalogCode(code: string): boolean {
  return (
    Object.hasOwn(FIXED, code)
    || Object.hasOwn(EXTRA_FAILURES, code)
    || Object.hasOwn(HOST_REFUSALS, code)
    || Object.hasOwn(FIXED_SHARED, code)
    || code === 'scope-required'
    || code === 'stepup-required'
    || code === 'presence-cooldown'
    || code === 'egress-denied'
    || code === 'rate-limited'
    || code === 'attachment-claimed'
    || code === 'attachment-secret'
    || code === 'file-reference-refused'
    || code === 'attachment-publish-unknown'
    || FAMILY_FALLBACK.some(([prefix]) => code.startsWith(prefix))
  )
}

/** Where a failure's words come from when the catalog has none for its code. */
export interface FailureWords {
  /** This page's own words for the case, in the page's language; used before anything from the Host. */
  fallback?: string
  /** The Host's own `message` (`ApiFailure.message`): shown only in Chinese, only outside the security class. */
  host?: string
}

/** The longest Host reason shown, in code points; longer ones end in `…`. */
export const HOST_TEXT_MAX = 200
const SHOWN_CODE = /^[A-Za-z0-9_-]{1,64}$/u

/**
 * The Host's reason as the page may show it: the Host sends `message` as it is (its log redaction does not apply to
 * error bodies), so text that looks like a credential is dropped, invisible and direction characters are made visible,
 * and it is capped.
 */
function hostReason(message: string | undefined): string | undefined {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text || looksSecret(text)) return undefined
  const points = [...escapeSecurityText(text)]
  return points.length > HOST_TEXT_MAX ? `${points.slice(0, HOST_TEXT_MAX - 1).join('')}…` : points.join('')
}

/**
 * The text a page shows for a Host or shell error: the catalog for a known code; otherwise the caller's `fallback`; then,
 * in Chinese and outside the security class, the Host's reason; else a generic sentence. A definite refusal (a 4xx but
 * 408, a 5xx in `NOT_ACCEPTED_5XX`, or a shell's answer with no status) says it was not done, with the code, and does
 * not suggest trying again; a result that may be unknown keeps 「请重试」.
 */
export function describeFailure(status: number, code: string, words: FailureWords = {}, details: Partial<ApiFailure> = {}): string {
  switch (code) {
    case 'attachment-claimed':
      return FAILURE_COPY.attachmentClaimed
    case 'attachment-secret':
      return FAILURE_COPY.attachmentSecret
    case 'file-reference-refused':
      return FAILURE_COPY.fileReferenceRefused
    case 'attachment-publish-unknown':
      return FAILURE_COPY.attachmentPublishUnknown
    case 'scope-required':
      return scopeRefusal(details.required)
    case 'stepup-required':
      return FAILURE_COPY.stepupRequired
    case 'presence-cooldown': {
      const wait = seconds(details.retryAfter)
      return FAILURE_COPY.cooldown(wait === undefined ? 5 : Math.max(1, Math.ceil(wait / 60)))
    }
    case 'egress-denied':
      return FAILURE_COPY.egressDenied(safeTarget(details.target))
    case 'rate-limited': {
      const wait = seconds(details.retryAfter)
      return wait === undefined ? FAILURE_COPY.rateLimited : FAILURE_COPY.rateLimitedWait(wait)
    }
  }
  const fixed = fixedText(code)
  if (fixed !== undefined) return fixed
  const family = FAMILY_FALLBACK.find(([prefix]) => code.startsWith(prefix))
  if (family) return family[1]()
  if (Object.hasOwn(EXTRA_FAILURES, code)) return EXTRA_FAILURES[code]!
  if (Object.hasOwn(HOST_REFUSALS, code)) return HOST_REFUSALS[code]!
  if (words.fallback) return words.fallback
  const reason = isSecurityErrorCode(code) || currentLocale() !== 'zh-CN' ? undefined : hostReason(words.host)
  if (reason !== undefined) return reason
  const shown = code !== 'request-failed' && SHOWN_CODE.test(code) ? code : undefined
  if (status <= 0 || refusedBeforeAccepting(status, code)) return FAILURE_COPY.refused(shown)
  return FAILURE_COPY.unknown(shown ?? status)
}
