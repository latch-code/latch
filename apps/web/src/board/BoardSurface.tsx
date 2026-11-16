import type { ShellState } from '../shell/useShellLayout.tsx'

/**
 * 看板: every session the Host makes a card, in its group. The shell mounts it only while 看板 is the view, over 对话,
 * which stays mounted under it.
 */
export function BoardSurface({ shell }: { shell: ShellState }) {
  return <section className="board-surface" aria-label="看板" data-phone={shell.phone ? '' : undefined} />
}
