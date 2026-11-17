/** The Host's settings in the environment, without their `LATCH_` prefix. */
export const HOST_ENV_NAMES = [
  'DATA_DIR',
  'WORKSPACE',
  'AGENTS_DIR',
  'WORKTREES_DIR',
  'PORT',
  'BASE_URL',
  'MODEL',
  'API_KEY',
  'TLS_CERT',
  'TLS_KEY',
  'TLS_HOST',
  'TLS_PORT',
  'PUBLIC_ORIGIN',
] as const

/** Every variable Latch reads through `latchEnv`: the Host's settings and the test runner's own switches. */
type LatchEnvName =
  | (typeof HOST_ENV_NAMES)[number]
  | 'BROWSER_PATH'
  | 'E2E_UI_DIR'
  | 'ELECTRON_E2E'
  | 'E2E_CLIPBOARD'
  | 'E2E_SIMULATOR'
  | 'E2E_LIVE_DEVICE'

/** `LATCH_<name>`. An empty value counts as set: callers decide what an empty value means. */
export function latchEnv(env: NodeJS.ProcessEnv, name: LatchEnvName): string | undefined {
  return env[`LATCH_${name}`]
}
