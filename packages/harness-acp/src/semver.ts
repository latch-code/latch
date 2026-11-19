/** Semantic-version order for the versions Harness commands print; no I/O, so wires can use it. */
/** `1.2.3`, `0.2.1-rc.1`: numeric core, then an optional pre-release. Undefined for anything else. */
function parse(version: string): { core: number[]; pre: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version.trim())
  if (!match) return undefined
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

/** Semantic-version order, pre-releases before their release; undefined when either is not a version. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return undefined
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/u.test(x) ? Number(x) : undefined
    const ny = /^\d+$/u.test(y) ? Number(y) : undefined
    if (nx !== undefined && ny !== undefined) return nx < ny ? -1 : 1
    if (nx !== undefined) return -1
    if (ny !== undefined) return 1
    return x < y ? -1 : 1
  }
  return 0
}
