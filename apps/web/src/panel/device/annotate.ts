// Marks drawn on a screenshot before it goes into the draft: a pen, an arrow and a box in one accent colour, with undo.
// Shapes are kept in the picture's own pixels, so the zoom it was drawn at does not matter. Page-only: nothing leaves
// until the person puts the result in the draft.

export type AnnotateTool = 'pen' | 'arrow' | 'box'
export type Point = readonly [number, number]
export type Shape = { tool: 'pen'; points: Point[] } | { tool: 'arrow' | 'box'; from: Point; to: Point }

/** The draft's bound for an image. */
export const ANNOTATED_LIMIT = 5 * 1024 * 1024

/** A pointer on the drawn picture, in the picture's pixels, kept inside it. */
export function toImagePoint(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
): Point {
  const x = rect.width > 0 ? ((client.x - rect.left) / rect.width) * natural.width : 0
  const y = rect.height > 0 ? ((client.y - rect.top) / rect.height) * natural.height : 0
  return [Math.round(Math.min(natural.width, Math.max(0, x))), Math.round(Math.min(natural.height, Math.max(0, y)))]
}

export function begin(tool: AnnotateTool, point: Point): Shape {
  return tool === 'pen' ? { tool, points: [point] } : { tool, from: point, to: point }
}

/** The shape as the pointer moves; a pen keeps points at least two pixels apart. */
export function extend(shape: Shape, point: Point): Shape {
  if (shape.tool !== 'pen') return { ...shape, to: point }
  const last = shape.points.at(-1)!
  return Math.hypot(point[0] - last[0], point[1] - last[1]) < 2 ? shape : { tool: 'pen', points: [...shape.points, point] }
}

/** Whether a shape is worth keeping once the pointer is up: a click with no drag leaves nothing. */
export function kept(shape: Shape): boolean {
  if (shape.tool === 'pen') return shape.points.length >= 2
  return Math.hypot(shape.to[0] - shape.from[0], shape.to[1] - shape.from[1]) >= 6
}

/** The line width for a picture of this size: visible on a phone's 3x picture without hiding what it marks. */
export function lineWidth(natural: { width: number; height: number }): number {
  return Math.max(3, Math.round(Math.min(natural.width, natural.height) / 120))
}

/** The two ends of an arrow's head. */
export function arrowHead(from: Point, to: Point, size: number): [Point, Point] {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0])
  const spread = Math.PI / 7
  return [
    [to[0] - size * Math.cos(angle - spread), to[1] - size * Math.sin(angle - spread)],
    [to[0] - size * Math.cos(angle + spread), to[1] - size * Math.sin(angle + spread)],
  ]
}

/** The 2D calls the drawing needs, so tests can follow them. */
export interface Pen {
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  strokeRect(x: number, y: number, width: number, height: number): void
  stroke(): void
  lineWidth: number
  strokeStyle: string | object
  lineCap: string
  lineJoin: string
}

/** Draws every shape over what the context holds already (the screenshot). */
export function draw(pen: Pen, shapes: readonly Shape[], colour: string, width: number): void {
  pen.strokeStyle = colour
  pen.lineWidth = width
  pen.lineCap = 'round'
  pen.lineJoin = 'round'
  for (const shape of shapes) {
    if (shape.tool === 'box') {
      const x = Math.min(shape.from[0], shape.to[0])
      const y = Math.min(shape.from[1], shape.to[1])
      pen.strokeRect(x, y, Math.abs(shape.to[0] - shape.from[0]), Math.abs(shape.to[1] - shape.from[1]))
      continue
    }
    pen.beginPath()
    if (shape.tool === 'pen') {
      const [first, ...rest] = shape.points
      pen.moveTo(first![0], first![1])
      for (const point of rest) pen.lineTo(point[0], point[1])
    } else {
      pen.moveTo(shape.from[0], shape.from[1])
      pen.lineTo(shape.to[0], shape.to[1])
      const [left, right] = arrowHead(shape.from, shape.to, width * 5)
      pen.moveTo(left[0], left[1])
      pen.lineTo(shape.to[0], shape.to[1])
      pen.lineTo(right[0], right[1])
    }
    pen.stroke()
  }
}

/** 「iPhone-20261117-101500.png」 → 「iPhone-20261117-101500-标注.png」, the type the encoding came out as. */
export function annotatedName(name: string, type: 'image/png' | 'image/jpeg'): string {
  const base = name.replace(/\.(png|jpe?g)$/iu, '')
  return `${base}-标注.${type === 'image/png' ? 'png' : 'jpg'}`
}
