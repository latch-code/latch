/**
 * The command that updates a found program the way it was installed, inferred from its layout: nothing is run to ask
 * (no `npm prefix`, `brew --prefix` or version manager), and Latch never runs the command it returns.
 */
import type { ReleaseSource } from './profiles/types.ts'

/** Where a newer release of an install is asked: npm's dist-tags, or Homebrew's own entry for its formula or cask. */
export type ReleaseLookup = { registry: 'npm'; name: string } | { registry: 'homebrew'; kind: 'formula' | 'cask'; name: string }

const BREW_PATH = /\/(Cellar|Caskroom)\/([^/]+)\//u

/** A Homebrew formula or cask name as it may appear in a command a person pastes; anything else gets no command. */
const BREW_NAME = /^[a-z0-9][a-z0-9@+._-]{0,99}$/u

/**
 * The update command for the program at `path` (as found) whose real file is `real`, or undefined when its layout says
 * nothing Latch recognises. Homebrew comes first: a formula built from an npm package keeps that package under its own
 * `Cellar/<formula>/…/lib/node_modules/`, and `npm i -g` would install a second copy.
 */
export function updateCommand(path: string, real: string | undefined, source: ReleaseSource): string | undefined {
  const file = (real ?? path).replaceAll('\\', '/')
  const brew = BREW_PATH.exec(file)
  if (brew) return BREW_NAME.test(brew[2]!) ? `brew upgrade ${brew[2]}` : undefined
  if (source.npm && file.includes(`/lib/node_modules/${source.npm}/`)) return `npm i -g ${source.npm}@latest`
  if (source.native?.matches(file)) return source.native.command
  return undefined
}

/**
 * Where to ask whether a newer release of the program at `path` (real file `real`) is out, the way it was installed: a
 * Homebrew formula or cask the profile names is asked of Homebrew, whose builds trail npm by hours; any other Homebrew
 * install, nothing. Every other layout is asked of npm when the profile names a package there, else nothing.
 */
export function releaseLookup(path: string, real: string | undefined, source: ReleaseSource): ReleaseLookup | undefined {
  const brew = BREW_PATH.exec((real ?? path).replaceAll('\\', '/'))
  if (brew)
    return source.brew?.includes(brew[2]!)
      ? { registry: 'homebrew', kind: brew[1] === 'Cellar' ? 'formula' : 'cask', name: brew[2]! }
      : undefined
  return source.npm ? { registry: 'npm', name: source.npm } : undefined
}
