import {
  escapeSecurityText,
  isAcceptableDeviceName,
  RISK_REASON_TEXT,
  SCOPE_LABELS,
  type ApiFailure,
  type ApprovalOptionKind,
  type ApprovalRiskReason,
  type DeviceScope,
  type PresenceAction,
} from '@latch/protocol'

/**
 * Security-related text comes from this catalog, chosen by the Host's error code; the Host's free-text `message` is never
 * shown for these codes. The only values substituted in are a wait time and a validated `host:port` target. Codes
 * outside the catalog keep the Host's message, which React renders as plain text. Its words are the glossary's
 * (`scripts/glossary.ts`).
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

export const ENROLLMENT_REASON_TEXT: Partial<Record<EnrollmentReason, string>> = {
  'device-revoked': '这台设备已被移除。要继续使用，请重新连接。',
  'credential-expired': '这台设备已连接满 30 天，请重新连接。',
  'listener-mismatch': '这台设备的凭据属于另一个访问地址，请重新连接。',
  'key-missing': '这个浏览器丢失了设备密钥，请重新连接。',
  'credential-not-stored': '已经连上，但这个浏览器没有保存设备凭据（可能禁止了 Cookie）。请允许此网站保存 Cookie 后重新连接。',
  'renewal-not-stored':
    '设备凭据已续期，但这个浏览器没有保存新的凭据（可能禁止了 Cookie）。请允许此网站保存 Cookie 后重新加载页面；仍连不上时再重新连接。',
}

/** A change that reduced permissions applied while its record could not be written (`x-latch-audit: failed`). */
export const AUDIT_NOT_RECORDED_TEXT = '改动已生效，但没有写入记录'
const LOCAL_ONLY_TEXT = '只能在 Mac 上的 Latch 里操作'

/** A fact as the UI shows it: a short label always, and the fine print one press away (`Hint`), if any. */
export interface Brief {
  label: string
  detail?: string
  /** A Harness's mark to lead the label, where the fact is about that Harness. */
  mark?: string
}

/**
 * The computer a go-there sentence sends a person on another device to: its own name (`snapshot.hostName`), or 「Mac」
 * where the page does not know it (the connection page, an older Host) or the name would need escaping. The Latch app on
 * that computer says 「这台 Mac」 instead (`computerLabel`).
 */
export function computerName(hostName?: string): string {
  return typeof hostName === 'string' && isAcceptableDeviceName(hostName) ? hostName.trim() : 'Mac'
}

/** 「这台 Mac」 in the Latch app on the Host's computer (`DeviceAccess.local`), the computer's name everywhere else. */
export const computerLabel = (local: boolean, hostName?: string): string => (local ? '这台 Mac' : computerName(hostName))

/**
 * Restrictions and consequences shown while choosing or adding an agent, project or model service. Each `…Elsewhere`
 * line is read on another device and names the computer (`computerName`).
 */
export const SETUP_COPY = {
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
  externalNote: { label: '外部 Harness，Latch 不隔离', detail: '用它开始的会话由它自己决定执行范围。' } satisfies Brief,
  /** 设置 › 项目, a project's folders for each Harness. */
  externalFolders: {
    label: '由各 Harness 自己执行，不隔离',
    detail: '外部 Harness 的文件夹范围由它自己执行，Latch 不隔离它。',
  } satisfies Brief,
} as const

/**
 * Approvals: the words of each kind of request, the drawer's lines, and the reasons that replace an allow button this
 * device does not get.
 */
export const APPROVAL_COPY = {
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
  retry: '重试',
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
} as const

/**
 * How a decided approval reads on its tool row, and its tooltip. A person's choice says when; an answer nobody gave (a
 * time limit, the session stopping) is never worded as anyone's choice. Where a person decided is told without a device
 * name. None of it says the call did not run: only the built-in harness holds a call back, and an agent's ask is
 * advisory, so a call the agent reports as started keeps its own state with `ranDespite` beside the record.
 */
export const DECISION_COPY = {
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
} as const

/**
 * The high-risk pill: 高风险 with the Host's reason (「高风险 · Latch 程序目录内」), or alone when there is none or the code
 * is not one this page knows. The words come from @latch/protocol, the same the system sheet uses.
 */
export function highRiskLabel(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(RISK_REASON_TEXT, reason)
    ? `${APPROVAL_COPY.highRisk} · ${RISK_REASON_TEXT[reason as ApprovalRiskReason]}`
    : APPROVAL_COPY.highRisk
}

/** A risky request's reason on its own line; the words come from @latch/protocol, the same the system sheet uses. */
export function RISK_CLAUSE(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(RISK_REASON_TEXT, reason)
    ? RISK_REASON_TEXT[reason as ApprovalRiskReason]
    : APPROVAL_COPY.highRisk
}

/**
 * The words of an agent's options, by their kind: an agent names its options in its own language (「Reject」), and
 * the card shows the product's words, with the agent's own in the tooltip. 本会话始终允许 only reaches a card from
 * the built-in harness.
 */
export const APPROVAL_OPTION_LABELS: Record<ApprovalOptionKind, string> = {
  reject_once: '拒绝',
  allow_once: '允许一次',
  reject_always: '始终拒绝',
  allow_always: '本会话始终允许',
}

/**
 * The local confirmation has no window of Latch's own: the button that asked shows pending and the system sheet is the
 * only UI. These are the lines left for a screen reader and for a confirmation that could not start.
 */
export const CONFIRMATION_COPY = {
  label: '在 Mac 上确认',
  /** Either window: the helper's Touch ID sheet, or the desktop's own 取消/允许 sheet. */
  waiting: '在系统窗口中确认',
  waitingTouchId: '等待 Touch ID',
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
} as const

/** The confirmations a refusal may name; anything else is dropped from the details (`core/blocking.ts`). */
export const BLOCKED_VERBS: Record<'device.enroll' | 'device.grant' | 'policy.change' | 'provider.confirm-origin', string> = {
  'device.enroll': '配对新设备',
  'device.grant': '为设备增加权限',
  'policy.change': '放宽设置',
  'provider.confirm-origin': '确认模型服务地址',
}

/** What the request does once the confirmation passes, for 「已确认，正在…」. */
export const CONFIRMATION_VERBS: Record<PresenceAction, string> = {
  'plugin.package.apply': '应用插件',
  'device.enroll-native': '配对手机',
  'device.enroll': '连接设备',
  'device.grant': '更新权限',
  'policy.change': '更新设置',
  'provider.confirm-origin': '保存',
  'mcp.server.apply': '保存',
  'harness.command.apply': '保存',
}

/** What a confirmation held back by a running agent was for, in 「…，结束后才能放宽设置。」. */
export const BLOCKED_ACTION_TEXT: Record<PresenceAction, string> = {
  'plugin.package.apply': '应用自定义插件',
  'device.enroll-native': '配对手机',
  'device.enroll': '配对新设备',
  'device.grant': '为设备增加权限',
  'policy.change': '放宽设置',
  'provider.confirm-origin': '确认模型服务地址',
  'mcp.server.apply': '添加 MCP 服务器',
  'harness.command.apply': '确认 Harness 命令',
}

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
export const BLOCKED_COPY = {
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
} as const

/**
 * Why a confirmation ended without the request running; the place that asked shows it and the caller gets it as the
 * error. A denial covers every way the confirmation did not pass: 取消 in the system sheet, a failed Touch ID or password,
 * or the system cancelling it.
 */
export const CONFIRMATION_RESULT_TEXT = {
  denied: '没有执行：确认没有通过。',
  expired: '没有执行：2 分钟内没有确认。',
  cancelled: '没有执行：确认已取消。',
  error: '没有执行：确认没有完成，请重试。',
  /** Touch ID locked after too many failed tries: the next confirmation takes the login password, which unlocks it. */
  lockout: '没有执行：Touch ID 已锁定。再试一次时用这台 Mac 的登录密码确认，Touch ID 也会随之恢复。',
} as const

/** Whole minutes and seconds of a wait, 「4:05」. */
export function waitText(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** The enrollment page. */
export const ENROLLMENT_COPY = {
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
    `Mac 现在不能确认：${reason || '未知原因'}。停止 Latch 服务后，在 Mac 上运行 pnpm latch device enroll --offline，把生成的离线连接码填在下面。`,
  /** The same, where the Host takes no offline code (every listener but host.sock): nothing here can be submitted yet. */
  unavailableRemote: (reason: string) => `Mac 现在不能确认：${reason || '未知原因'}。要等它能确认后才能连接。`,
  invitationRequired: '这台设备还没连接到 Latch。用运行 Latch 的人发来的链接打开这一页，就能连接。',
  /** A browser on loopback is not this computer either: the desktop app makes its link, or the command line where there is none. */
  browserNotConnected: '这个浏览器还没连接到 Latch。在 Mac 上的 Latch 里点「在浏览器中打开」，或在终端运行：',
  browserLinkCommand: 'pnpm latch device invite --loopback',
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
} as const

/**
 * 连接详情, folded on the connecting device and in the Mac's pairing panel. The system sheet shows only the name a device
 * gave itself, so the code is the way left to tell this device from another holding the same link.
 */
export const CONNECTION_DETAILS_COPY = {
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
  dataText: { all: '全部会话', work: '会话，不含私有内容' },
} as const

/** What a device may do once connected, in the words of a person deciding about it. */
export const GRANTED_TEXT: Record<DeviceScope, string> = {
  view: '查看会话',
  run: '开始和继续会话',
  'approve:standard': '批准普通操作',
  'approve:elevated': '批准高风险操作',
  admin: '管理这台 Mac（模型服务、插件、项目和设备）',
  secrets: '设置密钥',
}

/** The Mac's list of devices asking to connect. */
export const WAITING_DEVICES_COPY = {
  asking: '想连接这台 Mac',
  approved: '已允许，等它完成连接…',
  confirm: '在系统窗口中确认',
  canManage: '它还可以管理这台 Mac',
} as const

/** Under the settings sections of a device that cannot change them: why the others are not listed, and where they are. */
export const SETTINGS_ADMIN_HIDDEN = (computer = 'Mac') => `其他设置在 ${computer} 上的 Latch 里`

/** This Mac cannot confirm anything now, in the Host's words when it gave some. */
export const presenceUnavailableText = (message: string | undefined) =>
  message ? `这台 Mac 暂时不能确认：${message}` : '这台 Mac 暂时不能确认，需要它确认的操作都不能进行。'

/** 设置 › 设备: the devices that use this Mac. It names no address, relay or scope; a waiting device's code is folded. */
export const DEVICES_COPY = {
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
  /** A browser connected this way has `dataScope: 'work'` until 「可以看项目文件」 is turned on. */
  thisBrowserNote: '默认看不到项目文件',
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
  /** `dataScope: 'all'`: more than files (private sessions too), so the line does not promise less than it opens. */
  files: '可以看项目文件',
  filesNote: {
    label: '也能看含私有内容的会话',
    detail: '能看项目里的文件和每个会话的改动，能在消息里 @ 文件；能开始会话的设备还能撤销、重做或丢弃某一轮的改动。',
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
  aboutPhone: { label: '首次连接手机要在同一 Wi‑Fi，连接端到端加密' } satisfies Brief,
  savedRelay: '已保存的中继',
  savedDirectory: '已保存的地址目录',
  browser: '在浏览器中打开',
  browserOpened: '已在浏览器中打开。在那里点「连接这个浏览器」后，这台 Mac 会请你确认。',
} as const

/** The pairing sheet, one state per sentence. */
export const NATIVE_LINK_COPY = {
  title: '连接手机',
  enable: '连接手机',
  scan: '用 iPhone 上的 Latch 扫码',
  sameWifi: '和这台 Mac 连同一个 Wi‑Fi',
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
  offNetwork: '有设备从其他网络尝试连接，已拒绝。',
  noNetwork: '这台 Mac 没有连接 Wi‑Fi 或有线网络。',
  connectedBefore: '已连接「',
  closingQuote: '」',
  ask: '手机上显示已连接了吗？',
  yes: '是的，完成',
  no: '没有，移除',
  removedBefore: '已移除「',
  removeFailed: '没能移除。请在设备列表里移除它。',
  done: '好',
  retry: '重试',
} as const

/**
 * A folder inside Latch's program directory: every write by the built-in agent needs an answer on this Mac and other
 * agents cannot start there. The start directory comes from the start options, so the way out is a project.
 */
export const CODE_ROOT_COPY = {
  badge: '程序目录内',
  notice: '在程序目录里，每次写入都问你',
  startDir: 'Latch 启动时的文件夹',
  newProject: '添加项目…',
} as const

/** File chips in replies: copying a path, and the desktop app's menu of what is allowed for that file. */
export const FILE_COPY = {
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
} as const

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

const revealWords = (platform: string | undefined) =>
  platform === 'darwin' ? '在访达中显示' : platform === 'win32' ? '在资源管理器中显示' : '在文件管理器中显示'
const extensionOf = (name: string | undefined) => {
  const dot = name?.lastIndexOf('.') ?? -1
  return name && dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
const WEB_TYPES = new Set(['html', 'htm', 'xhtml', 'svg', 'webarchive'])
const MACRO_TYPES = new Set(['doc', 'xls', 'ppt', 'docm', 'xlsm', 'pptm', 'potm', 'ppsm', 'rtf'])

/** Why Latch does not open a type, with the way left to the reader. */
function typeRefusal({ name, platform }: FileNoteContext): string {
  const ext = extensionOf(name)
  const reveal = revealWords(platform)
  if (WEB_TYPES.has(ext)) return `网页和 SVG 用浏览器打开时可以联网；可以${reveal}后自己打开。`
  if (MACRO_TYPES.has(ext)) return `这种 Office 文件可以带宏或嵌入的对象；可以${reveal}后自己打开。`
  return `Latch 只直接打开常见的文档、图片和音视频，不打开程序、脚本或没有扩展名的文件；可以${reveal}后自己决定。`
}

/** The note for each code the Host or the shell gave; anything else is a plain failure. */
const FILE_NOTES: Record<string, (context: FileNoteContext) => FileNote> = {
  'file-outside-folders': ({ platform }) => ({
    text: '不在会话的文件夹里',
    detail: `Latch 不替你打开它。${platform === 'darwin' ? '复制路径后，可以在访达中按 ⇧⌘G 前往。' : '复制路径后，可以在文件管理器中前往。'}`,
    tone: 'lock',
  }),
  'file-folder-removed': () => ({
    text: '文件夹已不在项目里',
    detail: 'Latch 不再替你打开这个会话文件夹中的文件。',
    tone: 'lock',
  }),
  'file-protected': () => ({ text: '这是 Latch 的私有数据。', tone: 'lock' }),
  'file-secret': () => ({ text: '这个文件可能含密钥，不提供快速查看和打开。', tone: 'lock' }),
  'file-type-refused': context => ({ text: 'Latch 不直接打开', detail: typeRefusal(context), tone: 'lock' }),
  'file-preview-unverified': () => ({
    text: '暂不快速查看这种文件',
    detail: '还没有确认系统的预览不会加载文件里引用的网络资源。',
    tone: 'lock',
  }),
  'file-content-mismatch': () => ({ text: '文件内容与扩展名不符，Latch 不直接打开它。', tone: 'lock' }),
  'file-not-text': () => ({ text: '这不是文本文件，不用编辑器打开。', tone: 'lock' }),
  'no-editor': () => ({ text: '这台 Mac 上没有找到支持的编辑器。', tone: 'info' }),
  'gesture-required': () => ({ text: '请在页面上点按后再试。', tone: 'info' }),
  'file-scope': () => ({ text: '这台设备不能打开会话文件夹中的文件。', tone: 'lock' }),
  'local-only': () => ({ text: LOCAL_ONLY_TEXT, tone: 'lock' }),
  'file-folder': ({ platform }) => ({ text: `这是文件夹；Latch 只${revealWords(platform)}项目的文件夹。`, tone: 'info' }),
  'file-not-regular': () => ({ text: '这不是普通文件。', tone: 'info' }),
  'file-unreadable': () => ({ text: 'Latch 没有读取这个文件的权限。', tone: 'info' }),
  unsupported: () => ({ text: '这台 Mac 上还不能这样打开文件。', tone: 'info' }),
  'host-outdated': () => ({ text: '重新启动 Latch 后可以在这里打开文件。', tone: 'info' }),
  'file-missing': () => ({ text: '找不到这个文件。', tone: 'alert' }),
  'file-invalid': () => ({ text: '这不是有效的文件路径。', tone: 'alert' }),
  'file-changed': () => ({ text: '文件刚刚发生了变化，请重试。', tone: 'alert' }),
  'file-handle-expired': () => ({ text: '文件已不可用，请重新打开。', tone: 'alert' }),
  'file-image-dimensions': () => ({ text: '无法确认图片尺寸，已停止解码。可以下载文件后查看。', tone: 'alert' }),
  'file-handle-foreign': () => ({ text: '文件已不可用，请重新打开。', tone: 'alert' }),
  'open-failed': () => ({ text: '没有找到能打开这个文件的应用。', tone: 'alert' }),
  'task-not-found': () => ({ text: '找不到这个会话。', tone: 'alert' }),
  'audit-unavailable': () => ({ text: '没有写入记录，操作没有执行。', tone: 'alert' }),
  'rate-limited': () => ({ text: '操作太频繁，请稍后再试。', tone: 'alert' }),
  busy: () => ({ text: FILE_COPY.busy, tone: 'alert' }),
}

/** The note a file menu shows for a code; the Host's words are never shown. */
export function fileNote(code: string, context: FileNoteContext = {}): FileNote {
  return Object.hasOwn(FILE_NOTES, code) ? FILE_NOTES[code]!(context) : { text: '没有完成，请重试。', tone: 'alert' }
}

/** The note as one sentence, where there is no ⓘ to hold its detail (a preview's error). */
export function fileRefusalText(code: string, context: FileNoteContext = {}): string {
  const { text, detail } = fileNote(code, context)
  return detail ? `${text}：${detail}` : text
}

/**
 * Where a plugin's parts run and who receives them, for the plugin form. Plain facts rather than a warning: a page module
 * is delivered to every device that may view sessions and runs with that page's rights; nothing isolates it.
 */
export const PLUGIN_REACH_COPY = {
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
} as const

/**
 * Model services: where keys are typed and how an address becomes usable. Keys are typed only in the Latch app on this
 * Mac; a known service's HTTPS address and an address confirmed once take a key directly; any other address is confirmed
 * once (Touch ID or the login password), together with its key. Every restricted control says why and where to go.
 */
export const PROVIDER_COPY = {
  keyHeld: { label: '只存在这台 Mac 上', detail: '密钥不会发给浏览器或手机。' } satisfies Brief,
  /** Other devices: the key field becomes this line. */
  keyElsewhere: (computer = 'Mac') => `在 ${computer} 上的 Latch 里填写`,
  /** Without Touch ID or a password to confirm with, for an address not confirmed yet: the key goes in with the address. */
  keyOffline: (id: string) => `地址确认之前不能在这里填写密钥：退出 Latch 后运行 pnpm latch provider set-key ${id}，密钥与地址一起确认。`,
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
  localNoteAtSave: (target: string): Brief => ({ label: '这台 Mac 或局域网地址，保存时确认', detail: `确认后 Latch 才会访问 ${target}。` }),
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
    `这台电脑不能用 Touch ID 或登录密码确认。退出 Latch 后运行 pnpm latch provider confirm ${id}（或用 set-key 同时保存密钥），再启动 Latch。`,
  confirmOfflineNew: '这台电脑不能用 Touch ID 或登录密码确认。先不填密钥保存，再退出 Latch，运行 pnpm latch provider confirm <服务 ID>。',
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
} as const

/** 设置 › 关于 and 设置 › Harness: who the code runs as. `on` is 「这台 Mac 上」 or 「 <name> 上」. */
export const RUNS_AS_YOU_COPY = {
  about: (on: string): Brief => ({ label: 'Harness 和插件以你的权限运行', detail: `它们在${on}运行，Latch 不隔离它们。` }),
  engines: (on: string): Brief => ({
    label: 'Harness 以你的权限运行',
    detail: `Harness 是${on}已安装的程序。Latch 不会替你安装它们，也不隔离它们。`,
  }),
  /** Beside the 开发版 mark, which says it only on hover: what a development run means for whoever reads it. */
  devMode: { label: '其他程序可以修改 Latch 的代码' } satisfies Brief,
} as const

/** Why a session no longer accepts input, as an error elsewhere (`describeFailure`). */
export const SESSION_STOP_TEXT = {
  'permission-drift': '这个 Harness 的设置变了，为了安全换个新会话继续',
  'agent-definition-changed': '这个 Harness 的设置变了，为了安全换个新会话继续',
  'project-config-changed': '项目里的 Harness 配置变了，为了安全换个新会话继续',
  'l3-confirmation-missing': '这个会话缺少启动记录，不能继续。换个新会话继续',
  'permission-unverified': '确认不了 Harness 的权限，这一轮没有发送',
  'harness-session-lost': '这个 Harness 已找不到原来的会话，换个新会话继续',
} as const
export const DOCUMENT_PREVIEW_ERRORS = {
  'document-too-complex': '这份演示文稿的内容过于复杂，暂时无法预览。可以下载或在电脑上打开。',
  'zip-refused': '文档压缩结构超出预览上限，可以下载或在电脑上打开。',
  fallback: '无法显示这个文档，请下载或在 Mac 上打开。',
} as const
export type SessionStopCode = keyof typeof SESSION_STOP_TEXT
/** The same as the line above the input: a few words beside the shield, with 「在新会话中继续」 after them. */
export const SESSION_STOP_LABEL: Record<SessionStopCode, string> = {
  'permission-drift': 'Harness 的设置变了',
  'agent-definition-changed': 'Harness 的设置变了',
  'project-config-changed': '项目的 Harness 配置变了',
  'l3-confirmation-missing': '会话缺少启动记录',
  'permission-unverified': '没能确认权限，这一轮没发送',
  'harness-session-lost': 'Harness 找不到原来的会话了',
}
/** The same stop after a mode change, where no message was on its way. */
export const CONFIG_UNVERIFIED_TEXT = '没能确认权限已经切换'
export const isSessionStopCode = (code: string): code is SessionStopCode => code in SESSION_STOP_TEXT
/** A mode that could not be read back this once: nothing went out, the session may read true on the next try. */
export const stopLocksInput = (code: SessionStopCode) => code !== 'permission-unverified'

/** Disabled controls: the hover reason, for a control the Mac alone can change. */
export const HOVER_REASONS = {
  onMac: (computer = 'Mac') => `在 ${computer} 上的 Latch 里操作`,
  confirmOnMac: (computer = 'Mac') => `在 ${computer} 上确认`,
  macOnly: '只能在这台 Mac 上改',
  openInLatch: '在 Latch 中打开',
  noView: '这台设备不能查看',
} as const

/** The composer's 权限 chip and its rows with the agent as subject. */
export const MODE_COPY = {
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
  afterStart: '开始后可以选',
  /** A Harness whose lists can be read before a session: the read reports its modes too. */
  afterRead: '读取后可以选',
  reading: '正在读取…',
  /** Under the current row before start: the rows Latch can set are the ones the agent's session offers. */
  changeAfterStart: (agent: string): Brief => ({ label: '发第一条消息后可以换', detail: `${agent} 开始会话时才给出其他几项。` }),
  /** The same, for a Harness whose read reports them before any session. */
  changeAfterRead: (agent: string): Brief => ({ label: `读取 ${agent} 的权限后可以换` }),
  modesReading: (agent: string): Brief => ({ label: `正在读取 ${agent} 的权限…` }),
  modesUnread: (agent: string): Brief => ({ label: `没有读到 ${agent} 的权限`, detail: '发第一条消息后可以换。' }),
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
  more: '更多',
  fewer: '收起',
} as const

/**
 * The model menu's one folded row for the saved services a Harness cannot use, and the reason on each when it opens. A
 * reason that names a key or an unconfirmed address points to where that is done; it never offers to do it here.
 */
export const MODEL_MENU_COPY = {
  unusable: (count: number) => `${count} 个服务用不了`,
  /** The Harness speaks a protocol the service does not: which ones each speaks. */
  wrongProtocol: (agent: string, speaks: readonly string[], service: string) => `${agent} 只说 ${speaks.join('、')}，这个服务是 ${service}`,
  /** A Harness or service Latch does not forward between: no Harness chosen yet, or a plugin's own provider. */
  notRouted: (agent: string) => `转发 ${agent} 的请求尚未实现`,
  missingKey: '没有密钥 · 在设置 › 模型里添加',
  unconfirmed: (computer = 'Mac') => `地址还没确认 · 在 ${computer} 上确认`,
} as const

/**
 * A call no person was asked about, as its row in the timeline says it: the harness's own model reviewing a request, or a
 * call that ran unasked while that model decides. Never words for a person's approval.
 */
export const JUDGED_COPY = {
  review: (agent: string) => `${agent} 的模型审阅`,
  approved: '放行',
  denied: '拦下',
  none: '没有判断',
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
} as const

/** The drawer's one line when a session cannot go on as it is, and what it offers. */
export const RECOVERY_COPY = {
  folderMissing: (project: string) => `项目文件夹「${project}」找不到了`,
  continueInNew: '在新会话中继续',
} as const

/**
 * 接入已有会话: the session brought in is private from the start, so only a device that may see private sessions lists,
 * previews or imports. A device without that sees the entry locked, with where it is opened.
 */
export const HISTORY_COPY = {
  entry: '接入已有会话',
  locked: (computer = 'Mac') =>
    `接入的会话只对能看项目文件的设备可见。在 ${computer} 上的 Latch 里，为这台设备开启「可以看项目文件」后可用。`,
  busy: '这个会话正在别处使用',
  busyDetail: (from: string) => `先在那里退出（例如终端里的 ${from}），再回来接入。Latch 不会接管正在使用的会话。`,
} as const

const FIXED: Record<string, string> = {
  'history-session-busy': HISTORY_COPY.busy,
  'file-image-dimensions': fileNote('file-image-dimensions').text,
  'file-too-large': '文件或图片超过这台设备的预览上限，请在 Mac 上查看。',
  'file-edit-elevated': '这个文件需要能批准高风险操作的设备',
  'file-code-root': 'Latch 程序目录里的文件不能在这里编辑',
  'file-mixed-eol': '混用换行符的文件不能在这里编辑',
  'file-edit-scope': '这台设备不能发起会话，不能编辑文件',
  'file-edit-data-scope': '这台设备不能编辑会话文件夹中的文件',
  unauthorized: '这台设备还没有连接到这台 Mac',
  'renewal-required': '这台设备需要重新连接',
  'credential-expired': ENROLLMENT_REASON_TEXT['credential-expired']!,
  'device-revoked': ENROLLMENT_REASON_TEXT['device-revoked']!,
  'listener-mismatch': ENROLLMENT_REASON_TEXT['listener-mismatch']!,
  'legacy-reconfirm': '这台设备需要重新连接',
  'local-only': LOCAL_ONLY_TEXT,
  'policy-changed': '设置刚被修改过，这次更改没有应用。请查看最新的设置后重试。',
  'presence-unavailable': '这台 Mac 暂时不能确认',
  'origin-unconfirmed': '这个模型服务的地址还没有确认，Latch 不会向它发送请求。请在 Mac 上的 Latch 里确认：设置 › 模型。',
  'presence-busy': CONFIRMATION_COPY.busy,
  'presence-blocked': CONFIRMATION_COPY.blocked,
  'confirmation-not-found': '找不到该确认',
  'confirmation-pending': '还没有确认',
  'confirmation-denied': CONFIRMATION_RESULT_TEXT.denied,
  'confirmation-expired': CONFIRMATION_RESULT_TEXT.expired,
  'confirmation-mismatch': '确认内容与本次请求不一致，请重新确认',
  'confirmation-used': '该确认已使用',
  'confirmation-cancelled': CONFIRMATION_RESULT_TEXT.cancelled,
  'confirmation-os-required': '这项操作要用 Touch ID 或登录密码确认，请重试。',
  'confirmation-signature-invalid': '没有执行：确认无效。',
  'confirmation-shell-unavailable': '请更新 Mac 上的 Latch 后再确认。',
  'confirmation-failed': CONFIRMATION_RESULT_TEXT.error,
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
  'permission-drift': SESSION_STOP_TEXT['permission-drift'],
  'permission-unverified': SESSION_STOP_TEXT['permission-unverified'],
  'agent-definition-changed': SESSION_STOP_TEXT['agent-definition-changed'],
  'project-config-changed': SESSION_STOP_TEXT['project-config-changed'],
  'l3-confirmation-missing': SESSION_STOP_TEXT['l3-confirmation-missing'],
  'approval-settled': '该审批已结束',
  // Answered by the desktop shell's main process, not the Host.
  'fingerprint-mismatch': '这台设备的密钥和 Mac 读到的不一致，已停止连接。',
  'host-unavailable': '连不上这台 Mac 上的 Latch，请确认它还在运行。',
  'credential-store-failed': '无法安全保存设备凭据，连接未完成。',
  'browser-open-unsupported': '此系统上不能从 Latch 应用直接打开浏览器，请运行 pnpm latch device invite --loopback。',
  'browser-open-failed': '无法在浏览器中打开 Latch，请重试。',
  'copy-link-unsupported': '此系统上不能从 Latch 应用复制链接，请运行 pnpm latch device invite。',
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
  'native-managed': '这个地址由启动参数管理，需要停止 Latch 服务后修改参数。',
  'native-address-unavailable': '原来的局域网地址已不可用，请重新选择当前地址。',
  'native-listener-unavailable': '无法启用所选地址或端口，请核对网络后重试。',
  'native-not-ready': '手机连接服务正在准备，请稍后重试。',
  'native-verification-required': '请先在手机完成身份验证，再查看正文或操作。',
}

/** Prefix families in the catalog; an unlisted member still never shows server text. */
const FAMILY_FALLBACK: Array<[prefix: string, text: string]> = [
  ['presence-', '这台 Mac 暂时不能确认，请稍后重试'],
  ['confirmation-', CONFIRMATION_RESULT_TEXT.error],
  ['enrollment-', '连接未完成，请重新提交'],
  ['invitation-', '配对码无效或已过期'],
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

export const DEVICE_NAME_INVALID_TEXT = '设备名称不能包含换行、不可见字符或改变文字方向的字符。'

/** What a device cannot do, by the scope it lacks. */
const SCOPE_REFUSALS: Record<DeviceScope, string> = {
  view: '这台设备不能查看',
  run: '这台设备不能发送消息',
  'approve:standard': '这台设备不能允许这一步',
  'approve:elevated': '这台设备不能允许这一步',
  admin: '这台设备不能改设置',
  secrets: '这台设备不能改密钥',
}
const scopeRefusal = (scope: unknown) =>
  typeof scope === 'string' && Object.hasOwn(SCOPE_REFUSALS, scope) ? SCOPE_REFUSALS[scope as DeviceScope] : '这台设备不能这样做'
const seconds = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined)

/** True when the code's text comes from the catalog rather than the Host. */
export function isCatalogCode(code: string): boolean {
  return (
    Object.hasOwn(FIXED, code)
    || code === 'scope-required'
    || code === 'stepup-required'
    || code === 'presence-cooldown'
    || code === 'egress-denied'
    || FAMILY_FALLBACK.some(([prefix]) => code.startsWith(prefix))
  )
}

/** The text a page shows for a Host error. */
export function describeFailure(status: number, code: string, message: string, details: Partial<ApiFailure> = {}): string {
  switch (code) {
    case 'attachment-claimed':
      return '附件已保留给另一条提交。请重试原提交，或移除附件后重新添加。'
    case 'attachment-secret':
      return '附件可能包含密钥。请检查内容，并明确确认后再添加。'
    case 'file-reference-refused':
      return '引用文件已不存在、不在当前会话文件夹内，或可能包含密钥。请重新选择。'
    case 'attachment-publish-unknown':
      return '会话已开始，附件记录尚未确认。请重试同一次提交。'
    case 'scope-required':
      return scopeRefusal(details.required)
    case 'stepup-required':
      return '需要在 Mac 上确认'
    case 'presence-cooldown': {
      const wait = seconds(details.retryAfter)
      return `连续取消了 3 次，请 ${wait === undefined ? 5 : Math.max(1, Math.ceil(wait / 60))} 分钟后再试`
    }
    case 'egress-denied': {
      const target = safeTarget(details.target)
      return `Latch 不会访问${target === undefined ? '这个地址' : ` ${target}`}：这是这台 Mac、局域网或云元数据地址。这台 Mac 和局域网上的地址要在 Mac 上确认后才能使用。`
    }
    case 'rate-limited': {
      const wait = seconds(details.retryAfter)
      return wait === undefined ? '请求过于频繁，请稍后再试' : `请求过于频繁，请 ${wait} 秒后再试。`
    }
  }
  if (Object.hasOwn(FIXED, code)) return FIXED[code]!
  const family = FAMILY_FALLBACK.find(([prefix]) => code.startsWith(prefix))
  if (family) return family[1]
  return message || `请求未完成（${status}），请重试。`
}
