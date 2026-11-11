import { createHash } from 'node:crypto'
import type { Repository } from './repository.ts'

/** A local-only directory: git ignores it, so `repo.files` lists a path in it only after `git add -f` or a lost ignore line. */
const LOCAL_DIR = 'docs/security'
const LOCAL_IGNORE_LINE = `/${LOCAL_DIR}/`

/** The mechanism documents. A new one joins this list on purpose, so that other kinds of writing do not arrive by file name. */
const DOCUMENTS: ReadonlySet<string> = new Set(
  [
    'ARCHITECTURE',
    'ATTACHMENTS',
    'AUTOMATIONS',
    'BRANCHES',
    'CHANGES',
    'CLIENT-LOADING',
    'CUSTOM-AGENTS',
    'DESIGN',
    'DOCUMENT-PERFORMANCE',
    'DOCUMENT-PREVIEWS',
    'FILE-OUTPUTS',
    'GIT-DELIVERY',
    'HANDOFFS',
    'HARNESSES',
    'MODEL-CONFIGURATION',
    'NOTIFICATIONS',
    'PLUGIN-DEVELOPMENT',
    'PREVIEW-BROWSER',
    'STREAMING',
    'TERMINAL',
    'TESTING',
    'TRANSPORT-PLUGINS',
    'WORKSPACE-RECOVERY',
  ].map(name => `docs/${name}.md`),
)

/**
 * SHA-256 of folded phrases that do not belong in tracked documents. The hashes keep the phrases themselves out of the
 * tree; they can be guessed, so this catches a slip and keeps nothing secret. See `wordHash` for how to add one.
 */
const BLOCKED_WORDS: ReadonlySet<string> = new Set([
  '0380db97ec507816cb2435f11d56f1bfe151dea2ae25a75859e9b2f0417dda5b',
  'd6eeb57a5f64a9d4b448c6f1c9eb0eda6a0640f0ffd56037b8bfefd9838e77a0',
  'f72ae0c9ef66c9b28790fadd7e6725ab38a5c5d59470f286ff0720eecf36ae00',
  '68a32dd6b2c35412abbf319675fa086748a052cb8693e503111c32179e921d48',
  '002340b41aee7da76f4201bf18776291a812f796e20678c563b77b5b6c47c8a1',
  'd32ef419a6b7c2a03a778c6391ea0da7424f10e4648efc482b52cbff871f9492',
  'a31e76680b2fcc1a4785297c237ad5c1d562cd86a1d8e156e15211af882b640f',
  '0663681752dce185b24751c515eeb81ab135f6e2537f75d7cc8aa6328d849480',
  '249215fed826e1cff9368c2c7490760a16f7bd49f875d39a9f23eaf1505d076d',
  '1bebe8c370515c207e639d33751d482338b979187430d97e3defb4ef6215aa4e',
  'e674f78d2bf55fd93c878f7fe14448abe677e7c3160f820ac6a012e457520b81',
  '74c9f4e027aa51f3cdbee7bca770155123f7d95507887bce5eeae6fa9a16b0df',
  'a85785ab0c6b89ed491e8108e32545e37111a4a4c77c93a7bf9910361856b79b',
  '4331397143a1a383e3af41a671844fb2c5f9b326f23a6be0bea8e4e4cfbfbd2a',
  'c378ee41c2783d081fb4f6db9fb854a46caafe455d3b64143e2239ef2cecd045',
  '131156b77cb9092c99c7a31085717ee9ec303186b7018f6a6c3bf27fd7b3effa',
  '8a255c9cf786d958dc3d3dedf40cd928e189ad419a8ab928db69db864fcfbc93',
  'd1c45dd2fc21d63ff5ce66c67eb21dd583d473d90b42d28fa4729ef22920ee7d',
])

export const wordHash = (phrase: string): string => createHash('sha256').update(phrase, 'utf8').digest('hex')

const HAN_RUN = /\p{Script=Han}{2,}/gu

/** Every run of one to three words, lower case and joined by one space; Chinese has no spaces, so its character pairs count as words. */
function phrases(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []
  const found = new Set<string>()
  words.forEach((word, index) => {
    found.add(word)
    for (const length of [2, 3]) if (index + length <= words.length) found.add(words.slice(index, index + length).join(' '))
    for (const [run] of word.matchAll(HAN_RUN)) for (let at = 0; at + 2 <= run.length; at++) found.add(run.slice(at, at + 2))
  })
  return found
}

/** What must not reach a commit: anything in the local-only directory, unknown document names and blocked words. */
export async function checkDocHygiene(repo: Repository, blocked: ReadonlySet<string> = BLOCKED_WORDS): Promise<string[]> {
  const problems: string[] = []
  const inDocs = [...repo.files].filter(file => file.startsWith('docs/')).toSorted()
  for (const file of inDocs) {
    if (file.startsWith(`${LOCAL_DIR}/`)) problems.push(`${file}：这个目录只留在本机，不能被 Git 跟踪`)
    else if (!DOCUMENTS.has(file)) problems.push(`${file}：docs/ 只放机制文档；新增文档要写进 scripts/doc-hygiene.ts 的列表`)
  }
  const ignore = repo.files.has('.gitignore') ? await repo.read('.gitignore') : ''
  if (!ignore.split(/\r?\n/u).includes(LOCAL_IGNORE_LINE)) problems.push(`.gitignore：缺少 ${LOCAL_IGNORE_LINE} 这一行`)

  const scanned = inDocs.filter(file => !file.startsWith(`${LOCAL_DIR}/`))
  for (const file of repo.files) if (file === 'README.md' || file === 'AGENTS.md' || file.endsWith('/AGENTS.md')) scanned.push(file)
  for (const file of scanned.toSorted()) {
    for (const phrase of phrases(await repo.read(file))) {
      if (blocked.has(wordHash(phrase))) problems.push(`${file}：含有不应写进仓库的词「${phrase}」`)
    }
  }
  return problems
}
