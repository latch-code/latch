import type catalog from '../latch.catalog.json'

export type CatalogEntry = (typeof catalog.plugins)[number]
declare const __LATCH_CATALOG_PACKAGES__: Record<
  string,
  { manifest: { id: string; version: string }; files: { path: string; content: string }[] }
>
/** Build-pinned package data. The browser loads this module only when the person opens a listing. */
export const loadCatalogBundle = (entry: CatalogEntry) => __LATCH_CATALOG_PACKAGES__[entry.id]
