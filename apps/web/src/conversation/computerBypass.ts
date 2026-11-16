/**
 * Whether a shell command runs Cua Driver past 「操控这台 Mac」: `cua-driver …` (its CLI calls tools directly), `cua do`
 * or `cua mcp`. Such a call skips Latch's switches, checks and record. Display only: the row is marked, nothing is
 * stopped (docs/MCP.md).
 */
export function bypassesComputer(command: string | undefined): boolean {
  if (!command) return false
  return /(^|[\s;&|()`'"/])cua-driver(\s|$|['";&|)])/u.test(command) || /(^|[\s;&|()`'"/])cua\s+(?:do|mcp)(\s|$)/u.test(command)
}
