import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_LINKS_DIR, skillLinkTarget, SKILLS_DIR } from './agent-docs.ts'
import { openRepository } from './repository.ts'

/**
 * `pnpm agents:sync`: links `.claude/skills/<name>` to `.agents/skills/<name>` for every skill, the layout Claude Code
 * reads (it follows a symbolic link in its project skills directory); Codex reads `.agents/skills` itself. Removes links
 * that point into `.agents/skills` at a skill that no longer exists, and only reports any other entry, since it may be
 * someone's own file. `pnpm check:agents` fails while the two directories disagree.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const repo = await openRepository(root)
const names = [...repo.dirs]
  .filter(dir => posix.dirname(dir) === SKILLS_DIR && repo.files.has(`${dir}/SKILL.md`))
  .map(dir => posix.basename(dir))
const linksDir = join(root, SKILL_LINKS_DIR)
await mkdir(linksDir, { recursive: true })
let problems = 0
for (const name of names.toSorted()) {
  const path = join(linksDir, name)
  const target = skillLinkTarget(name)
  const stats = await lstat(path).catch(() => undefined)
  if (stats && !stats.isSymbolicLink()) {
    console.log(`  失败  ${SKILL_LINKS_DIR}/${name} 不是链接，未改动；移走它后重新运行`)
    problems++
    continue
  }
  if (stats && (await readlink(path)) === target) {
    console.log(`  通过  ${SKILL_LINKS_DIR}/${name} → ${target}`)
    continue
  }
  if (stats) await rm(path)
  await symlink(target, path)
  console.log(`  链接  ${SKILL_LINKS_DIR}/${name} → ${target}`)
}
for (const entry of [...repo.files, ...repo.dirs]
  .filter(path => posix.dirname(path) === SKILL_LINKS_DIR)
  .map(path => posix.basename(path))) {
  if (names.includes(entry)) continue
  const path = join(linksDir, entry)
  const target = await readlink(path).catch(() => undefined)
  if (target?.startsWith(`../../${SKILLS_DIR}/`)) {
    await rm(path)
    console.log(`  移除  ${SKILL_LINKS_DIR}/${entry}（${SKILLS_DIR} 中已没有这个技能）`)
  } else {
    console.log(`  失败  ${SKILL_LINKS_DIR}/${entry} 不对应 ${SKILLS_DIR} 中的技能，未改动；技能只写在 ${SKILLS_DIR}`)
    problems++
  }
}
console.log(problems === 0 ? `技能链接已同步：${names.length} 个技能。` : `技能链接同步失败：${problems} 项。`)
process.exitCode = problems === 0 ? 0 : 1
