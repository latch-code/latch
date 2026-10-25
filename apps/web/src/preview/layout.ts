import type { InspectorPlacement } from '../inspectorLayout.ts'
/** Files need 480px and leave the conversation 520px; narrow layouts push a page. */
export function placeFileColumn(windowWidth: number, sidebar: number, preferred?: number, document = true): InspectorPlacement {
  if (windowWidth < 1024) return { kind: 'page' }
  const minimum = document ? 480 : 280
  const width = Math.round(Math.max(minimum, Math.min(preferred ?? (document ? windowWidth / 2 : 320), windowWidth - 520 - 8)))
  return { kind: 'column', width, shutSidebar: windowWidth - sidebar - width < 520 }
}
