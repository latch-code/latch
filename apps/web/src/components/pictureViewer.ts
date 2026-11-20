/** A picture in a message that can be looked at large: what the viewer shows and offers for it. */
export interface ViewerPicture {
  /** Stable for the picture's place in the message, so the viewer can say which one was pressed. */
  id: string
  /** An authorized, same-origin handle (`trustedMediaUrl`). */
  url: string
  /** What the message calls it: the viewer's label. */
  name: string
  /** The file's own name, for a download. */
  fileName?: string
  /** The Host's size, until the bytes say. */
  width?: number
  height?: number
  /** The Host lets this device download it. */
  download: boolean
  /** Opens it in the file pane, where the pane can open it. */
  openInFiles?: () => void
  /** Its handle lapsed: asks the Host for a new one, as the picture in the message does when it cannot be read. */
  renew?: () => void
  /** The picture's own control in the message, where focus goes back on close. */
  element: () => HTMLElement | null
}

/** The open viewer: the pictures of the message or turn in reading order, the one shown, and how large it is drawn. */
export interface ViewerState {
  pictures: ViewerPicture[]
  index: number
  /** Drawn at this multiple of its own size; absent, fitted to the room. */
  scale?: number
}

/** Pictures in the order they stand on the page; one without an element keeps its place after those with one. */
export function inReadingOrder(pictures: ViewerPicture[]): ViewerPicture[] {
  const placed = pictures.map(picture => ({ picture, element: picture.element() }))
  return placed
    .sort((a, b) => {
      if (!a.element || !b.element) return a.element ? -1 : b.element ? 1 : 0
      if (a.element === b.element) return 0
      // Node.DOCUMENT_POSITION_FOLLOWING: b comes after a.
      return a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1
    })
    .map(item => item.picture)
}

/**
 * Opens on the pressed picture among `pictures` (already in reading order). The same file drawn twice (a link's
 * picture above its chip and the markdown picture of the same path) is one stop, at the first one's place, named as
 * the pressed one.
 */
export function openViewer(pictures: ViewerPicture[], id: string): ViewerState | undefined {
  const pressed = pictures.find(picture => picture.id === id)
  if (!pressed) return undefined
  const seen = new Set<string>()
  const unique = pictures
    .filter(picture => {
      if (seen.has(picture.url)) return false
      seen.add(picture.url)
      return true
    })
    .map(picture => (picture.url === pressed.url ? pressed : picture))
  const index = unique.findIndex(picture => picture.url === pressed.url)
  return { pictures: unique, index }
}

/** The next (1) or previous (-1) picture; at either end it stays. Stepping always shows the new one fitted. */
export function stepViewer(state: ViewerState, delta: 1 | -1): ViewerState {
  const index = Math.min(state.pictures.length - 1, Math.max(0, state.index + delta))
  return index === state.index ? state : { pictures: state.pictures, index }
}

/** Whether the picture is drawn larger than fitted. */
export function zoomedIn(state: ViewerState): boolean {
  return state.scale !== undefined
}

/** How far a picture can be zoomed in, as a multiple of its own size (or of its fitted size, when that is larger). */
export const VIEWER_MAX_SCALE = 4

export interface Room {
  width: number
  height: number
}

/** The scale that fits a picture in the room: contain, never cropped, and never past its natural size. */
export function fitScale(size: Room, room: Room): number {
  if (size.width <= 0 || size.height <= 0 || room.width <= 0 || room.height <= 0) return 1
  return Math.min(1, room.width / size.width, room.height / size.height)
}

/** Whether 100% shows more than the fitted picture: only a picture larger than the room can be zoomed. */
export function zoomable(size: Room, room: Room): boolean {
  return fitScale(size, room) < 1
}

/** 100% ↔ fit, from anywhere in between back to fit; a picture that already fits at 100% stays as it is. */
export function toggleZoom(state: ViewerState, size: Room, room: Room): ViewerState {
  if (state.scale !== undefined) return { pictures: state.pictures, index: state.index }
  if (!zoomable(size, room)) return state
  return { ...state, scale: 1 }
}

/**
 * The scale a pinch, a trackpad or a key asks for, between fitted and `VIEWER_MAX_SCALE`× the picture's own size: any
 * picture zooms this way, a small one too. At fitted or below, the picture is fitted again.
 */
export function zoomTo(state: ViewerState, scale: number, size: Room, room: Room): ViewerState {
  const fit = fitScale(size, room),
    next = Math.min(Math.max(VIEWER_MAX_SCALE, fit), scale)
  if (!Number.isFinite(next) || next <= fit * 1.001)
    return state.scale === undefined ? state : { pictures: state.pictures, index: state.index }
  return state.scale === next ? state : { ...state, scale: next }
}

/** Where focus goes back when the viewer closes: the picture last shown, else the one that was pressed. */
export function returnTarget(state: ViewerState, pressed: HTMLElement | null): HTMLElement | null {
  const shown = state.pictures[state.index]?.element()
  return shown?.isConnected ? shown : pressed?.isConnected ? pressed : null
}

/** What a finished touch gesture at fit means: a step, a close (dragged down), or nothing (snap back). */
export function swipeOutcome(dx: number, dy: number, ms: number): 'next' | 'previous' | 'close' | 'none' {
  const speed = Math.hypot(dx, dy) / Math.max(1, ms)
  if (Math.abs(dx) > Math.abs(dy)) {
    if (Math.abs(dx) > 56 || (speed > 0.5 && Math.abs(dx) > 24)) return dx < 0 ? 'next' : 'previous'
    return 'none'
  }
  if (dy > 96 || (speed > 0.5 && dy > 32)) return 'close'
  return 'none'
}
