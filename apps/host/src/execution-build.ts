import { canonicalJson, sha256Hex } from '@latch/core/node-kit'

declare const __LATCH_EXECUTION_BUILD__: string | undefined
/** Present only in a Host bundle whose build read the execution sources and pinned dependency manifest. */
export function executionBuildRevision(config: unknown): string | undefined {
  return typeof __LATCH_EXECUTION_BUILD__ === 'string' ? sha256Hex(canonicalJson([__LATCH_EXECUTION_BUILD__, config])) : undefined
}
