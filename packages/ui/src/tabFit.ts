/**
 * Which of a strip's tabs stand in the row, the rest going into one overflow menu at its end. Tabs keep their glyph and
 * label; none is ever narrowed to its glyph. All stand while they fit; otherwise the leading tabs stand in order as far
 * as they fit beside the menu's button, and the selected tab always stands, taking the last place if it would not.
 * `widths` are the tabs' own widths, `gap` the space between two, `more` the menu button's width.
 */
export function fitTabs({
  widths,
  selected,
  available,
  gap,
  more,
}: {
  widths: readonly number[]
  selected: number
  available: number
  gap: number
  more: number
}): number[] {
  const all = widths.map((_, index) => index)
  const span = (indices: readonly number[]) =>
    indices.reduce((total, index) => total + widths[index]!, 0) + Math.max(0, indices.length - 1) * gap
  if (span(all) <= available) return all
  const room = available - more - gap
  const shown: number[] = []
  for (const index of all) {
    if (span([...shown, index]) > room) break
    shown.push(index)
  }
  if (selected < 0 || selected >= widths.length || shown.includes(selected)) return shown.length ? shown : [0]
  // The selected tab stands: drop the trailing tabs it has no room beside.
  while (shown.length && span([...shown, selected]) > room) shown.pop()
  return [...shown, selected]
}
