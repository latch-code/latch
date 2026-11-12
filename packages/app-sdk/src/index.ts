import type { ComponentType } from 'react'
import type { AppStorageDocument } from '@latch/protocol'
import type { Latch } from './bridge.ts'
import type { AppUi } from './ui.tsx'

export { AppBridgeError, type Latch, type TaskUpdate } from './bridge.ts'
export type { AppUi } from './ui.tsx'
export { APP_SDK_VERSION } from '@latch/protocol'
export type { AppHarness, AppHostInfo, AppLastReply, AppLookup, AppStorageDocument, AppTask, AppTaskFilter } from '@latch/protocol'

/** What a page component receives: the bridge and the primitives it draws with. */
export interface PageProps {
  latch: Latch
  ui: AppUi
}

/** A document as `migrate` returns it: the new generation is written in one step. */
export interface MigratedDocument {
  scope: string
  key: string
  value: unknown
}

export interface AppDefinition {
  page: ComponentType<PageProps>
  /**
   * Runs once when the stored data is older than the manifest's `dataVersion`: every document the page can use goes in,
   * the documents of the new version come out. A throw keeps the old data.
   */
  migrate?: (from: number, documents: AppStorageDocument[]) => MigratedDocument[] | Promise<MigratedDocument[]>
}

const defined = new WeakSet<object>()

/** A page module's default export: `export default defineApp({ page: Page })`. */
export function defineApp(definition: AppDefinition): AppDefinition {
  if (typeof definition?.page !== 'function') throw new TypeError('defineApp needs a page component')
  if (definition.migrate !== undefined && typeof definition.migrate !== 'function') throw new TypeError('migrate must be a function')
  const app = Object.freeze({ page: definition.page, ...(definition.migrate ? { migrate: definition.migrate } : {}) })
  defined.add(app)
  return app
}

/** Whether `value` came from `defineApp` in this runtime. */
export function isAppDefinition(value: unknown): value is AppDefinition {
  return typeof value === 'object' && value !== null && defined.has(value)
}
