import { readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isSecurityErrorCode } from '@latch/protocol'
import { parseAst } from 'vite'

/** Where the Host's `AppError` codes are thrown. */
const SCOPE = ['apps/host/src', 'packages/core/src', 'packages/harness-acp/src'] as const
/** The page's error catalogue: the tables and the switch `describeFailure` reads. */
const CATALOG_FILE = 'apps/web/src/core/securityCopy.ts'
const CATALOG_TABLES = ['FIXED', 'EXTRA_FAILURES', 'FIXED_SHARED', 'HOST_REFUSALS'] as const
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/u
const DECLARATION = /\.d\.[cm]?ts$/u
/**
 * `AppError` sites that pass on a code thrown elsewhere, by file and the code's expression: a stored failure, a
 * re-wrapped error, a model service's own code, the board tags' check. Any other site this scan cannot name fails it.
 */
export const PASSED_ON: Readonly<Record<string, readonly string[]>> = {
  'apps/host/src/attachment-uploads.ts': ['failed.code'],
  'apps/host/src/config-requests.ts': ['error.code'],
  'apps/host/src/routes/work-proposals.ts': ['normalized.problem'],
  'apps/host/src/server.ts': ['code'],
  'packages/core/src/runtime.ts': ['error.code'],
  'packages/harness-acp/src/runtime.ts': ['error.code'],
}
const CODE = /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*$/u

type Node = { type: string; start: number; [field: string]: unknown }
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
const TYPE_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'])
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

const parse = (path: string, source: string) => parseAst(source, { lang: path.endsWith('x') ? 'tsx' : 'ts' }) as unknown as Node
const unwrap = (node: unknown): unknown => (isNode(node) && TYPE_WRAPPERS.has(node.type) ? unwrap(node.expression) : node)
const lineOf = (source: string, node: Node) => source.slice(0, node.start).split('\n').length

function children(node: Node): unknown[] {
  return Object.entries(node).flatMap(([field, child]) =>
    field === 'typeAnnotation' || field === 'returnType' || field === 'typeArguments' || field === 'typeParameters'
      ? []
      : Array.isArray(child)
        ? child
        : [child],
  )
}

/**
 * The codes a table of refusals holds: each `{ code: '…' }`, and each `['<code>', '<message>', …]` row whose second
 * element is the message.
 */
function tableCodes(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) for (const item of node) tableCodes(item, found)
  else if (isNode(node)) {
    if (node.type === 'Property' && isNode(node.key) && (node.key.name ?? node.key.value) === 'code') {
      const value = unwrap(node.value)
      if (isNode(value) && typeof value.value === 'string' && CODE.test(value.value)) found.add(value.value)
    }
    if (node.type === 'ArrayExpression') {
      const [first, second] = (node.elements as unknown[]).map(unwrap)
      const message =
        isNode(second) && (second.type === 'TemplateLiteral' || (second.type === 'Literal' && typeof second.value === 'string'))
      if (message && isNode(first) && typeof first.value === 'string' && CODE.test(first.value)) found.add(first.value)
    }
    for (const child of children(node)) tableCodes(child, found)
  }
  return found
}

/** The keys of an object literal. */
function objectKeys(node: unknown): string[] {
  const object = unwrap(node)
  if (!isNode(object) || object.type !== 'ObjectExpression') return []
  return (object.properties as Node[]).flatMap(property => {
    const key = isNode(property.key) ? (property.key.value ?? property.key.name) : undefined
    return typeof key === 'string' && CODE.test(key) ? [key] : []
  })
}

interface FunctionScope {
  name: string | undefined
  params: string[]
  body: unknown
}

/**
 * Functions that pass one of their parameters on as an `AppError` code, such as `refuse(code, message)`: by
 * `<file>#<name>`, with the parameter's index.
 */
type Wrappers = Map<string, Set<number>>

interface FileCodes {
  codes: Array<{ code: string; line: number }>
  /** `AppError` sites whose code this scan cannot name, by line and the code's expression. */
  unresolved: Array<{ line: number; expression: string }>
}

function scanFile(
  path: string,
  source: string,
  wrappers: Wrappers,
  imported: ReadonlySet<string>,
  exported: ReadonlyMap<string, readonly string[]>,
): { result: FileCodes; grew: boolean } {
  const ast = parse(path, source)
  const consts = new Map<string, unknown>()
  const local = new Set<string>()
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(collect)
    if (!isNode(node)) return
    if (node.type === 'VariableDeclarator' && isNode(node.id) && typeof node.id.name === 'string') {
      consts.set(node.id.name, node.init)
      if (FUNCTIONS.has((unwrap(node.init) as Node | undefined)?.type ?? '')) local.add(node.id.name)
    }
    if (node.type === 'FunctionDeclaration' && isNode(node.id) && typeof node.id.name === 'string') local.add(node.id.name)
    for (const child of children(node)) collect(child)
  }
  collect(ast)

  const result: FileCodes = { codes: [], unresolved: [] }
  let grew = false
  const stack: FunctionScope[] = []

  /** The codes an expression can be, or `undefined` when this scan cannot tell. */
  const resolve = (value: unknown, at: Node, seen: Set<string> = new Set()): string[] | undefined => {
    const node = unwrap(value)
    if (!isNode(node)) return undefined
    if (node.type === 'Literal') return typeof node.value === 'string' && CODE.test(node.value) ? [node.value] : undefined
    if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0) {
      const cooked = ((node.quasis as Node[])[0]?.value as { cooked?: string } | undefined)?.cooked
      return cooked !== undefined && CODE.test(cooked) ? [cooked] : undefined
    }
    if (node.type === 'ConditionalExpression') {
      const a = resolve(node.consequent, at, seen)
      const b = resolve(node.alternate, at, seen)
      return a && b ? [...a, ...b] : undefined
    }
    if (node.type === 'LogicalExpression') {
      const a = resolve(node.left, at, seen)
      const b = resolve(node.right, at, seen)
      return a && b ? [...a, ...b] : undefined
    }
    if (node.type === 'Identifier' && typeof node.name === 'string') {
      const keyed = indexedTable(node)
      if (keyed) return keyed
      const scope = stack.findLast(item => item.params.includes(node.name as string))
      if (scope) {
        if (scope.name === undefined) return undefined
        const index = scope.params.indexOf(node.name)
        const key = `${path}#${scope.name}`
        const known = wrappers.get(key) ?? new Set<number>()
        if (!known.has(index)) {
          known.add(index)
          wrappers.set(key, known)
          grew = true
        }
        return []
      }
      if (consts.has(node.name) && !seen.has(node.name)) {
        seen.add(node.name)
        const init = consts.get(node.name)
        const direct = resolve(init, at, seen)
        if (direct) return direct
        const table = tableCodes(init)
        return table.size > 0 ? [...table] : undefined
      }
      return undefined
    }
    if (node.type === 'MemberExpression') {
      const keyed = indexedTable(node)
      if (keyed) return keyed
      // `failure.code` after `const failure = STATUS_CODE[status]`: the table the chain starts from.
      let root: unknown = node
      const followed = new Set<string>()
      for (;;) {
        while (isNode(root) && root.type === 'MemberExpression') root = unwrap(root.object)
        if (!isNode(root) || root.type !== 'Identifier' || typeof root.name !== 'string' || followed.has(root.name)) break
        followed.add(root.name)
        const init = unwrap(consts.get(root.name))
        if (isNode(init) && (init.type === 'MemberExpression' || init.type === 'Identifier')) root = init
        else {
          const table = tableCodes(init)
          return table.size > 0 ? [...table] : undefined
        }
      }
    }
    return undefined
  }

  /**
   * A code that indexes a table of this file in the same function, as `EDIT_REFUSALS[code].message` does: the table's
   * keys are every code it can be.
   */
  const indexedTable = (code: Node): string[] | undefined => {
    const text = source.slice(code.start, code.end as number)
    let keys: string[] | undefined
    const search = (value: unknown): void => {
      if (keys || (!isNode(value) && !Array.isArray(value))) return
      if (Array.isArray(value)) return void value.forEach(search)
      const node = value as Node
      if (node.type === 'MemberExpression' && node.computed && isNode(node.property)) {
        const property = unwrap(node.property) as Node
        const object = unwrap(node.object)
        if (
          source.slice(property.start, property.end as number) === text
          && isNode(object)
          && object.type === 'Identifier'
          && typeof object.name === 'string'
        ) {
          const found = objectKeys(consts.get(object.name))
          if (found.length > 0) keys = found
        }
      }
      for (const child of children(node)) search(child)
    }
    search(stack.at(-1)?.body ?? ast)
    return keys
  }

  const record = (value: unknown, at: Node) => {
    const codes = resolve(value, at)
    const node = unwrap(value)
    if (codes === undefined)
      result.unresolved.push({ line: lineOf(source, at), expression: isNode(node) ? source.slice(node.start, node.end as number) : '' })
    else for (const code of codes) result.codes.push({ code, line: lineOf(source, at) })
  }

  const paramNames = (node: Node) =>
    (Array.isArray(node.params) ? node.params : []).map(param => {
      const inner = isNode(param) && param.type === 'AssignmentPattern' ? param.left : param
      return isNode(inner) && typeof inner.name === 'string' ? inner.name : ''
    })

  const visit = (value: unknown, name?: string): void => {
    if (Array.isArray(value)) return void value.forEach(item => visit(item))
    if (!isNode(value)) return
    if (FUNCTIONS.has(value.type)) {
      const own = value.type === 'FunctionDeclaration' && isNode(value.id) ? (value.id.name as string) : name
      stack.push({ name: own, params: paramNames(value), body: value.body })
      visit(value.body)
      stack.pop()
      return
    }
    if (value.type === 'VariableDeclarator' && isNode(value.id) && typeof value.id.name === 'string') {
      visit(unwrap(value.init), value.id.name)
      return
    }
    if (value.type === 'NewExpression' && isNode(value.callee) && value.callee.name === 'AppError') {
      record((value.arguments as unknown[])[1], value)
    } else if (value.type === 'CallExpression' && isNode(value.callee) && typeof value.callee.name === 'string') {
      const callee = value.callee.name
      // A local function by this file's name for it; an imported one by the files that export that name.
      const keys = local.has(callee)
        ? [`${path}#${callee}`]
        : imported.has(callee)
          ? (exported.get(callee) ?? []).map(file => `${file}#${callee}`)
          : []
      const indexes = new Set(keys.flatMap(key => [...(wrappers.get(key) ?? [])]))
      for (const index of indexes) record((value.arguments as unknown[])[index], value)
    }
    for (const child of children(value)) visit(child)
  }
  visit(ast)
  return { result, grew }
}

/** The names a file imports, and the functions it exports by name. */
function moduleNames(path: string, source: string): { imported: Set<string>; exported: Set<string> } {
  const imported = new Set<string>()
  const exported = new Set<string>()
  for (const node of (parse(path, source).body as Node[] | undefined) ?? []) {
    if (node.type === 'ImportDeclaration')
      for (const specifier of (node.specifiers as Node[] | undefined) ?? [])
        if (isNode(specifier.local) && typeof specifier.local.name === 'string') imported.add(specifier.local.name)
    const declaration = node.type === 'ExportNamedDeclaration' && isNode(node.declaration) ? node.declaration : undefined
    if (declaration?.type === 'FunctionDeclaration' && isNode(declaration.id)) exported.add(declaration.id.name as string)
    if (declaration?.type === 'VariableDeclaration')
      for (const item of declaration.declarations as Node[]) if (isNode(item.id)) exported.add(item.id.name as string)
  }
  return { imported, exported }
}

async function sourcesUnder(root: string, directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = posix.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourcesUnder(root, path)))
    else if (entry.isFile() && SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) files.push(path)
  }
  return files
}

/** Every `AppError` code thrown in these sources, with where; wrappers such as `refuse(code, …)` are followed. */
export function appErrorCodes(files: Readonly<Record<string, string>>): {
  codes: Map<string, string[]>
  unresolved: Array<{ where: string; expression: string }>
} {
  const wrappers: Wrappers = new Map()
  const names = new Map(Object.entries(files).map(([path, source]) => [path, moduleNames(path, source)]))
  const exported = new Map<string, string[]>()
  for (const [path, { exported: own }] of names) for (const name of own) exported.set(name, [...(exported.get(name) ?? []), path])
  let results = new Map<string, FileCodes>()
  // A wrapper found in one file can make a call in another (or earlier in the same file) a code site: repeat until stable.
  for (let pass = 0; pass < 10; pass++) {
    let grew = false
    results = new Map()
    for (const [path, source] of Object.entries(files)) {
      const scanned = scanFile(path, source, wrappers, names.get(path)!.imported, exported)
      results.set(path, scanned.result)
      grew ||= scanned.grew
    }
    if (!grew) break
  }
  const codes = new Map<string, string[]>()
  const unresolved: Array<{ where: string; expression: string }> = []
  for (const [path, { codes: found, unresolved: sites }] of results) {
    for (const { code, line } of found) codes.set(code, [...(codes.get(code) ?? []), `${path}:${line}`])
    for (const { line, expression } of sites) unresolved.push({ where: `${path}:${line}`, expression })
  }
  return { codes, unresolved }
}

/** The codes the page words from its catalogue: the tables' keys, `describeFailure`'s cases and the prefix families. */
export function catalogCodes(source: string): { codes: Set<string>; prefixes: string[] } {
  const ast = parse(CATALOG_FILE, source)
  const codes = new Set<string>()
  const prefixes: string[] = []
  const tables = new Set<string>()
  const keysOf = (node: unknown) => {
    const object = unwrap(node)
    if (!isNode(object) || object.type !== 'ObjectExpression') return
    for (const property of object.properties as Node[]) {
      const key = isNode(property.key) ? (property.key.value ?? property.key.name) : undefined
      if (typeof key === 'string') codes.add(key)
    }
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(visit)
    if (!isNode(value)) return
    if (value.type === 'VariableDeclarator' && isNode(value.id) && typeof value.id.name === 'string') {
      const name = value.id.name
      const init = unwrap(value.init)
      if ((CATALOG_TABLES as readonly string[]).includes(name) && isNode(init)) {
        tables.add(name)
        // `defineCopy(zh, en)`: the Chinese table names every key.
        keysOf(init.type === 'CallExpression' ? (init.arguments as unknown[])[0] : init)
      }
      if (name === 'FAMILY_FALLBACK' && isNode(init) && init.type === 'ArrayExpression')
        for (const row of init.elements as Node[]) {
          const prefix = unwrap((row.elements as unknown[] | undefined)?.[0])
          if (isNode(prefix) && typeof prefix.value === 'string') prefixes.push(prefix.value)
        }
    }
    if (value.type === 'FunctionDeclaration' && isNode(value.id) && value.id.name === 'describeFailure') {
      const cases = (node: unknown): void => {
        if (Array.isArray(node)) return void node.forEach(cases)
        if (!isNode(node)) return
        if (node.type === 'SwitchCase' && isNode(node.test) && typeof node.test.value === 'string') codes.add(node.test.value)
        for (const child of children(node)) cases(child)
      }
      cases(value.body)
    }
    for (const child of children(value)) visit(child)
  }
  visit(ast)
  const missing = CATALOG_TABLES.filter(name => !tables.has(name))
  if (missing.length > 0 || prefixes.length === 0)
    throw new Error(`${CATALOG_FILE} 里找不到错误文案表：${missing.join('、') || 'FAMILY_FALLBACK'}`)
  return { codes, prefixes }
}

export interface ErrorCopyReport {
  /** Codes with a catalogue entry (an exact key, a `describeFailure` case or a prefix family). */
  catalogued: string[]
  /** Codes the page shows with the Host's own reason (Chinese) or a generic sentence and the code (English). */
  hostText: string[]
  /** Security-class codes without a catalogue entry: the page would show only a generic sentence. */
  missing: Array<{ code: string; where: string[] }>
  /** Sites whose code this scan cannot name and that are not in `PASSED_ON`. */
  unresolved: Array<{ where: string; expression: string }>
}

export function classify(codes: ReadonlyMap<string, string[]>, catalog: { codes: Set<string>; prefixes: string[] }): ErrorCopyReport {
  const report: ErrorCopyReport = { catalogued: [], hostText: [], missing: [], unresolved: [] }
  for (const code of [...codes.keys()].sort()) {
    if (catalog.codes.has(code) || catalog.prefixes.some(prefix => code.startsWith(prefix))) report.catalogued.push(code)
    else if (isSecurityErrorCode(code)) report.missing.push({ code, where: codes.get(code)! })
    else report.hostText.push(code)
  }
  return report
}

export async function scanErrorCopy(root: string): Promise<ErrorCopyReport> {
  const files: Record<string, string> = {}
  for (const directory of SCOPE)
    for (const path of (await sourcesUnder(root, directory)).sort()) files[path] = await readFile(join(root, path), 'utf8')
  const { codes, unresolved } = appErrorCodes(files)
  return {
    ...classify(codes, catalogCodes(await readFile(join(root, CATALOG_FILE), 'utf8'))),
    unresolved: unresolved.filter(({ where, expression }) => !PASSED_ON[where.slice(0, where.lastIndexOf(':'))]?.includes(expression)),
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = await scanErrorCopy(fileURLToPath(new URL('..', import.meta.url)))
  const total = report.catalogued.length + report.hostText.length + report.missing.length
  if (process.argv.includes('--list')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else
    process.stdout.write(
      `${total} 个错误码：${report.catalogued.length} 个有文案，${report.hostText.length} 个显示 Host 原因，${report.missing.length} 个安全错误码缺文案\n`,
    )
  for (const { code, where } of report.missing) console.error(`${code}：安全错误码缺少文案（${where[0]}）`)
  for (const { where, expression } of report.unresolved)
    console.error(`${where}：认不出错误码 ${expression}，请写成字面量或登记到 PASSED_ON`)
  if (report.missing.length > 0 || report.unresolved.length > 0) process.exitCode = 1
}
