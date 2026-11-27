import { BUILTIN_HARNESS_LABEL, type HarnessInfo } from '@latch/protocol'
import { defineCopy } from './i18n.ts'

const COPY = defineCopy({ builtin: BUILTIN_HARNESS_LABEL }, { builtin: 'Built-in Latch' })

export function harnessName(harness: Pick<HarnessInfo, 'capabilities'>): string {
  const { display } = harness.capabilities
  // The Host reserves the Latch mark for its built-in Harness.
  return display.mark === 'latch' && display.label === BUILTIN_HARNESS_LABEL ? COPY.builtin : display.label
}

/** Read the saved alias of a name printed under its preset's brand. */
export function harnessAccountAlias(name: string, presetName: string): string | undefined {
  const prefix = `${presetName} · `
  return name.startsWith(prefix) ? name.slice(prefix.length) : undefined
}
