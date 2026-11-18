import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { makePrivateDirectory, ownedDirectory } from './private-directory.ts'

/**
 * The person's own relay files on this computer, in one place: `~/.latch/relays/` (0700, inside a 0700 `~/.latch`)
 * holds `<name>.json` (the relay file, with the registration token), `<name>.json.admin-header` (an edge relay's admin
 * token) and `<name>/deploy/`, where the edge deploy command keeps the configs it generates. HOME is `home` when given,
 * else `os.homedir()`, as resolveLatchPaths resolves it.
 */
export class RelayFilesError extends Error {}

/** A relay's name: a path component, so letters, digits and inner hyphens only (the edge default is the region). */
export const RELAY_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
/** As messages and printed commands spell it. */
export const RELAYS_DISPLAY = '~/.latch/relays'

function base(home: string | undefined): string {
  const resolved = home ?? homedir()
  if (!isAbsolute(resolved)) throw new RelayFilesError('找不到你的主目录（HOME）')
  return resolved
}
const uid = () => process.getuid?.() ?? -1
const insecure = (shown: string) => new RelayFilesError(`${shown} 必须是你自己的目录，权限 0700，不能是链接`)

/** Each level from ~/.latch down: created 0700 when `create`, then required private. Undefined when one is missing. */
async function privateLevels(levels: Array<[string, string]>, create: boolean): Promise<string | undefined> {
  for (const [path, shown] of levels) {
    if (create && !(await makePrivateDirectory(path))) throw insecure(shown)
    const present = await lstat(path).then(
      () => true,
      () => false,
    )
    if (!present) return undefined
    if (!(await ownedDirectory(path, uid(), 0o077))) throw insecure(shown)
  }
  return levels.at(-1)![0]
}
function relayLevels(root: string): Array<[string, string]> {
  return [
    [join(root, '.latch'), '~/.latch'],
    [join(root, '.latch', 'relays'), RELAYS_DISPLAY],
  ]
}

/** `~/.latch/relays`, made 0700 at each level when missing; a link or a group- or world-accessible level is refused. */
export async function prepareRelaysDir(home?: string): Promise<string> {
  return (await privateLevels(relayLevels(base(home)), true))!
}

/** `~/.latch/relays/<name>/deploy`, made like `prepareRelaysDir`. */
export async function prepareRelayDeployDir(name: string, home?: string): Promise<string> {
  if (!RELAY_NAME.test(name)) throw new RelayFilesError('名称只能用小写字母、数字与连字符')
  const relays = await prepareRelaysDir(home)
  return (await privateLevels(
    [
      [join(relays, name), `${RELAYS_DISPLAY}/${name}`],
      [join(relays, name, 'deploy'), `${RELAYS_DISPLAY}/${name}/deploy`],
    ],
    true,
  ))!
}

/** The path `~/.latch/relays/<name>.json`, created or not. */
export function relayFilePath(name: string, home?: string): string {
  return join(base(home), '.latch', 'relays', `${name}.json`)
}

/** The names of the relay files in `~/.latch/relays` (regular `<name>.json` files only); none when it does not exist. */
export async function relayNames(home?: string): Promise<string[]> {
  const relays = await privateLevels(relayLevels(base(home)), false)
  if (!relays) return []
  const names: string[] = []
  for (const entry of await readdir(relays)) {
    const name = entry.endsWith('.json') ? entry.slice(0, -5) : ''
    if (!RELAY_NAME.test(name)) continue
    const info = await lstat(join(relays, entry)).catch(() => undefined)
    if (info?.isFile() && !info.isSymbolicLink()) names.push(name)
  }
  return names.sort()
}

/**
 * The relay file a command reads when no path is given: `<name>.json` when a name is given, else the only relay file in
 * `~/.latch/relays`. With none or several it names what it found (names only) and asks for `--name` or `--file`.
 */
export async function chooseRelayFile(input: { name?: string; home?: string } = {}): Promise<string> {
  if (input.name !== undefined) {
    if (!RELAY_NAME.test(input.name)) throw new RelayFilesError('名称只能用小写字母、数字与连字符')
    if (!(await relayNames(input.home)).includes(input.name))
      throw new RelayFilesError(`${RELAYS_DISPLAY} 里没有 ${input.name}.json；用 --file <中继文件> 指定其他位置`)
    return relayFilePath(input.name, input.home)
  }
  const names = await relayNames(input.home)
  if (names.length === 1) return relayFilePath(names[0]!, input.home)
  if (!names.length) throw new RelayFilesError(`${RELAYS_DISPLAY} 里没有中继文件；用 --file <中继文件> 指定`)
  throw new RelayFilesError(`${RELAYS_DISPLAY} 里有 ${names.join('、')}；用 --name <名称> 选一个，或用 --file <中继文件>`)
}

/** The edge deploy command's work directory from before `~/.latch/relays`, when it is still there; never moved or deleted. */
export async function legacyDeployDir(region: string, home?: string): Promise<string | undefined> {
  const path = join(base(home), '.latch-relay', `latch-relay-${region}`)
  const info = await lstat(path).catch(() => undefined)
  return info?.isDirectory() ? path : undefined
}
