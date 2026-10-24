import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { affectedDocs, readDocSources } from './agent-docs.ts'
import { changedFiles, openRepository, outermost, treeDirectories } from './repository.ts'

/**
 * `pnpm docs:affected [-- --base <ref>]`: the documents a change may call for updating, from the `sources` in the
 * front matter of docs/*.md and the AGENTS.md of the directories it touches. The change is the working tree (committed
 * or not) against `--base`, HEAD by default, plus untracked files. Candidates only: whether a document needs an edit
 * depends on what changed, so this never fails.
 */
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const { values } = parseArgs({ args, options: { base: { type: 'string', default: 'HEAD' } } })
const root = fileURLToPath(new URL('..', import.meta.url))
const base = values.base
const repo = await openRepository(root)
const changes = await changedFiles(root, base)
const before = await treeDirectories(root, base)
const { docs } = await readDocSources(repo)
const agents = [...repo.files].filter(file => file === 'AGENTS.md' || file.endsWith('/AGENTS.md'))
const affected = affectedDocs(docs, agents, changes, {
  added: outermost([...repo.dirs].filter(dir => !before.has(dir))),
  removed: outermost([...before].filter(dir => !repo.dirs.has(dir))),
})
console.log(`相对 ${base} 的改动：${changes.length} 个文件。`)
if (affected.length === 0) console.log('没有需要核对的文档。')
for (const doc of affected) {
  const shown = doc.because.slice(0, 5).join('、') + (doc.because.length > 5 ? ` 等 ${doc.because.length} 个` : '')
  console.log(`  ${doc.path}${doc.edited ? '（已修改）' : ''}：${shown}`)
}
