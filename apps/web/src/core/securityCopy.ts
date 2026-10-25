import {
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
 * Security-related text comes from this catalog, chosen by the Host's error
 * code; the Host's free-text `message` is never shown for these codes. The only
 * values substituted in are a scope label, a wait time and a validated
 * `host:port` target. Codes outside the catalog keep the Host's message, which
 * React renders as plain text.
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
  'device-revoked': '此设备已被撤销。如需继续使用，请重新登记。',
  'credential-expired': '此设备的登记已满 30 天，请重新在本机确认。',
  'listener-mismatch': '此设备的凭据属于另一个访问地址，请重新登记。',
  'key-missing': '此浏览器已丢失设备密钥，请重新在本机确认。',
  'credential-not-stored': '登记已完成，但此浏览器没有保存设备凭据（可能禁止了 Cookie）。请允许此网站保存 Cookie 后重新登记。',
  'renewal-not-stored':
    '设备凭据已续期，但此浏览器没有保存新的凭据（可能禁止了 Cookie）。请允许此网站保存 Cookie 后重新加载页面；仍无法连接时再重新登记。',
}

export const HOST_DESKTOP_TEXT = '此操作需要在运行 Latch 的电脑上用 Latch 桌面端确认。'
/** A change that reduced permissions applied while the Host could not write its audit log (`x-latch-audit: failed`). */
export const AUDIT_NOT_RECORDED_TEXT = '修改已生效，但执行端没有写入审计记录。请检查执行端数据目录所在磁盘的空间与权限。'
export const LOCAL_ONLY_TEXT = '此操作只能在运行 Latch 的电脑上用 Latch 桌面端进行'

/** Restrictions and consequences shown while choosing or adding a harness, project or model service. */
export const SETUP_COPY = {
  modelNeedsAdmin:
    '这台设备没有「管理此 Host」权限，不能添加模型服务。可以在运行 Latch 的电脑上添加，或在 设置 › 设备 中为此设备授予管理权限。',
  harnessNeedsAdmin:
    '这台设备没有「管理此 Host」权限。请在运行 Latch 的电脑的 设置 › Agent 成员或插件 中检查配置，也可在 设置 › 设备 中授予此设备管理权限。',
  addAgentElsewhere: '在运行 Latch 的电脑上添加：设置 › Agent 成员',
  addProviderElsewhere: '在能管理此 Host 的设备上添加：设置 › 模型服务',
  keyElsewhere: '密钥只能在运行 Latch 的电脑上用桌面端填写：设置 › 模型服务。',
  keyStorage: '密钥只保存在执行端的私有目录，不会返回到浏览器。',
  addProjectElsewhere: '新项目要在运行 Latch 的电脑上用桌面端创建',
  confirmAddressElsewhere: '这个地址要先在运行 Latch 的电脑上确认一次，才能在这里使用：设置 › 模型服务。',
  saveAgent: '保存不需要确认；开始会话时会在这台电脑上确认要运行的命令。',
  agentFullAccess: '用它开启的会话为完全访问：Agent 自己决定执行范围，Latch 不隔离它。',
  fullAccessDetail: '完全访问：Agent 自己决定执行范围，不逐项询问',
} as const

/**
 * Approval cards: the state pill of each kind of request, the notes under the title, the footnotes that say what
 * allowing does, and the reasons that replace an allow button this device does not get.
 */
export const APPROVAL_COPY = {
  waiting: '待批准',
  highRisk: '高风险',
  advisory: '仅提示',
  check: '需要核对',
  advisoryNote: '完全访问会话中，Agent 的询问只是提示：拒绝会转达给它，但不能阻止它执行其他操作。',
  hiddenCharacters: '内容包含不可见或改变显示方向的字符，已用 \\u{…} 标出。请仔细核对后再决定。',
  onceNote: '只允许这一次，之后的同类操作仍会询问。',
  localNote: '允许后在这台电脑的系统表单中核对并确认。',
  confirmedLocal: '已在本机确认，正在执行…',
  allowLocal: '在本机允许',
  allowLocalTooltip: '需要在这台电脑的系统表单中确认',
  more: '更多批准选项',
  moreSheet: '更多选项',
  alwaysNote: '只在这个会话里有效',
  moreBusy: '正在提交另一个选择',
  noStandard: '此设备没有「批准普通操作」权限',
  noElevated: '此设备没有「批准高风险操作」权限',
  hostDesktop: '高风险操作只能在运行 Latch 的电脑上用 Latch 桌面端批准',
  advisoryRemote: '只有运行 Latch 的电脑上的 Latch 桌面端可以回应完全访问会话的询问',
  /** The choice whose outcome is unknown, by the label of its button. */
  uncertainTitle: (choice: string) => `「${choice}」的结果未知`,
  uncertain: '可重试同一选择，不会重复提交。',
  retry: '重试',
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
  viaThisMac: '在运行 Latch 的电脑上决定',
  viaOtherDevice: '在其他设备上决定',
  expiredNote: '没有人在时限内回答',
  cancelledNote: '会话停止时还没有人回答',
  ranDespite: 'Agent 报告仍执行了这次调用',
  ranDespiteNote: 'Agent 的询问只是提示：拒绝会转达给它，但不能阻止它执行。这一行显示的是 Agent 自己的报告。',
  /** Why a note cannot go with a rejection (「告诉 Agent 改做什么」). */
  noteInvalid: '说明最多 500 个字，不能包含控制字符、不可见字符或改变文字方向的字符',
  /** After 拒绝, the composer asks what to do instead. */
  notePlaceholder: '告诉 Agent 改做什么…',
  noteLabel: '告诉 Agent 改做什么',
  /** Latch 内置: the rejection waits for the note, which goes to the model with it. */
  noteHint: '写下的话会和拒绝一起交给模型；不写也可以直接拒绝。',
  noteCard: '在输入框里告诉 Agent 改做什么，再按「拒绝」；不写也可以。',
  noteSubmit: '拒绝',
  noteSubmitLabel: '拒绝并交给模型',
  noteCancel: '返回',
  /** An agent's ask: the rejection went at once, and the text waits for the turn to end. */
  noteAfterTurn: 'Agent 的询问不能附带文字，本轮结束后再发送。',
} as const

/**
 * The high-risk pill: 高风险 with the Host's reason (「高风险 · Latch 程序目录内」), or alone when there is none or the code
 * is not one this page knows. The words come from @latch/protocol, the same the Host's local confirmation shows.
 */
export function highRiskLabel(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(RISK_REASON_TEXT, reason)
    ? `${APPROVAL_COPY.highRisk} · ${RISK_REASON_TEXT[reason as ApprovalRiskReason]}`
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
 * The local confirmation, as the card in place shows it (the dock is only the fallback for places without one). The
 * macOS system sheet shows one sentence, the ticket's `reason`, and that sentence is what the person checks; the card
 * repeats it and keeps the details the sheet leaves out. There is no window of Latch's own and no check code.
 */
export const CONFIRMATION_COPY = {
  label: '本机确认',
  waiting: '等待 Touch ID…',
  waitingShell: '等待本机确认…',
  /** Before the sheet's sentence, in the desktop app on the computer running Latch. */
  sheet: '系统表单会写：',
  /** A browser on the Host computer (development only): the sheet opens on this computer, outside the browser. */
  browser: '到运行 Latch 的这台电脑上，在系统表单里核对这句话：',
  check: '只在这句话就是你要做的事时确认，否则在表单里取消。',
  details: '确认详情',
  /** Under the details: where they come from and that the sheet does not show them. */
  detailsNote: '这些内容来自 Host；请核对系统表单中显示的操作和详情。',
  confirmed: '已在本机确认，正在',
  cooldownTitle: '本机确认已暂停',
  cooldown: '连续拒绝了 3 次。为防止误触批准，暂时不再请求本机确认。',
  /** How long the pause still lasts, 「4:05 后可以重试。」. */
  cooldownWait: (wait: string) => `${wait} 后可以重试。`,
  cooldownOver: '现在可以重试。',
  busyTitle: '另一个确认还没完成',
  busy: '先完成或取消正在等待的那一个本机确认。',
  blockedTitle: '暂时不能确认',
  blocked: '完全访问会话正在运行或等你处理。为防止 Agent 冒用你的确认，这项确认要等它结束。',
  /** 「要等「修复设置页密钥丢失」结束，才能配对新设备。」; with more sessions, 「…」等 3 个会话结束…. */
  blockedAfter: (verb: string, others: number) => `」${others > 0 ? `等 ${others + 1} 个会话` : ''}结束，才能${verb}。`,
  blockedBefore: '要等「',
  untitled: '未命名会话',
  openSession: '查看会话',
  stopSession: '停止会话',
  cancel: '取消',
  close: '关闭',
  ok: '好',
} as const

/** What a refused confirmation was for, in 「要等「…」结束，才能{…}。」. */
export const BLOCKED_VERBS: Record<
  'device.enroll' | 'device.grant' | 'policy.change' | 'provider.set-key' | 'provider.confirm-origin',
  string
> = {
  'device.enroll': '配对新设备',
  'device.grant': '为设备增加权限',
  'policy.change': '放宽安全策略',
  'provider.set-key': '保存模型服务密钥',
  'provider.confirm-origin': '确认模型服务地址',
}

/** The desktop's pairing panel while a device waits: the fingerprint to compare with the one on that device. */
export const PAIRING_WAITING_COPY = {
  requesting: '正在请求连接',
  compare: '和这台设备屏幕上的指纹逐字核对。一致时在系统表单里用 Touch ID 允许，不一致就在表单里取消。',
  fingerprint: '设备指纹',
  signing: '已允许，等这台设备完成登记…',
  nativeCompare: '在 Mac 弹出的系统窗口里输入手机显示的六位核对码，再完成身份确认。请勿在聊天或网页中填写核对码。',
} as const

/** What the request does once the local confirmation passes, for 「已在本机确认，正在…」. */
export const CONFIRMATION_VERBS: Record<PresenceAction, string> = {
  'device.enroll-native': '在 Mac 输入手机核对码并完成系统确认',
  'device.enroll': '登记设备',
  'agent.probe': '测试启动',
  'device.grant': '更新权限',
  'task.start-l3': '开启会话',
  'task.mode-widen': '切换模式',
  'policy.change': '更新策略',
  'provider.set-key': '保存密钥',
  'provider.confirm-origin': '保存模型服务',
  'approval.r2': '执行',
}

/** What a confirmation held back by a full-access session was for, in 「要等「…」结束，才能放宽安全策略。」. */
export const BLOCKED_ACTION_TEXT: Record<PresenceAction, string> = {
  'device.enroll-native': '在 Mac 输入手机核对码并完成系统确认',
  'agent.probe': '测试启动 Agent',
  'device.enroll': '配对新设备',
  'device.grant': '为设备增加权限',
  'task.start-l3': '开启完全访问会话',
  'task.mode-widen': '放宽会话的权限模式',
  'policy.change': '放宽安全策略',
  'provider.set-key': '保存模型服务密钥',
  'provider.confirm-origin': '确认模型服务地址',
  'approval.r2': '批准这次高风险操作',
}

/** A session named in the copy: its title and agent, already escaped and shortened (`core/blocking.ts`). */
export interface NamedSession {
  title: string
  agent?: string
}

/**
 * A confirmation the Host holds back while a full-access session runs or waits for an answer: in one sentence, which
 * session it waits for and what waits, with the two ways out beside it (open it, stop it). Where the Host named no
 * session (an older Host), the sentence says so in general.
 */
export const BLOCKED_COPY = {
  /** 「要等「修复设置页密钥丢失」（Codex）结束，才能放宽安全策略。」 */
  line: (sessions: readonly NamedSession[], action?: PresenceAction): string => {
    const [first] = sessions
    const named = first ? `「${first.title}」${first.agent ? `（${first.agent}）` : ''}` : ''
    const holder = !first ? '完全访问会话' : sessions.length > 1 ? `${named}等 ${sessions.length} 个会话` : named
    return `要等${holder}结束，才能${action ? BLOCKED_ACTION_TEXT[action] : '继续'}。`
  },
  view: '查看会话',
  stop: '停止会话',
  stopping: '正在停止…',
  /** The stop went to the Host; the session ends once the agent has settled. */
  stopRequested: (session: NamedSession) => `已请求停止「${session.title}」。它停下后，再试一次。`,
  /** Pairing: the invitation is not spent by a refused enrollment, so the same QR still works. */
  stopRequestedPairing: (session: NamedSession) => `已请求停止「${session.title}」。它停下后就能配对，二维码仍然有效。`,
  /** Every named session has ended: the action can be asked for again from where it started. */
  endedTitle: '可以再试一次了',
  ended: (sessions: readonly NamedSession[]) => `${sessions.length === 1 ? `「${sessions[0]!.title}」` : '这些会话'}已经结束。`,
  ok: '好',
} as const

/**
 * Why a local confirmation ended without the request running; the card or the dock shows it and the caller gets it as
 * the error. A denial covers every way the confirmation did not pass: 取消 in the system sheet, a failed Touch ID or
 * password, or the system cancelling it.
 */
export const CONFIRMATION_RESULT_TEXT = {
  denied: '操作没有执行。本机确认没有通过。',
  expired: '操作没有执行。2 分钟内没有完成确认。',
  cancelled: '操作没有执行。确认已取消。',
  error: '操作没有执行。本机确认没有完成。',
  /** Touch ID locked after too many failed tries: the next confirmation takes the login password, which unlocks it. */
  lockout: '操作没有执行。Touch ID 已锁定：再试一次时用这台 Mac 的登录密码确认，Touch ID 也会随之恢复。',
} as const

/** Whole minutes and seconds of a wait, 「4:05」. */
export function waitText(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** The enrollment page. */
export const ENROLLMENT_COPY = {
  title: '连接到 Latch',
  local: '这台设备会生成自己的密钥。提交后，请在运行 Latch 的电脑上核对指纹，并用 Touch ID 或登录密码确认。',
  /** The intro while local confirmation is unavailable: the offline code is the way in. */
  offline: '这台设备会生成自己的密钥，再用离线登记码完成登记。',
  /** Why only the offline code is accepted, with the Host's reason (trailing full stops removed). */
  unavailable: (reason: string) =>
    `本机确认不可用：${reason || '未知原因'}。停止 Host 后，在运行 Latch 的电脑上运行 pnpm latch device enroll --offline，把生成的离线登记码填在下面。`,
  /** The same, where the Host takes no offline code (every listener but host.sock): nothing here can be submitted yet. */
  unavailableRemote: (reason: string) =>
    `本机确认不可用：${reason || '未知原因'}。新设备要在运行 Latch 的电脑上确认后才能登记，请先在那台电脑上处理。`,
  invited: '已收到配对邀请。提交后，请在运行 Latch 的电脑上核对指纹并确认。',
  invitationRequired:
    '手机或其他电脑需要配对邀请：在运行 Latch 的电脑上打开 Latch 桌面端的 设置 › 设备，生成配对二维码。手机扫描二维码；其他电脑打开用「复制链接」得到的配对链接。',
  /** A browser on loopback is not this computer either; the desktop app or the command line makes its link. */
  browserInvitationRequired:
    '这台电脑上的浏览器也需要一次性登记链接。请在 Latch 桌面端的「设备」页选择「在这台电脑的浏览器中打开」，或在终端运行 pnpm latch device invite --loopback。',
  name: '设备名称',
  namePlaceholder: '例如：我的手机',
  scopes: '此设备的权限',
  submit: '请求本机确认',
  waiting: '等待本机确认',
  /** The seconds left on the enrollment request. */
  remaining: (seconds: number) => `剩余 ${seconds} 秒`,
  cancel: '取消',
  retry: '重试',
  fingerprint: '设备指纹',
  compare: '请确认电脑上显示的指纹与下面完全一致：',
  /** Before the sentence the computer's system sheet shows, which names this fingerprint. */
  sheet: '电脑上的系统表单会写：',
  completing: '正在完成登记…',
  connecting: '正在连接执行端…',
  confirmFailed: '登记已完成，但还没能读取执行端状态。',
  denied: '本机拒绝了此设备。',
  expired: '本机确认已超时，请重新提交。',
  offlineField: '离线登记码',
  offlineSubmit: '使用离线登记码',
  unsupported: '此浏览器无法在当前地址安全地保存设备密钥。请使用最新版 Chrome、Edge、Firefox 或 Safari，或使用 Latch 桌面端。',
  mismatch: '服务器返回的指纹与本机计算的不一致，已停止登记。',
  legacyTitle: '此设备需要在本机重新确认',
  legacyBody: 'Latch 已升级设备凭据，旧的登录状态不再有效。请提交确认请求，并在运行 Latch 的电脑上核对指纹。',
  legacySubmit: '在本机重新确认',
  oldHost: '此 Host 版本过旧，请在电脑上重启 Latch。',
  admin: '管理此 Host（模型服务、插件、项目和设备）',
  /** What the admin choice allows from this device, and what stays on the computer running Latch. */
  adminNote: '可以修改模型服务、插件、项目列表和设备。密钥、Agent 的启动设置、新建项目和放宽安全策略仍只能在运行 Latch 的电脑上完成。',
} as const

/**
 * Under the settings sections of a device without 管理此 Host: the sections it does not see, why, and where the scope is
 * granted. Granting still takes a local confirmation on that computer.
 */
export const SETTINGS_ADMIN_HIDDEN = '其他设置需要「管理此 Host」权限 · 在运行 Latch 的电脑的 设置 › 设备 中授予'

/** The scopes as the enrollment page lists them: the device scopes, with what viewing and managing cover. */
const ENROLLMENT_SCOPE_LABELS: Record<DeviceScope, string> = {
  ...SCOPE_LABELS,
  view: '查看会话',
  admin: ENROLLMENT_COPY.admin,
}
/** What a browser always gets; 管理此 Host is its one choice. */
export const BROWSER_SCOPES: readonly string[] = (['view', 'run', 'approve:standard'] as const).map(scope => ENROLLMENT_SCOPE_LABELS[scope])
/** The desktop app enrolls on the Host's own socket and receives every scope. */
export const DESKTOP_SCOPES: readonly string[] = (['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'] as const).map(
  scope => ENROLLMENT_SCOPE_LABELS[scope],
)

/** Pairing a phone from 设置 › 设备. */
export const PAIRING_COPY = {
  intro: '生成一次性配对二维码，在手机上扫描后提交登记。二维码 10 分钟内有效，只能使用一次；对方提交后，仍需在这台电脑上核对指纹并确认。',
  expired: '上一个二维码已过期。',
  create: '生成配对二维码',
  steps: [
    '在手机上扫描二维码，或打开配对链接。',
    '在手机上提交登记请求。',
    '在这台电脑上核对两边显示的指纹，并用 Touch ID 或登录密码确认。',
  ],
  qrFailed: '二维码生成失败，可复制配对链接。',
  copyBlocked: '当前浏览器不允许复制。请在手机上扫描二维码。',
  /** Without the Host's HTTPS entry: what is missing and what is not built yet, in words; the start options are folded. */
  notConfigured: '手机接入还没有配置。',
  /** 设置 › 电脑's phone access row when it is 未配置: where it is set up, never the start options. */
  computerRow: '连接设置在 设置 › 设备 中',
  directPending: '同一网络下扫码直连尚未实现：它需要 Host 在局域网中宣告自己并固定身份，正在开发。',
  browserHttpsOnly: '浏览器接入需要你提供的 HTTPS 证书；原生客户端使用上面的连接设置。',
  tlsDisclosure: '用自己的 HTTPS 证书配置（需要重启 Host）',
  tlsSteps:
    '为这台电脑准备一份 HTTPS 证书（例如用 Tailscale 的 tailscale cert 生成）。关闭窗口不会停止 Host：先在终端运行 pnpm stop，再用 pnpm desktop -- 加上这些参数启动：',
  tlsFlags: '--tailnet --tls-cert <证书文件> --tls-key <私钥文件> --public-origin https://<证书上的主机名>:4318',
  tlsNote: '手机要和这台电脑在同一个 tailnet 里；在局域网中改用 --lan。私钥文件只能由你读写（0600），不能放在 Latch 的数据目录或项目里。',
  copyFlags: '复制启动参数',
  needsDesktop: '配对二维码要在 Latch 桌面端生成：在运行 Latch 的电脑上打开桌面端的 设置 › 设备。',
  needsAdmin: '此设备没有「管理此 Host」权限',
  /** The time an invitation has left, then that it works once: 「剩余 9:41 · 仅可使用一次」. */
  remaining: (time: string) => `剩余 ${time} · 仅可使用一次`,
  qrAlt: '手机配对二维码',
  shareTitle: 'Latch 配对链接',
  share: '分享链接',
  copy: '复制链接',
  copied: '已复制',
  regenerate: '重新生成',
} as const

export const NATIVE_LINK_COPY = {
  title: '连接手机',
  app: '原生 App（开发预览）',
  configured: '生成一次性二维码，在原生客户端中连接这台电脑。',
  disabled: '选择局域网直连，或添加你自己的中继。',
  configure: '设置连接',
  direct: '同一网络下直连',
  address: '这台电脑的地址',
  port: '直连端口',
  portHint: '填 0 自动选择可用端口；二维码使用实际端口。',
  managed: '直连入口由 Host 的启动参数管理。',
  noAddress: '当前没有可用的局域网地址；可以先配置自建中继。',
  relay: (number: number) => `自建中继 ${number}`,
  removeRelay: (number: number) => `移除自建中继 ${number}`,
  remove: '移除',
  relayUrl: '中继地址',
  relayId: '节点身份',
  spki: 'TLS 公钥指纹',
  providedByOperator: '由中继部署者提供，32 位十六进制。',
  registrationKey: '登记密钥',
  keyKept: '已保存；留空保持原密钥。',
  keyOptional: '私有中继需要；公开注册的节点可以留空。',
  noKey: '这个节点不使用登记密钥',
  addRelay: '添加自建中继',
  relayPrivacy: '新的中继要在 Mac 上确认。中继可看到 IP、连接时间和数据量，无法读取会话正文。',
  intro: '用原生客户端扫描二维码；在 Mac 的系统窗口中输入手机显示的六位码并确认。二维码 10 分钟有效，只能使用一次。',
  steps: [
    '在原生客户端中扫描二维码。',
    '在 Mac 的系统窗口输入手机显示的六位码，并完成身份确认。',
    '完成后在手机验证身份，查看正文与继续工作。',
  ],
  qrAlt: '原生客户端配对二维码',
  qrFailed: '二维码生成失败，可以复制配对信息后粘贴到原生客户端。',
  copy: '复制配对信息',
  addressChanged: '局域网入口当前不可用。请核对地址和端口后重新保存，或通过已配置的中继连接。',
  inputs: '手机输入',
  inputsReady: '手机仍按各自登记的权限操作。暂停不会停止正在执行的会话。',
  paused: '所有原生手机均只读，恢复需要在这台 Mac 上确认。',
  pause: '暂停所有手机输入',
  resume: '恢复手机输入',
  relayStatus: {
    connecting: '正在连接',
    connected: '控制连接已建立；手机仍需独立验证 Host 身份',
    waiting: '连接暂不可用，正在自动重试',
    attention: '中继报告路由冲突，请核对节点配置',
  },
  attention: '需要检查',
  browser: '浏览器配对（自己的 HTTPS 入口）',
  expand: '展开',
  collapse: '收起',
  cancel: '取消',
  save: '保存连接',
  nativeInput: {
    ready: '按登记权限输入',
    paused: '输入已暂停，仅查看',
    'verification-required': '30 天未验证，仅查看；在手机验证后恢复',
    review: '待 Mac 复核，仅查看',
    revoked: '已撤销',
  },
  bodyLocked: '正文已锁定，需在手机验证',
  registeredScopes: (text: string) => `登记权限：${text}`,
  bodyUntil: (time: string) => `正文验证至 ${time}`,
} as const

/**
 * A folder inside Latch's program directory: every Latch 内置 write is high risk (approved only on the computer running
 * Latch) and agents cannot start there. The start directory comes from the start options, so the way out is a project.
 */
export const CODE_ROOT_COPY = {
  badge: '程序目录内',
  notice: '这个文件夹在 Latch 程序目录里：Latch 内置每次写文件都要在运行 Latch 的电脑上批准，其他 Agent 不能在这里开始。',
  startDir: '这是 Host 的启动目录，由启动参数决定。要在别的文件夹里工作，可以新建一个项目。',
  newProject: '新建项目…',
} as const

/** File chips in replies: copying a path, and the desktop app's menu of what the Host allows for that file. */
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
  elsewhere: '在运行 Latch 的 Mac 上用桌面端可以快速查看和打开。',
  /** A desktop shell from before file actions. */
  shellOutdated: '重新启动 Latch 桌面端后，可以在这里快速查看和打开。',
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
  'file-scope': () => ({ text: '这台设备的数据范围不包括会话文件夹中的文件。', tone: 'lock' }),
  'local-only': () => ({ text: LOCAL_ONLY_TEXT, tone: 'lock' }),
  'file-folder': ({ platform }) => ({ text: `这是文件夹；Latch 只${revealWords(platform)}项目的文件夹。`, tone: 'info' }),
  'file-not-regular': () => ({ text: '这不是普通文件。', tone: 'info' }),
  'file-unreadable': () => ({ text: 'Latch 没有读取这个文件的权限。', tone: 'info' }),
  unsupported: () => ({ text: '这台电脑上还不能这样打开文件。', tone: 'info' }),
  'host-outdated': () => ({ text: '重新启动 Host 后可以在这里打开文件。', tone: 'info' }),
  'file-missing': () => ({ text: '找不到这个文件。', tone: 'alert' }),
  'file-invalid': () => ({ text: '这不是有效的文件路径。', tone: 'alert' }),
  'file-changed': () => ({ text: '文件刚刚发生了变化，请重试。', tone: 'alert' }),
  'file-handle-expired': () => ({ text: '文件已不可用，请重新打开。', tone: 'alert' }),
  'file-image-dimensions': () => ({ text: '无法确认图片尺寸，已停止解码。可以下载文件后查看。', tone: 'alert' }),
  'file-handle-foreign': () => ({ text: '文件已不可用，请重新打开。', tone: 'alert' }),
  'open-failed': () => ({ text: '没有找到能打开这个文件的应用。', tone: 'alert' }),
  'task-not-found': () => ({ text: '找不到这个会话。', tone: 'alert' }),
  'audit-unavailable': () => ({ text: '审计记录写入失败，操作没有执行。', tone: 'alert' }),
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
 * Model services: where keys are typed and how an address becomes usable. Keys are typed only in the desktop app on
 * the computer running Latch; a preset provider's HTTPS address and an address confirmed once there take a key
 * directly; any other address is confirmed once (Touch ID or the login password), together with its key and the
 * outbound allowance a local address needs. Every restricted control says why and where to go instead, in words.
 */
export const PROVIDER_COPY = {
  keyHeld: '密钥只保存在运行 Latch 的电脑上，不会返回到浏览器或手机。',
  /** Other devices: the key field becomes this line. */
  keyElsewhere: '密钥只能在运行 Latch 的电脑上用桌面端填写：设置 › 模型服务。',
  /** The desktop without local confirmation, for an address not confirmed yet: the key goes in with the address. */
  keyOffline: (id: string) => `地址确认之前不能在这里填写密钥：停止 Host 后运行 pnpm latch provider set-key ${id}，密钥与地址一起确认。`,
  /** The add form on a device that cannot type keys, for a service that needs one. */
  keyAfterSave: '这个服务需要密钥：保存后，在运行 Latch 的电脑上 设置 › 模型服务 填写密钥，它才能使用。',
  /** A saved service at a preset's address without a key: the Host does not offer it. */
  missingKey: '还没有填写密钥，Latch 不会使用它。',
  missingKeyBadge: '缺密钥',
  missingKeyRow: '还没有填写密钥',
  missingKeyHere: '填写密钥后 Latch 内置才能使用这个服务。',
  missingKeyElsewhere: (name: string) => `在运行 Latch 的电脑上 设置 › 模型服务 › ${name} 填写密钥。`,
  /** The check is a model listing: a service without one is not a failed connection. */
  listingUnavailable: '无法自动检测：这个服务不提供模型列表',
  checkNeedsAddress: '确认地址后才能检测',
  checkNeedsKey: '填写密钥后才能检测',
  enabled: 'Latch 内置可以使用它的模型',
  enabledUnconfirmed: '确认地址后 Latch 内置才能使用它的模型',
  enabledMissingKey: '填写密钥后 Latch 内置才能使用它的模型',
  disabled: '停用后 Latch 内置不能使用它的模型',
  presetKey: '预置服务商的地址：密钥直接保存，不需要确认。',
  /** An address not confirmed yet, on the desktop that can confirm it. */
  firstUse: '第一次使用这个地址：保存时在这台电脑上用 Touch ID 确认一次，之后不再询问。',
  /** The probe met a local or private address: not an error, it is confirmed with the save. */
  localAddress: (target: string) => `这个地址在本机或局域网。确认后 Latch 才会访问它，并允许 Host 访问 ${target}。`,
  localAddressAtSave: (target: string) => `这个地址在本机或局域网。保存时会一并确认，允许 Host 访问 ${target}。`,
  allowAndFetch: '用 Touch ID 允许并获取模型',
  saveWithTouchID: '用 Touch ID 保存',
  confirmAddress: '用 Touch ID 确认地址',
  waitingTouchID: '等待 Touch ID…',
  save: '保存服务',
  unconfirmed: '这个服务的地址还没有确认，Latch 不会使用它。',
  unconfirmedBadge: '未确认',
  unconfirmedRow: '需要在运行 Latch 的电脑上确认这个地址',
  /** Other devices: where the address is confirmed. */
  confirmElsewhere: (name: string) => `需要在运行 Latch 的电脑上确认这个地址：设置 › 模型服务 › ${name}。`,
  /** The desktop without local confirmation (Linux, Windows): the offline command. */
  confirmOffline: (id: string) =>
    `这台电脑不能用 Touch ID 或登录密码确认。停止 Host 后运行 pnpm latch provider confirm ${id}（或用 set-key 同时保存密钥），再启动 Host。`,
  confirmOfflineNew: '这台电脑不能用 Touch ID 或登录密码确认。先不填密钥保存，再停止 Host，运行 pnpm latch provider confirm <服务 ID>。',
  /** A Mac whose confirmation component needs fixing (rebuilt, signature lost): the Host's own reason, with its fix. */
  presenceBroken: (message: string) => `这台电脑的本机确认暂时不可用：${message}`,
  savedUnconfirmed: '保存后它会显示在列表里，等你在运行 Latch 的电脑上确认地址。',
  /** A confirmed address whose outbound allowance was removed in Settings › 电脑. */
  allowAgain: (target: string) => `用 Touch ID 允许访问 ${target}`,
  allowElsewhere: '需要在运行 Latch 的电脑上允许这个地址：设置 › 电脑 › 出站白名单。',
  confirmedAddressesTitle: '已确认的模型服务地址',
  confirmedAddressesCaption: '自定义与本机模型服务的地址（含路径）在这台电脑上确认一次后才能使用。移除后，使用它的服务随即停止。',
  confirmedAddressesEmpty: '没有已确认的地址',
  confirmedAddressesEmptyNote: '预置服务商的地址不需要确认；在 设置 › 模型服务 添加自定义或本机服务时确认。',
  confirmedAddressRow: '模型服务可以使用这个地址',
} as const

/** Session banners for a session that no longer accepts input. */
export const SESSION_STOP_TEXT = {
  'permission-drift': '检测到权限模式变化，本轮已取消，挂起的询问已拒绝。该会话不再接受输入，请新建会话。',
  'agent-definition-changed': 'Agent 定义已变化，该会话不能继续。请新建会话。',
  'project-config-changed': '项目中的 Agent 配置在确认后发生了变化，该会话不能继续。请新建会话。',
  'l3-confirmation-missing': '此会话创建于安全升级之前，不能继续。请新建会话。',
  'permission-unverified': '无法确认 Harness 已进入预期的权限模式，未发送本轮输入。',
} as const
export type SessionStopCode = keyof typeof SESSION_STOP_TEXT
export const isSessionStopCode = (code: string): code is SessionStopCode => code in SESSION_STOP_TEXT

const FIXED: Record<string, string> = {
  'file-image-dimensions': fileNote('file-image-dimensions').text,
  'file-too-large': '文件或图片超过这台设备的预览上限，请在执行端电脑上查看。',
  unauthorized: '请先在本机确认这台设备',
  'renewal-required': '设备凭据需要续期',
  'credential-expired': ENROLLMENT_REASON_TEXT['credential-expired']!,
  'device-revoked': ENROLLMENT_REASON_TEXT['device-revoked']!,
  'listener-mismatch': ENROLLMENT_REASON_TEXT['listener-mismatch']!,
  'legacy-reconfirm': '此设备需要在本机重新确认',
  'local-only': LOCAL_ONLY_TEXT,
  'ceiling-exceeded': '超出此设备可用的权限上限',
  'policy-changed': '安全策略刚被修改过，这次更改没有应用。请查看最新的设置后重试。',
  'presence-unavailable': '本机确认不可用',
  'origin-unconfirmed':
    '这个模型服务的地址还没有确认，Latch 不会向它发送请求。请在运行 Latch 的电脑上，打开 设置 › 模型服务 确认这个地址。',
  'presence-busy': '本机正在等待另一项确认，请先完成或取消',
  'presence-blocked': '要等运行 Latch 的电脑上的完全访问会话结束，才能完成这一步。它结束后再试一次。',
  'confirmation-not-found': '找不到该确认',
  'confirmation-pending': '本机尚未确认',
  'confirmation-denied': '本机拒绝了此操作。',
  'confirmation-expired': '本机确认已超时，请重试',
  'confirmation-mismatch': '确认内容与本次请求不一致，请重新确认',
  'confirmation-used': '该确认已使用',
  'confirmation-cancelled': '确认已取消，操作未执行。',
  'confirmation-os-required': '这项操作需要系统认证，请重新发起确认。',
  'confirmation-signature-invalid': '本机确认回执无效，操作未执行。',
  'confirmation-shell-unavailable': '请在新版 Latch 桌面端完成这次本机确认。',
  'confirmation-failed': '本机确认组件出错，操作未执行。',
  'enrollment-denied': '本机拒绝了此设备。',
  'enrollment-not-found': '找不到该登记请求',
  'enrollment-pending': '本机尚未确认',
  'enrollment-completed': '该登记已完成',
  'enrollment-expired': '登记请求已超时，请重新提交',
  'enrollment-cancelled': '登记已取消。',
  'invitation-required': '新设备需要一次性邀请：请在运行 Latch 的电脑上用 Latch 桌面端生成',
  'invitation-invalid': '配对码无效或已过期',
  'offline-code-invalid': '离线登记码无效或已过期',
  'permission-drift': SESSION_STOP_TEXT['permission-drift'],
  'permission-unverified': SESSION_STOP_TEXT['permission-unverified'],
  'agent-definition-changed': SESSION_STOP_TEXT['agent-definition-changed'],
  'project-config-changed': SESSION_STOP_TEXT['project-config-changed'],
  'l3-confirmation-missing': '此会话没有经过本机确认，不能继续。请新建会话（需要本机确认）。',
  'approval-settled': '该审批已结束',
  // Answered by the desktop shell's main process, not the Host.
  'fingerprint-mismatch': '服务器返回的指纹与本机计算的不一致，已停止登记。',
  'host-unavailable': '无法连接本机的 Latch Host，请确认它仍在运行。',
  'credential-store-failed': '无法安全保存设备凭据，登记未完成。',
  'browser-open-unsupported': '此系统上不能从桌面端直接打开浏览器，请运行 pnpm latch device invite --loopback。',
  'browser-open-failed': '无法在浏览器中打开 Latch，请重试。',
  'native-not-configured': '请先在 设置 › 设备 › 连接手机 中设置连接方式。',
  'native-config-changed': '手机连接配置已变化。请重新打开设置连接，再核对后保存。',
  'native-relay-duplicate': '每个中继节点只能添加一次。',
  'native-managed': '直连入口由启动参数管理，需要停止 Host 后修改参数。',
  'native-address-unavailable': '原来的局域网地址已不可用，请重新选择当前地址。',
  'native-listener-unavailable': '无法启用所选地址或端口，请核对网络后重试。',
  'native-not-ready': '手机连接服务正在准备，请稍后重试。',
  'native-verification-required': '请先在手机完成身份验证，再查看正文或操作。',
}

/** Prefix families in the catalog; an unlisted member still never shows server text. */
const FAMILY_FALLBACK: Array<[prefix: string, text: string]> = [
  ['presence-', '本机确认暂时不可用，请稍后重试'],
  ['confirmation-', '本机确认未完成，操作未执行'],
  ['enrollment-', '登记未完成，请重新提交'],
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

const scopeLabel = (scope: unknown) =>
  typeof scope === 'string' && Object.hasOwn(SCOPE_LABELS, scope) ? SCOPE_LABELS[scope as DeviceScope] : undefined
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
    case 'scope-required': {
      const label = scopeLabel(details.required)
      return label ? `此设备没有「${label}」权限` : '此设备没有执行此操作的权限'
    }
    case 'stepup-required':
      return details.stepup?.where === 'host-desktop' ? HOST_DESKTOP_TEXT : '需要在本机确认'
    case 'presence-cooldown': {
      const wait = seconds(details.retryAfter)
      return `本机确认连续被拒绝 3 次，请 ${wait === undefined ? 5 : Math.max(1, Math.ceil(wait / 60))} 分钟后再试`
    }
    case 'egress-denied': {
      const target = safeTarget(details.target)
      return `Host 不会访问${target === undefined ? '该地址' : ` ${target}`}：这是本机、局域网或云元数据地址。本机与局域网地址要在运行 Latch 的电脑上确认后才能使用。`
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
