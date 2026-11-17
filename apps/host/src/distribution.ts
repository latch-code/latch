/** Replaced only by the application build; never read from user settings or the process environment. */
declare const __LATCH_PACKAGED__: boolean
export const PACKAGED = typeof __LATCH_PACKAGED__ !== 'undefined' && __LATCH_PACKAGED__

export const CLI_PROGRAM = PACKAGED ? 'latch' : 'pnpm latch'

export function cliStopCommand(program = CLI_PROGRAM): string {
  return program === 'latch' ? 'latch stop' : 'pnpm stop'
}
