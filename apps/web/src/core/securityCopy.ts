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
export const LOCAL_ONLY_TEXT = '只能在 Mac 上的 Latch 里操作'

/** Restrictions and consequences shown while choosing or adding an agent, project or model service. */
export const SETUP_COPY = {
  modelNeedsAdmin: '这台设备不能添加模型。在 Mac 上的 Latch 里添加：设置 › 模型。',
  harnessNeedsAdmin: '这台设备不能管理 Harness。在 Mac 上的 Latch 里查看：设置 › Harness。',
  addAgentElsewhere: '在 Mac 上的 Latch 里添加：设置 › Harness',
  addProviderElsewhere: '在 Mac 上的 Latch 里添加：设置 › 模型',
  keyElsewhere: '密钥只能在 Mac 上的 Latch 里填写：设置 › 模型。',
  keyStorage: '密钥只保存在这台 Mac 上，不会发给浏览器。',
  addProjectElsewhere: '在 Mac 上的 Latch 里添加项目',
  confirmAddressElsewhere: '这个地址要先在 Mac 上确认一次，才能在这里使用：设置 › 模型。',
  saveAgent: '保存后就能用它开始会话；每次启动都留有记录。',
  agentFullAccess: '它可以读写这台 Mac 上的文件并运行命令，Latch 不隔离它。',
  fullAccessDetail: '完全访问：Harness 不再询问，直接读写这台 Mac 上的文件并运行命令',
} as const

/**
 * Approvals: the words of each kind of request, the drawer's lines, and the reasons that replace an allow button this
 * device does not get.
 */
export const APPROVAL_COPY = {
  waiting: '需要你允许',
  highRisk: '高风险',
  advisory: '仅提示',
  check: '需要核对',
  advisoryNote: 'Harness 的询问只是提示：拒绝会转达给它，但不能阻止它执行其他操作。',
  hiddenCharacters: '含有不可见字符，已标出',
  more: '更多批准选项',
  moreSheet: '更多选项',
  allowSession: '这个会话都允许这类操作',
  moreBusy: '正在提交另一个选择',
  noStandard: '这台设备不能允许这一步',
  noElevated: '这台设备不能允许这一步',
  noRun: '这台设备不能允许这一步',
  /** The choice whose outcome is unknown, by the label of its button. */
  uncertainTitle: (choice: string) => `「${choice}」的结果未知`,
  uncertain: '可重试同一选择，不会重复提交。',
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
  rejectPlaceholder: '输入内容会拒绝并告诉 Harness 改做什么',
  viewChange: '查看改动',
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
  viaThisMac: '在这台 Mac 上决定',
  viaOtherDevice: '在其他设备上决定',
  expiredNote: '没有人在时限内回答',
  cancelledNote: '会话停止时还没有人回答',
  ranDespite: 'Harness 报告仍执行了这次调用',
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
  waitingShort: '等待确认',
  waitingTouchId: '等待 Touch ID',
  /** Above what a system form's sentence leaves out. */
  details: '确认详情',
  confirmed: '已确认，正在',
  cooldown: '连续取消了 3 次，暂时不再询问。',
  /** How long the pause still lasts, 「4:05 后可以再试。」. */
  cooldownWait: (wait: string) => `${wait} 后可以再试。`,
  cooldownOver: '现在可以再试。',
  busy: '另一个确认还没完成，先完成或取消它。',
  blocked: '有 Harness 正在运行或等你处理，结束后才能确认。',
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
  'provider.confirm-origin': '保存服务',
}

/** What a confirmation held back by a running agent was for, in 「…，结束后才能放宽设置。」. */
export const BLOCKED_ACTION_TEXT: Record<PresenceAction, string> = {
  'plugin.package.apply': '应用自定义插件',
  'device.enroll-native': '配对手机',
  'device.enroll': '配对新设备',
  'device.grant': '为设备增加权限',
  'policy.change': '放宽设置',
  'provider.confirm-origin': '确认模型服务地址',
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
    if (!first) return `有 Harness 正在运行或等你处理，${then}`
    const more = sessions.length > 1 ? `等 ${sessions.length} 个会话` : ''
    const agent = first.agent ? `${first.agent} ` : ''
    if (first.waiting) return `${agent}在「${first.title}」${more}里等你处理，${then}`
    return `${agent}正在运行「${first.title}」${more}，${then}`
  },
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
  local: '第一次连接时，在 Mac 上允许一次。之后打开即可继续工作。',
  /** The desktop app on its first launch, one sentence and one button; nothing else is asked until another device connects. */
  desktopTitle: 'Latch',
  desktopFirst: '第一次在这台 Mac 上打开 Latch。',
  desktopAgain: '在这台 Mac 上用 Touch ID 确认后继续。',
  desktopSubmit: '继续',
  /** The intro while local confirmation is unavailable: the offline code is the way in. */
  offline: '这台设备会生成自己的密钥，再用离线连接码完成连接。',
  /** Why only the offline code is accepted, with the Host's reason (trailing full stops removed). */
  unavailable: (reason: string) =>
    `Mac 现在不能确认：${reason || '未知原因'}。停止 Latch 服务后，在 Mac 上运行 pnpm latch device enroll --offline，把生成的离线连接码填在下面。`,
  /** The same, where the Host takes no offline code (every listener but host.sock): nothing here can be submitted yet. */
  unavailableRemote: (reason: string) => `Mac 现在不能确认：${reason || '未知原因'}。要等它能确认后才能连接。`,
  invited: '点下面的按钮，再到 Mac 上允许。',
  invitationRequired:
    '这台设备还没连接到 Latch。要连接手机，在 Mac 上的 Latch 里打开 手机 › 连接手机，用 iPhone 上的 Latch 扫码；其他电脑用运行 Latch 的人发来的链接。',
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
  compare: '用 Touch ID 或登录密码允许这台设备。',
  completing: '正在完成连接…',
  connecting: '正在连接…',
  confirmFailed: '已经连上，但还没能读取 Mac 上的状态。',
  denied: 'Mac 上取消了连接。',
  expired: 'Mac 上没有确认，请重新开始。',
  offlineField: '离线连接码',
  offlineSubmit: '使用离线连接码',
  unsupported: '此浏览器无法在当前地址安全地保存设备密钥。请使用最新版 Chrome、Edge、Firefox 或 Safari，或使用 Latch 桌面端。',
  mismatch: '这台设备的密钥和 Mac 读到的不一致，已停止连接。',
  legacyTitle: '这台设备要在 Mac 上重新确认',
  legacyBody: 'Latch 更新了连接方式。点下面的按钮，再到 Mac 上允许。',
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
  compareOnMac: '和 Mac 上 Latch 手机页里的校验码相同，才是这台设备。',
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
export const SETTINGS_ADMIN_HIDDEN = '其他设置在 Mac 上的 Latch 里'

/** This Mac cannot confirm anything now, in the Host's words when it gave some. */
export const presenceUnavailableText = (message: string | undefined) =>
  message ? `这台 Mac 暂时不能确认：${message}` : '这台 Mac 暂时不能确认，需要它确认的操作都不能进行。'

/** The 手机 page: the devices that use this Mac. It names no address, relay or scope; a waiting device's code is folded. */
export const DEVICES_COPY = {
  shelf: '设备',
  empty: '还没有连接手机',
  emptyBody: '用 iPhone 上的 Latch 扫一扫，在同一个 Wi‑Fi 下继续你的会话。',
  /** A device that cannot open the pairing sheet: where to pair, in words. */
  pairElsewhere: '要连接手机，请在 Mac 上的 Latch 里打开这一页',
  name: '名称',
  nameLabel: '设备名称',
  unnamed: '未命名设备',
  online: '在线',
  lastSeen: '上次在线',
  state: '状态',
  /** `native.input` and `status` a person can act on; a healthy device says nothing about them. */
  verificationRequired: '30 天未验证，现在只能查看；在手机上验证后恢复',
  review: '只能查看，等你恢复',
  reviewNote: '连接它的设备已被移除。恢复后可以继续运行和允许操作。',
  restore: '恢复使用',
  legacy: '要在这台设备上重新确认',
  manage: '可以管理这台 Mac',
  manageNote: '修改模型、Harness、插件、项目和设备。密钥和连接新地址仍只能在 Mac 上操作。',
  raiseOnMac: '在 Mac 上开启',
  remove: '移除',
  rename: '重命名',
  removeTitle: (name: string) => `移除「${name}」？`,
  removePhone: '它会立即断开，之后要重新扫码才能连接。',
  removeBrowser: '它会立即断开，之后要重新发链接才能连接。',
  removeDesktop: '它会立即断开，之后要在那个桌面端重新确认才能连接。',
  removeSelf: '这台设备会立即断开，之后要重新发链接才能连接。',
  /** Added when other devices were invited by this one. */
  removeCascade: '由它连接的设备会降为只能查看，等你恢复。',
  removed: (name: string) => `已移除「${name}」`,
  about: '关于连接',
  aboutBody: '同一个 Wi‑Fi 下，手机直接连接这台 Mac，全程端到端加密。Latch 目前还不提供其他网络下的连接。',
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
  sameWifi: 'iPhone 需要和这台 Mac 连接同一个 Wi‑Fi。',
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
  removed: '它已断开，之后要重新扫码才能连接。',
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
  notice: '这个文件夹在 Latch 的程序目录里，每次写入都要你允许',
  startDir: '这是 Latch 启动时的文件夹。要在别的文件夹里工作，可以新建一个项目。',
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
  elsewhere: '在 Mac 上的 Latch 里可以快速查看和打开。',
  /** A desktop shell from before file actions. */
  shellOutdated: '重新启动 Latch 后，可以在这里快速查看和打开。',
} as const

/**
 * How a note at the foot of a file menu is marked: `lock` for what Latch refuses on purpose (the only place the lock
 * appears), `info` for where or how something can be done, `alert` for something that went wrong.
 */
export type FileNoteTone = 'lock' | 'info' | 'alert'
export interface FileNote {
  text: string
  tone: FileNoteTone
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
  if (WEB_TYPES.has(ext)) return `网页和 SVG 用浏览器打开时可以联网，Latch 不直接打开；可以${reveal}后自己打开。`
  if (MACRO_TYPES.has(ext)) return `这种 Office 文件可以带宏或嵌入的对象，Latch 不直接打开；可以${reveal}后自己打开。`
  return `Latch 只直接打开常见的文档、图片和音视频，不打开程序、脚本或没有扩展名的文件；可以${reveal}后自己决定。`
}

/** The note for each code the Host or the shell gave; anything else is a plain failure. */
const FILE_NOTES: Record<string, (context: FileNoteContext) => FileNote> = {
  'file-outside-folders': ({ platform }) => ({
    text: `这个文件不在会话的文件夹里，Latch 不替你打开它。${platform === 'darwin' ? '复制路径后，可以在访达中按 ⇧⌘G 前往。' : '复制路径后，可以在文件管理器中前往。'}`,
    tone: 'lock',
  }),
  'file-folder-removed': () => ({ text: '这个会话的文件夹已不在项目里，Latch 不再替你打开其中的文件。', tone: 'lock' }),
  'file-protected': () => ({ text: '这是 Latch 的私有数据。', tone: 'lock' }),
  'file-secret': () => ({ text: '这个文件可能含密钥，不提供快速查看和打开。', tone: 'lock' }),
  'file-type-refused': context => ({ text: typeRefusal(context), tone: 'lock' }),
  'file-preview-unverified': () => ({
    text: '快速查看暂不用于这种文件：还没有确认系统的预览不会加载文件里引用的网络资源。',
    tone: 'lock',
  }),
  'file-content-mismatch': () => ({ text: '文件内容与扩展名不符，Latch 不直接打开它。', tone: 'lock' }),
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

export function fileRefusalText(code: string, context: FileNoteContext = {}): string {
  return fileNote(code, context).text
}

/**
 * Where a plugin's parts run and who receives them, for the plugin form. Plain facts rather than a warning: a page module
 * is delivered to every device that may view sessions and runs with that page's rights; nothing isolates it.
 */
export const PLUGIN_REACH_COPY = {
  title: '代码在哪里运行',
  page: {
    title: '界面面板',
    body: '代码会发到每台能查看会话的设备，在那台设备的 Latch 页面里运行：这台 Mac 上的 Latch，以及手机和其他电脑的浏览器。那个页面能做的事它都能做，没有隔离。iPhone App 不运行它。',
  },
  host: {
    title: '工具和后台代码',
    body: '在这台 Mac 上运行，权限和 Latch 相同：可以读写你的文件、运行程序、访问网络，也可以注册界面面板，发到能查看会话的设备。',
  },
  text: {
    title: '技能和静态面板',
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
  keyHeld: '密钥只保存在这台 Mac 上，不会发给浏览器或手机。',
  /** Other devices: the key field becomes this line. */
  keyElsewhere: '密钥只能在 Mac 上的 Latch 里填写：设置 › 模型。',
  /** Without Touch ID or a password to confirm with, for an address not confirmed yet: the key goes in with the address. */
  keyOffline: (id: string) => `地址确认之前不能在这里填写密钥：退出 Latch 后运行 pnpm latch provider set-key ${id}，密钥与地址一起确认。`,
  /** The add form on a device that cannot type keys, for a service that needs one. */
  keyAfterSave: '这个服务需要密钥：保存后，在 Mac 上的 Latch 里填写密钥，它才能使用。',
  /** A saved service at a known address without a key: it is not offered. */
  missingKey: '还没有填写密钥，Latch 不会使用它。',
  missingKeyBadge: '缺密钥',
  missingKeyRow: '还没有填写密钥',
  missingKeyHere: '填写密钥后才能使用这个服务。',
  missingKeyElsewhere: (name: string) => `在 Mac 上的 Latch 里填写密钥：设置 › 模型 › ${name}。`,
  /** The check is a model listing: a service without one is not a failed connection. */
  listingUnavailable: '无法自动检测：这个服务不提供模型列表',
  /** 已连接 comes from a listing, and some services list their models without looking at the key. */
  connectedReason: '服务刚刚回答了模型列表请求。有些服务列出模型不需要密钥，所以这不证明密钥能用于对话。',
  checkNeedsAddress: '确认地址后才能检测',
  checkNeedsKey: '填写密钥后才能检测',
  enabled: 'Latch 内置可以使用它的模型',
  enabledUnconfirmed: '确认地址后 Latch 内置才能使用它的模型',
  enabledMissingKey: '填写密钥后 Latch 内置才能使用它的模型',
  disabled: '停用后 Latch 内置不能使用它的模型',
  presetKey: '已知服务的地址：密钥直接保存，不需要确认。',
  /** An address not confirmed yet, on the desktop that can confirm it. */
  firstUse: '第一次使用这个地址：保存时用 Touch ID 确认一次，之后不再询问。',
  /** The probe met a local or private address: not an error, it is confirmed with the save. */
  localAddress: (target: string) => `这是这台 Mac 或局域网上的地址。确认后 Latch 才会访问 ${target}。`,
  localAddressAtSave: (target: string) => `这是这台 Mac 或局域网上的地址，保存时确认一次，之后 Latch 才会访问 ${target}。`,
  allowAndFetch: '用 Touch ID 允许并获取模型',
  saveWithTouchID: '用 Touch ID 保存',
  confirmAddress: '用 Touch ID 确认地址',
  waitingTouchID: '等待 Touch ID…',
  save: '保存服务',
  unconfirmed: '这个服务的地址还没有确认，Latch 不会使用它。',
  unconfirmedBadge: '未确认',
  unconfirmedRow: '需要在 Mac 上确认这个地址',
  /** Other devices: where the address is confirmed. */
  confirmElsewhere: (name: string) => `需要在 Mac 上确认这个地址：设置 › 模型 › ${name}。`,
  /** A computer without Touch ID or a password to confirm with: the offline command. */
  confirmOffline: (id: string) =>
    `这台电脑不能用 Touch ID 或登录密码确认。退出 Latch 后运行 pnpm latch provider confirm ${id}（或用 set-key 同时保存密钥），再启动 Latch。`,
  confirmOfflineNew: '这台电脑不能用 Touch ID 或登录密码确认。先不填密钥保存，再退出 Latch，运行 pnpm latch provider confirm <服务 ID>。',
  /** A Mac whose confirmation component needs fixing (rebuilt, signature lost): the given reason, with its fix. */
  presenceBroken: (message: string) => `这台 Mac 暂时不能确认：${message}`,
  savedUnconfirmed: '保存后它会显示在列表里，等你在 Mac 上确认地址。',
  /** A confirmed address whose allowance was removed. */
  allowAgain: (target: string) => `用 Touch ID 允许访问 ${target}`,
  allowElsewhere: '需要在 Mac 上的 Latch 里允许这个地址。',
  confirmedAddressesTitle: '已确认的地址',
  confirmedAddressesCaption: '自定义和这台 Mac 上的模型服务，地址确认一次后才能使用。移除后，用它的服务随即停止。',
  addressUse: (services: readonly string[], allowance?: string) =>
    [
      services.length ? `${services.map(escapeSecurityText).join('、')} 在用` : '没有服务在用',
      ...(allowance ? [`Latch 可以连接 ${allowance}`] : []),
    ].join(' · '),
  removeAddress: (services: readonly string[]) =>
    `${services.length ? `${services.map(name => `「${escapeSecurityText(name)}」`).join('、')}随即停止发送请求，正在运行的会话下一次请求会失败。` : ''}要再用这个地址，保存服务时重新确认。`,
  allowanceRow: 'Latch 可以连接这个地址',
  removeAllowance: '依赖这个地址的连接随即断开。要再用它，需要在这台 Mac 上重新确认。',
} as const

/** Why a session no longer accepts input: one line, with 「在新会话中继续」 beside it. */
export const SESSION_STOP_TEXT = {
  'permission-drift': '这个 Harness 的设置变了，为了安全换个新会话继续',
  'agent-definition-changed': '这个 Harness 的设置变了，为了安全换个新会话继续',
  'project-config-changed': '项目里的 Harness 配置变了，为了安全换个新会话继续',
  'l3-confirmation-missing': '这个会话缺少启动记录，不能继续。换个新会话继续',
  'permission-unverified': '确认不了 Harness 的权限，这一轮没有发送',
} as const
export const DOCUMENT_PREVIEW_ERRORS = {
  'document-too-complex': '这份演示文稿的内容过于复杂，暂时无法预览。可以下载或在电脑上打开。',
  'zip-refused': '文档压缩结构超出预览上限，可以下载或在电脑上打开。',
  fallback: '无法显示这个文档，请下载或在 Mac 上打开。',
} as const
export type SessionStopCode = keyof typeof SESSION_STOP_TEXT
/** The same stop after a mode change, where no message was on its way. */
export const CONFIG_UNVERIFIED_TEXT = '确认不了 Harness 是否切换到了所选的权限模式'
export const isSessionStopCode = (code: string): code is SessionStopCode => code in SESSION_STOP_TEXT
/** A mode that could not be read back this once: nothing went out, the session may read true on the next try. */
export const stopLocksInput = (code: SessionStopCode) => code !== 'permission-unverified'

/** Disabled controls: the hover reason, for a control the Mac alone can change. */
export const HOVER_REASONS = {
  onMac: '在 Mac 上的 Latch 里操作',
  confirmOnMac: '在 Mac 上确认',
  macOnly: '只能在这台 Mac 上改',
  openInLatch: '在 Latch 中打开',
  noView: '这台设备不能查看',
} as const

/** The composer's 权限 chip and its rows with the agent as subject. */
export const MODE_COPY = {
  menuTitle: '什么时候问你？',
  noFiles: '不读写文件',
  noFilesLine: '只回复文字，不读写文件，也不运行命令。要读写文件，选一个项目开始新会话。',
  askFirst: '先问你',
  askFirstLine: (agent: string) => `${agent} 改文件或运行命令前问你`,
  /** The built-in engine has no way to run a command, so its mode cannot speak of one. */
  askBeforeWritesLine: '读项目不问；写文件每次问你',
  fullAccess: '完全访问',
  /** One meaning only. */
  fullAccessTooltip: 'Harness 可以读写这台 Mac 上的文件并运行命令，不再询问',
  agentDecides: (agent: string) => `不询问 · 由 ${agent} 决定`,
  agentDecidesLine: (agent: string) => `${agent} 执行前不询问，Latch 不限制它`,
  /** The timeline's first row, once per launch in a project: the 权限 chip and the heading must not read as a limit. */
  firstStart: (agent: string) => `${agent} 能读写这台 Mac 上的文件并运行命令。权限是 ${agent} 自己的设置，Latch 不隔离它。`,
  unverifiable: '权限无法确认',
  unverifiableLine: (agent: string) => `Latch 启动时把 ${agent} 设为只读，但读不回来，无法确认它是否生效`,
  afterStart: '开始后可以选',
  afterStartLine: (agent: string) => `${agent} 开始后才告诉 Latch 它有哪些权限模式`,
  /** Under the current row before start: the modes come from the agent itself. */
  changeAfterStart: (agent: string) => `发第一条消息后可以换：${agent} 那时才告诉 Latch 它有哪些模式。`,
  /** Under the modes of a running agent. */
  agentOwnSetting: (agent: string) => `这是 ${agent} 自己的设置。Latch 只核对档位名，不核对它实际怎么做，也不隔离它。`,
  readOnlyLine: (agent: string) => `${agent} 只看不改`,
  autoLine: (agent: string) => `${agent} 在项目里改文件和运行命令，越界前问你`,
  neverAsksLine: (agent: string) => `${agent} 不再询问，直接读写这台 Mac 上的文件并运行命令`,
} as const

/** The drawer's one line when a session cannot go on as it is, and what it offers. */
export const RECOVERY_COPY = {
  folderMissing: (project: string) => `项目文件夹「${project}」找不到了`,
  chooseFolder: '重新选择文件夹',
  continueInNew: '在新会话中继续',
  continuePlaceholder: '在新会话中继续…',
  settingsChanged: SESSION_STOP_TEXT['agent-definition-changed'],
  modelUnavailable: (model: string, status: number) => `${model} 暂时不可用（${status}）`,
  retry: '重试',
  changeModel: '换个模型',
  contextUsed: (percent: number) => `上下文已用 ${percent}% · 压缩并继续`,
} as const

const FIXED: Record<string, string> = {
  'file-image-dimensions': fileNote('file-image-dimensions').text,
  'file-too-large': '文件或图片超过这台设备的预览上限，请在 Mac 上查看。',
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
  'browser-open-unsupported': '此系统上不能从桌面端直接打开浏览器，请运行 pnpm latch device invite --loopback。',
  'browser-open-failed': '无法在浏览器中打开 Latch，请重试。',
  'native-not-configured': '请先在 手机 › 连接手机 中设置连接方式。',
  'native-config-changed': '手机连接配置已变化。请重新打开设置连接，再核对后保存。',
  'native-relay-duplicate': '每个中继节点只能添加一次。',
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
