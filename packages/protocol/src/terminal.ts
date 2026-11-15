/** The most terminals one session keeps open. */
export const TERMINALS_PER_SESSION = 8

/**
 * Where a Harness's login runs when no session is in view (设置, a new session's draft): addressed like a session's
 * terminals, but no session has this ID and nothing opens under it except a login command.
 */
export const HARNESS_LOGIN_SESSION = 'harness-login'

export interface LocalService {
  /** `http://localhost:5173`: scheme, host and port only, so a token in the path or query never travels with it. */
  origin: string
  port: number
}

export interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalSummary {
  id: string
  sessionId: string
  /** The shell's name and the folder's, for the tab: 「zsh · latch」. */
  shell: string
  folder: string
  cols: number
  rows: number
  status: 'running' | 'exited' | 'failed'
  exitCode?: number
  exitSignal?: string
  /** A program other than the shell has the terminal: closing asks first. */
  busy: boolean
  /** That program's name, when the system reports one. */
  foreground?: string
  /** Development servers the output announced, newest first. */
  services: LocalService[]
  /** The requester decides this terminal's size. */
  sizeOwner: boolean
  createdAt: string
  /** Runs this Harness's own login command instead of a plain shell, and ends when the command does. */
  login?: { harnessId: string; name: string }
}

/**
 * `POST /link/api/harnesses/:id/login-terminal`. With `terminal`, the login runs in a Latch terminal: the session's, or
 * with no `sessionId` one under `HARNESS_LOGIN_SESSION`. Without it, in this computer's default terminal app.
 */
export interface HarnessLoginTerminalRequest {
  /** One of the logins the harness advertised; absent for the preset's own command. */
  method?: string
  terminal?: TerminalSize & { sessionId?: string }
}

export interface HarnessLoginTerminalResponse {
  opened: true
  /** The Latch terminal the command runs in. */
  terminal?: TerminalSummary
}

/** `GET /link/api/tasks/:id/terminals` */
export interface TerminalListResponse {
  terminals: TerminalSummary[]
}

/** `POST /link/api/tasks/:id/terminals` and `POST …/terminals/:terminalId/resize` */
export interface TerminalResponse {
  terminal: TerminalSummary
}

/** `POST …/terminals/:terminalId/input`: `data` is base64, at most 64 KiB once decoded. */
export interface TerminalInputRequest {
  data: string
}

/** `POST …/terminals/:terminalId/close`: `force` only after the user confirmed closing a busy terminal. */
export interface TerminalCloseRequest {
  force?: boolean
}

/** `POST …/terminals/:terminalId/attach`: the selection, or else the last `lines` of the output. */
export interface TerminalAttachRequest {
  lines?: number
  selection?: string
}

/** The answer to attach. Nothing is attached by this: the client shows `text` first, and sends it only if the user does. */
export interface TerminalText {
  text: string
  lines: number
  /** Older lines or characters were left out to stay within the limits. */
  truncated: boolean
  /** Something was replaced because it holds or looks like a secret. */
  redacted: boolean
  /**
   * Something was replaced, or the text still looks risky. Redaction is best effort: the client shows the exact text
   * before it is attached, and warns on this. It blocks nothing.
   */
  mayContainSecret: boolean
}

/**
 * The events of `GET …/terminals/:terminalId/stream[?from=<offset>]`, by SSE event name. `terminal` comes first and again
 * after the output printed before each change. `closed` is last: the terminal was closed or the Host stops. A stream that
 * ends without it was cut, and the client reconnects with `from` set to the end of the last output.
 */
export interface TerminalStreamEvents {
  terminal: TerminalSummary
  /** `offset` is where `data` (base64) starts in everything the terminal printed. */
  output: { offset: number; data: string }
  /** Output before `offset` is no longer kept: the reader clears its screen and continues from there. */
  reset: { offset: number }
  closed: Record<string, never>
}
