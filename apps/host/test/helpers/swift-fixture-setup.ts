import { buildSwiftFixture } from '@latch/testkit'

/** Compiled before any test starts, so a new checkout's slow first build neither races a test timeout nor loads the others. */
export default async function setup(): Promise<void> {
  if (process.platform === 'darwin') await buildSwiftFixture()
}
