import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { validateNativeTlsBinary } from './native-helper.ts'

const execute = promisify(execFile),
  builds = new Map<string, Promise<string>>()
/** Build-time only; no runtime download or compiler invocation is part of a connection. */
export function buildNativeTls(options: { output: string; go?: string }): Promise<string> {
  if (!isAbsolute(options.output) || process.platform === 'win32') return Promise.reject(new Error('Native TLS helper build unavailable'))
  const previous = builds.get(options.output)
  if (previous) return previous
  const operation = (async () => {
    const source = fileURLToPath(new URL('../native/main.go', import.meta.url))
    const license = `${options.output}.LICENSE`,
      licenseTemporary = `${license}.${randomUUID()}.tmp`
    await mkdir(dirname(options.output), { recursive: true })
    try {
      await writeFile(licenseTemporary, await readFile(new URL('../native/GO-LICENSE', import.meta.url)), { flag: 'wx', mode: 0o644 })
      await rename(licenseTemporary, license)
    } finally {
      await rm(licenseTemporary, { force: true })
    }
    try {
      const [binary, input] = await Promise.all([lstat(options.output), lstat(source)])
      if (binary.mtimeMs >= input.mtimeMs) {
        await validateNativeTlsBinary(options.output)
        return options.output
      }
    } catch {
      /* A missing or obsolete binary is rebuilt from local product source. */
    }
    const temporary = `${options.output}.${randomUUID()}.tmp`
    await mkdir(dirname(options.output), { recursive: true })
    try {
      await execute(options.go ?? 'go', ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', temporary, source], {
        env: {
          ...Object.fromEntries(
            ['PATH', 'HOME', 'TMPDIR', 'GOCACHE', 'GOMODCACHE', 'GOROOT', 'GOPATH', 'SYSTEMROOT'].flatMap(name =>
              process.env[name] === undefined ? [] : [[name, process.env[name]!]],
            ),
          ),
          GOTOOLCHAIN: 'local',
          CGO_ENABLED: '0',
          GOPROXY: 'off',
          GOSUMDB: 'off',
        },
        timeout: 120000,
        maxBuffer: 1048576,
      })
      await validateNativeTlsBinary(temporary)
      await rename(temporary, options.output)
      return options.output
    } finally {
      await rm(temporary, { force: true })
    }
  })()
  builds.set(options.output, operation)
  void operation
    .finally(() => {
      if (builds.get(options.output) === operation) builds.delete(options.output)
    })
    .catch(() => {})
  return operation
}
