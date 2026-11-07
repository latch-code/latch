import { BUILTIN_HARNESS_LABEL, escapeSecurityText, isHarnessMark, type HarnessCapabilities, type ModelWire } from '@latch/protocol'
import type { HarnessDeclaration } from '@latch/sdk'

/** Who a driver is, from which plugin registered it; a driver cannot say this about itself. */
export type HarnessKind = 'builtin' | 'acp' | 'plugin'

export interface HarnessTrust {
  kind: HarnessKind
  /** L1: Latch decides each risky call. L3: it runs unsandboxed. */
  level: 'L1' | 'L3'
  enforcement: HarnessCapabilities['permission']['enforcement']
}

const WIRES = new Set<unknown>(['chat-completions', 'responses', 'anthropic-messages', 'gemini'] satisfies ModelWire[])
const CATALOGUES = new Set<unknown>(['live', 'session-check', 'none'])
const LABEL_MAX = 80
/** Width, case, spacing and invisible characters are what a look-alike name would differ by. */
const lookalike = (label: string) =>
  label
    .normalize('NFKC')
    .replace(/[\s\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, '')
    .toLowerCase()

/** The name as a client may show it: visible, bounded, and not the built-in harness's unless this is it. */
function label(declared: unknown, name: string, kind: HarnessKind): string {
  const raw = (typeof declared === 'string' && declared.trim() ? declared : name).trim()
  const text = [...escapeSecurityText(raw)].slice(0, LABEL_MAX).join('')
  return kind !== 'builtin' && lookalike(raw) === lookalike(BUILTIN_HARNESS_LABEL) ? `${text}（非内置）` : text
}

function mark(declared: unknown, kind: HarnessKind): string | undefined {
  if (kind === 'builtin') return isHarnessMark(declared) ? declared : undefined
  if (declared !== 'latch' && isHarnessMark(declared)) return declared
  return kind === 'plugin' ? 'plugin' : undefined
}

/**
 * What a driver declared, as clients are told it. What it left out takes the weakest value. Statements to the person
 * about what is safe are not the described party's to make: `enforcement: 'latch'`, `shell: false` and the built-in
 * harness's name and icon hold only for the built-in driver, whatever another one declares.
 */
export function harnessFacts(declared: HarnessDeclaration | undefined, name: string, kind: HarnessKind): HarnessCapabilities {
  const models = declared?.models
  const permission = declared?.permission
  const shown = mark(declared?.display?.mark, kind)
  const enforcement = permission?.enforcement
  return {
    models: {
      owner: models?.owner === 'latch' ? 'latch' : 'harness',
      catalogue: CATALOGUES.has(models?.catalogue) ? models!.catalogue! : 'none',
      wires: Array.isArray(models?.wires) ? [...new Set(models.wires.filter(wire => WIRES.has(wire)))] : [],
      ...(models?.experimental === true ? { experimental: true as const } : {}),
      ...(models?.knownOnly === true ? { knownOnly: true as const } : {}),
    },
    permission: {
      enforcement: enforcement === 'latch' ? (kind === 'builtin' ? 'latch' : 'harness') : enforcement === 'harness' ? 'harness' : 'none',
      rejectionNote: permission?.rejectionNote === true,
    },
    tools: { shell: kind !== 'builtin' || declared?.tools?.shell !== false, fileMentions: declared?.tools?.fileMentions === true },
    display: { label: label(declared?.display?.label, name, kind), ...(shown ? { mark: shown } : {}) },
    ...(declared?.fork === 'native' ? { fork: 'native' as const } : {}),
  }
}

/** A session's level follows from who enforces, so that no driver can reach L1 by saying so. */
export const trustOf = (kind: HarnessKind, capabilities: HarnessCapabilities): HarnessTrust => {
  const { enforcement } = capabilities.permission
  return { kind, level: enforcement === 'latch' ? 'L1' : 'L3', enforcement }
}
