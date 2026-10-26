import { join } from 'node:path'
import { buildNativeTls } from '@latch/link-client/build-native-tls'
import { latchCodeRoot } from '../src/paths.ts'

export function buildNativeTlsHelper(codeRoot = latchCodeRoot()): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  return buildNativeTls({ output: join(codeRoot, 'dist/native/latch-native-tls'), go: process.env.LATCH_RELAY_GO })
}
