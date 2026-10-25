import type { InspectorPlacement } from '../inspectorLayout.ts'
/** Files need 480px and leave the conversation 520px; narrow layouts push a page. */
export function placeFileColumn(windowWidth: number, sidebar: number, preferred?: number): InspectorPlacement {
  if (windowWidth < 1024) return { kind: 'page' }
  const width = Math.round(Math.max(480, Math.min(preferred ?? windowWidth / 2, windowWidth - 520 - 8)))
  return { kind: 'column', width, shutSidebar: windowWidth - sidebar - width < 520 }
}
