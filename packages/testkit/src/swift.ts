import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const PACKAGE = ['--package-path', fileURLToPath(new URL('../../../native/ios', import.meta.url)), '--disable-automatic-resolution']
const PRODUCT = 'LatchNativeFixture'

/**
 * Compiles the Swift interoperability fixture. A new checkout compiles SwiftNIO first: over a minute on an idle machine
 * and several when other checkouts are building, so the limit only catches a hung compiler.
 */
export async function buildSwiftFixture(): Promise<void> {
  await exec('swift', ['build', ...PACKAGE, '--product', PRODUCT], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
}

/** Where `buildSwiftFixture` left the fixture. */
export async function swiftFixturePath(): Promise<string> {
  const { stdout } = await exec('swift', ['build', ...PACKAGE, '--show-bin-path'])
  return join(stdout.trim(), PRODUCT)
}
