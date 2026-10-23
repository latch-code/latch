/**
 * How Latch drives one harness's own permission settings. Host-only: none of this reaches the browser except the
 * display fields copied into `SessionPermission`. A profile narrows what the harness does by default; it is not an OS
 * sandbox, so every ACP session stays full access (L3).
 */
export interface AcpPermissionProfile {
  /** Whether the harness asks before running tools at all. */
  approvals: 'prompts' | 'none'
  /** Applied after the definition's own variables, so a definition cannot override them. */
  defaultEnv: Record<string, string>
  /** Mode the session must report before every prompt. */
  expectedMode?: string
  /** Strictest → widest. Modes outside the ladder count as wider. */
  modeLadder?: readonly string[]
  /** Modes where a model approves on the user's behalf; never offered. */
  forbiddenModes?: readonly string[]
  /** Permission option IDs never shown; exact IDs, or prefixes ending in '*'. */
  hiddenOptionIds?: readonly string[]
  /** Whether the harness reports its mode so Latch can read it back. */
  readback: 'mode' | 'none'
  /** `pattern` is a RegExp source tested against `initialize.agentInfo.version`. */
  versionRule?: { pattern: string; message: string }
  /** Gemini only: written to a Host file whose path is passed in the environment. */
  systemSettings?: Record<string, unknown>
  /**
   * Definition variables that change where the harness reads configuration Latch cannot override: exact names, or
   * prefixes ending in '*', compared case-insensitively. A definition that sets one is not verified.
   */
  configEnv?: readonly string[]
  /** Chinese display notes. */
  notes: string[]
}

/** What the harness itself writes below its `projectConfigPaths` when it starts, so that is not a change. */
export interface ProjectConfigManaged {
  /** Paths relative to the directory holding the entry (`.opencode/node_modules`), left out with everything below them. */
  skip?: readonly string[]
  /** Files compared after `reduce` removes what the harness adds; `undefined` leaves the file out. */
  reduce?: Readonly<Record<string, (text: string) => unknown>>
}

export interface HarnessProfile {
  /** Equals `AgentPreset.id`. */
  readonly presetId: string
  /** Part of the launch fingerprint; bump it when the profile's behaviour changes. */
  readonly version: 1
  readonly permission: AcpPermissionProfile
  /**
   * Files or directories the harness loads as configuration when it finds them in the session directory or a
   * directory above it. Their contents are part of the launch fingerprint; a directory counts with everything below it.
   */
  readonly projectConfigPaths?: readonly string[]
  readonly projectConfigManaged?: ProjectConfigManaged
  /** Host-only files the agent needs before spawn (e.g. Gemini system settings). Returns env entries to add. */
  materialize?(input: { dataDir: string }): Promise<Record<string, string>>
}
