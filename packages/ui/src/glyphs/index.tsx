// Latch's own interface glyphs (MIT, with Latch). 16 × 16 grid, 1.5px line at 16px, square ends, mitred joints, 1px
// corners on containers, and at most one solid part per glyph, placed where the meaning is: the terminal's cursor, the
// keyhole, the current branch, the folded corner, the Harness cube's top face. Each has a solid variant for the
// selected or current item. The long tail of the interface still uses Lucide (ISC) through the same `Icon`.
import { defineGlyph, Dot, Hole, Plane, Slit } from './glyph.tsx'

export { defineGlyph, ICON_STROKE, type GlyphProps, type IconComponent, type IconSize, type SolidDrawing } from './glyph.tsx'

const Ring = () => <circle cx="8" cy="8" r="5.75" />
const Disc = () => <circle cx="8" cy="8" r="5.75" fill="currentColor" />

// ---- states ----

export const AlertGlyph = defineGlyph(
  'alert',
  <>
    <Ring />
    <Dot x={7.25} y={4.5} w={1.5} h={4.25} />
    <Dot x={7.25} y={10} w={1.5} h={1.5} />
  </>,
  {
    plane: <Disc />,
    cut: (
      <>
        <Hole x={7.25} y={4.5} w={1.5} h={4.25} />
        <Hole x={7.25} y={10} w={1.5} h={1.5} />
      </>
    ),
  },
)

const TRIANGLE = 'M8 2.75 L13.9 12.75 H2.1 Z'
export const WarningGlyph = defineGlyph(
  'warning',
  <>
    <path d={TRIANGLE} />
    <Dot x={7.25} y={6} w={1.5} h={3.25} />
    <Dot x={7.25} y={10.25} w={1.5} h={1.5} />
  </>,
  {
    plane: <Plane d={TRIANGLE} />,
    cut: (
      <>
        <Hole x={7.25} y={6} w={1.5} h={3.25} />
        <Hole x={7.25} y={10.25} w={1.5} h={1.5} />
      </>
    ),
  },
)

export const InfoGlyph = defineGlyph(
  'info',
  <>
    <Ring />
    <Dot x={7.25} y={4.5} w={1.5} h={1.5} />
    <Dot x={7.25} y={7} w={1.5} h={4.5} />
  </>,
  {
    plane: <Disc />,
    cut: (
      <>
        <Hole x={7.25} y={4.5} w={1.5} h={1.5} />
        <Hole x={7.25} y={7} w={1.5} h={4.5} />
      </>
    ),
  },
)

const TICK = 'M5.25 8.25 L7.25 10.25 L10.75 6.25'
export const CircleCheckGlyph = defineGlyph(
  'circle-check',
  <>
    <Ring />
    <path d={TICK} />
  </>,
  { plane: <Disc />, cut: <Slit d={TICK} /> },
)

const SLASH = 'M4 12 L12 4'
export const BlockedGlyph = defineGlyph(
  'blocked',
  <>
    <Ring />
    <path d={SLASH} />
  </>,
  { plane: <Disc />, cut: <Slit d={SLASH} /> },
)

export const CheckGlyph = defineGlyph('check', <path d="M3 8.25 L6.5 11.75 L13 4.75" />)

export const OfflineGlyph = defineGlyph(
  'offline',
  <>
    <path d="M1.75 6.5 A9 9 0 0 1 14.25 6.5" />
    <path d="M4.5 9.25 A5.25 5.25 0 0 1 11.5 9.25" />
    <Dot x={7} y={11.25} w={2} h={2} />
    <path d="M2.5 2.5 L13.5 13.5" />
  </>,
)

// ---- direction ----

export const ChevronRightGlyph = defineGlyph('chevron-right', <path d="M6 3.5 L10.5 8 L6 12.5" />)
export const ChevronLeftGlyph = defineGlyph('chevron-left', <path d="M10 3.5 L5.5 8 L10 12.5" />)
export const ChevronDownGlyph = defineGlyph('chevron-down', <path d="M3.5 6 L8 10.5 L12.5 6" />)
export const ChevronUpGlyph = defineGlyph('chevron-up', <path d="M3.5 10 L8 5.5 L12.5 10" />)
export const UpDownGlyph = defineGlyph('up-down', <path d="M5 6.25 L8 3.25 L11 6.25 M5 9.75 L8 12.75 L11 9.75" />)
export const SendGlyph = defineGlyph('send', <path d="M8 13.25 V3.5 M3.75 7.75 L8 3.5 L12.25 7.75" />)
export const DownloadGlyph = defineGlyph('download', <path d="M8 2.25 V10.25 M4.5 6.75 L8 10.25 L11.5 6.75 M2.75 13.25 H13.25" />)
export const EnterGlyph = defineGlyph(
  'enter',
  <>
    <path d="M12.75 2.75 V7.75 A1.5 1.5 0 0 1 11.25 9.25 H3.5" />
    <path d="M6.5 6.25 L3.5 9.25 L6.5 12.25" />
  </>,
)
export const UndoGlyph = defineGlyph(
  'undo',
  <>
    <path d="M5.25 3.5 L2.25 6.5 L5.25 9.5" />
    <path d="M2.25 6.5 H9.75 A3.25 3.25 0 0 1 9.75 13 H6.25" />
  </>,
)
export const RefreshGlyph = defineGlyph(
  'refresh',
  <>
    <path d="M13.25 8 A5.25 5.25 0 1 1 11.71 4.29" />
    <path d="M12.75 1.5 V5 H9.25" />
  </>,
)
export const ExternalGlyph = defineGlyph(
  'external',
  <>
    <path d="M9.5 2.75 H13.25 V6.5" />
    <path d="M13.25 2.75 L7.5 8.5" />
    <path d="M11.25 9.25 V12.25 A1 1 0 0 1 10.25 13.25 H3.75 A1 1 0 0 1 2.75 12.25 V5.75 A1 1 0 0 1 3.75 4.75 H6.75" />
  </>,
)

// ---- actions ----

export const CloseGlyph = defineGlyph('close', <path d="M3.75 3.75 L12.25 12.25 M12.25 3.75 L3.75 12.25" />)
export const PlusGlyph = defineGlyph('plus', <path d="M8 2.75 V13.25 M2.75 8 H13.25" />)
export const MoreGlyph = defineGlyph(
  'more',
  <>
    <Dot x={2.25} y={7} w={2} h={2} />
    <Dot x={7} y={7} w={2} h={2} />
    <Dot x={11.75} y={7} w={2} h={2} />
  </>,
  {
    plane: (
      <>
        <Dot x={1.75} y={6.5} w={3} h={3} />
        <Dot x={6.5} y={6.5} w={3} h={3} />
        <Dot x={11.25} y={6.5} w={3} h={3} />
      </>
    ),
  },
)
export const SearchGlyph = defineGlyph(
  'search',
  <>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.25 10.25 L13.75 13.75" />
  </>,
)
export const CopyGlyph = defineGlyph(
  'copy',
  <>
    <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1" />
    <path d="M2.75 10.25 V3.75 A1 1 0 0 1 3.75 2.75 H10.25" />
  </>,
  {
    plane: (
      <>
        <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1" fill="currentColor" />
        <path d="M2.75 10.25 V3.75 A1 1 0 0 1 3.75 2.75 H10.25" />
      </>
    ),
  },
)
const PENCIL = 'M10.5 2.5 L13.5 5.5 L5.75 13.25 H2.75 V10.25 Z'
const FERRULE = 'M8.75 4.25 L11.75 7.25'
export const EditGlyph = defineGlyph(
  'edit',
  <>
    <path d={PENCIL} />
    <path d={FERRULE} />
  </>,
  { plane: <Plane d={PENCIL} />, cut: <Slit d={FERRULE} /> },
)
const SHEET = 'M7.25 2.75 H3.75 A1 1 0 0 0 2.75 3.75 V12.25 A1 1 0 0 0 3.75 13.25 H12.25 A1 1 0 0 0 13.25 12.25 V8.75'
const NIB = 'M11.5 1.75 L14.25 4.5 L8.5 10.25 H5.75 V7.5 Z'
export const NewSessionGlyph = defineGlyph(
  'new-session',
  <>
    <path d={SHEET} />
    <path d={NIB} />
  </>,
  {
    plane: (
      <>
        <path d={SHEET} />
        <Plane d={NIB} />
      </>
    ),
  },
)
const BIN = 'M3.5 4.25 L4.25 13.75 H11.75 L12.5 4.25'
export const TrashGlyph = defineGlyph(
  'trash',
  <>
    <path d="M1.75 4.25 H14.25" />
    <path d="M5.75 4.25 V2.25 H10.25 V4.25" />
    <path d={BIN} />
  </>,
  {
    plane: (
      <>
        <path d="M1.75 4.25 H14.25" />
        <path d="M5.75 4.25 V2.25 H10.25 V4.25" />
        <Plane d={`${BIN} Z`} />
      </>
    ),
  },
)
const PIN_HEAD = 'M6.5 2.25 V6.5 L4.25 9.25 H11.75 L9.5 6.5 V2.25'
export const PinGlyph = defineGlyph(
  'pin',
  <>
    <path d="M5.25 2.25 H10.75" />
    <path d={PIN_HEAD} />
    <path d="M8 9.25 V14.25" />
  </>,
  {
    plane: (
      <>
        <path d="M5.25 2.25 H10.75" />
        <Plane d={`${PIN_HEAD} Z`} />
        <path d="M8 9.25 V14.25" />
      </>
    ),
  },
)
export const UnpinGlyph = defineGlyph(
  'unpin',
  <>
    <path d="M5.25 2.25 H10.75" />
    <path d={PIN_HEAD} />
    <path d="M8 9.25 V14.25" />
    <path d="M2.25 3.25 L13.75 13.25" />
  </>,
)
const LID = 'M1.75 2.75 H14.25 V5.75 H1.75 Z'
const CRATE = 'M3.25 5.75 V12.25 A1 1 0 0 0 4.25 13.25 H11.75 A1 1 0 0 0 12.75 12.25 V5.75'
export const ArchiveGlyph = defineGlyph(
  'archive',
  <>
    <path d={LID} />
    <path d={CRATE} />
    <path d="M6.25 8.5 H9.75" />
  </>,
  {
    plane: (
      <>
        <Plane d={LID} />
        <Plane d={`${CRATE} Z`} />
      </>
    ),
    cut: (
      <>
        <Slit d="M1 6.5 H15" />
        <Slit d="M6.25 9 H9.75" />
      </>
    ),
  },
)

// ---- places and things ----

const FOLDER =
  'M2.75 11.75 V4.75 A1 1 0 0 1 3.75 3.75 H6.5 L8 5.25 H12.25 A1 1 0 0 1 13.25 6.25 V11.75 A1 1 0 0 1 12.25 12.75 H3.75 A1 1 0 0 1 2.75 11.75 Z'
export const FolderGlyph = defineGlyph('folder', <path d={FOLDER} />, { plane: <Plane d={FOLDER} /> })

const FLAP = 'M2.75 12.25 L4.6 7.25 H14.25 L12.4 12.25 Z'
const FOLDER_BACK = 'M2.75 12.25 V4.75 A1 1 0 0 1 3.75 3.75 H6.5 L8 5.25 H11.25 A1 1 0 0 1 12.25 6.25 V7.25'
export const FolderOpenGlyph = defineGlyph(
  'folder-open',
  <>
    <path d={FOLDER_BACK} />
    <path d={FLAP} />
  </>,
  {
    plane: (
      <>
        <path d={FOLDER_BACK} />
        <Plane d={FLAP} />
      </>
    ),
  },
)

const PAGE = 'M3.25 3.75 A1 1 0 0 1 4.25 2.75 H9.25 L12.75 6.25 V12.25 A1 1 0 0 1 11.75 13.25 H4.25 A1 1 0 0 1 3.25 12.25 Z'
const FOLD = 'M9.25 2.75 L12.75 6.25 H9.25 Z'
/** In the solid page the folded corner is a crease cut out of it. */
const FOLD_CREASE = 'M8.5 1.5 V7 H14'
export const FileGlyph = defineGlyph(
  'file',
  <>
    <path d={PAGE} />
    <path d={FOLD} fill="currentColor" />
    <path d="M5.5 8.75 H10.5 M5.5 11 H8.5" />
  </>,
  { plane: <Plane d={PAGE} />, cut: <Slit d={`${FOLD_CREASE} M5.5 9.25 H10.5 M5.5 11.5 H8.5`} /> },
)
/** A file of no known kind: the page and its folded corner, without the lines of a document. */
export const PageGlyph = defineGlyph(
  'page',
  <>
    <path d={PAGE} />
    <path d={FOLD} fill="currentColor" />
  </>,
  { plane: <Plane d={PAGE} />, cut: <Slit d={FOLD_CREASE} /> },
)
const PLUS_MINUS = 'M7.5 6.75 V10 M5.875 8.375 H9.125 M5.875 11.25 H9.125'
const PLUS_MINUS_SOLID = 'M7 7.75 V11 M5.375 9.375 H8.625 M5.375 12 H8.625'
export const DiffGlyph = defineGlyph(
  'diff',
  <>
    <path d={PAGE} />
    <path d={FOLD} fill="currentColor" />
    <path d={PLUS_MINUS} />
  </>,
  { plane: <Plane d={PAGE} />, cut: <Slit d={`${FOLD_CREASE} ${PLUS_MINUS_SOLID}`} /> },
)

export const HistoryGlyph = defineGlyph(
  'history',
  <>
    <path d="M3.45 5.375 A5.25 5.25 0 1 1 2.75 8" />
    <path d="M3.45 2.5 V5.375 H6.3" />
    <path d="M8 5.25 V8.25 L10.25 9.75" />
  </>,
)

const SCREEN =
  'M2.75 2.75 H13.25 A1 1 0 0 1 14.25 3.75 V12.25 A1 1 0 0 1 13.25 13.25 H2.75 A1 1 0 0 1 1.75 12.25 V3.75 A1 1 0 0 1 2.75 2.75 Z'
const PROMPT = 'M4.5 6 L6.75 8.25 L4.5 10.5'
export const TerminalGlyph = defineGlyph(
  'terminal',
  <>
    <path d={SCREEN} />
    <path d={PROMPT} />
    <Dot x={8} y={9.5} w={3.5} h={1.5} />
  </>,
  {
    plane: <Plane d={SCREEN} />,
    cut: (
      <>
        <Slit d={PROMPT} />
        <Hole x={8} y={9.5} w={3.5} h={1.5} />
      </>
    ),
  },
)

export const PanelLeftGlyph = defineGlyph(
  'panel-left',
  <>
    <path d={SCREEN} />
    <path d="M6.25 2.75 V13.25" />
  </>,
  {
    plane: (
      <>
        <path d={SCREEN} />
        <rect x="1.75" y="2.75" width="4.5" height="10.5" fill="currentColor" />
      </>
    ),
  },
)
export const PanelRightGlyph = defineGlyph(
  'panel-right',
  <>
    <path d={SCREEN} />
    <path d="M9.75 2.75 V13.25" />
  </>,
  {
    plane: (
      <>
        <path d={SCREEN} />
        <rect x="9.75" y="2.75" width="4.5" height="10.5" fill="currentColor" />
      </>
    ),
  },
)

const BRANCH_LINE = 'M4.75 5.25 V10.75 M11.25 5 C11.25 8.75 4.75 7.75 4.75 10.75'
export const BranchGlyph = defineGlyph(
  'branch',
  <>
    <circle cx="4.75" cy="3.75" r="1.5" />
    <circle cx="4.75" cy="12.25" r="1.5" />
    <path d={BRANCH_LINE} />
    <Dot x={10} y={2.5} w={2.5} h={2.5} />
  </>,
  {
    plane: (
      <>
        <circle cx="4.75" cy="3.75" r="1.5" fill="currentColor" />
        <circle cx="4.75" cy="12.25" r="1.5" fill="currentColor" />
        <path d={BRANCH_LINE} />
        <Dot x={9.75} y={2.25} w={3} h={3} />
      </>
    ),
  },
)
export const CommitGlyph = defineGlyph(
  'commit',
  <>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M1.25 8 H5.25 M10.75 8 H14.75" />
  </>,
  {
    plane: (
      <>
        <circle cx="8" cy="8" r="2.75" fill="currentColor" />
        <path d="M1.25 8 H5.25 M10.75 8 H14.75" />
      </>
    ),
  },
)

const SHIELD = 'M8 1.75 L13.25 3.5 V7.75 C13.25 10.75 11.25 12.9 8 14.25 C4.75 12.9 2.75 10.75 2.75 7.75 V3.5 Z'
export const ShieldGlyph = defineGlyph('shield', <path d={SHIELD} />, { plane: <Plane d={SHIELD} /> })
export const ShieldAlertGlyph = defineGlyph(
  'shield-alert',
  <>
    <path d={SHIELD} />
    <Dot x={7.25} y={4.75} w={1.5} h={4} />
    <Dot x={7.25} y={9.75} w={1.5} h={1.5} />
  </>,
  {
    plane: <Plane d={SHIELD} />,
    cut: (
      <>
        <Hole x={7.25} y={4.75} w={1.5} h={4} />
        <Hole x={7.25} y={9.75} w={1.5} h={1.5} />
      </>
    ),
  },
)

const SHACKLE = 'M5.25 7.25 V5.5 A2.75 2.75 0 0 1 10.75 5.5 V7.25'
export const LockGlyph = defineGlyph(
  'lock',
  <>
    <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1" />
    <path d={SHACKLE} />
    <Dot x={7.25} y={9.25} w={1.5} h={2.5} />
  </>,
  {
    plane: (
      <>
        <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1" fill="currentColor" />
        <path d={SHACKLE} />
      </>
    ),
    cut: <Hole x={7.25} y={9.25} w={1.5} h={2.5} />,
  },
)

export const LaptopGlyph = defineGlyph(
  'laptop',
  <>
    <rect x="3.25" y="3.25" width="9.5" height="7.25" rx="1" />
    <path d="M1.25 12.75 H14.75" />
  </>,
  {
    plane: (
      <>
        <rect x="3.25" y="3.25" width="9.5" height="7.25" rx="1" fill="currentColor" />
        <path d="M1.25 12.75 H14.75" />
      </>
    ),
  },
)
export const DevicesGlyph = defineGlyph(
  'devices',
  <>
    <rect x="1.75" y="3.25" width="8.25" height="6.75" rx="1" />
    <path d="M1 12.25 H8.5" />
    <rect x="11" y="5.75" width="3.75" height="7.5" rx="1" />
  </>,
  {
    plane: (
      <>
        <rect x="1.75" y="3.25" width="8.25" height="6.75" rx="1" fill="currentColor" />
        <path d="M1 12.25 H8.5" />
        <rect x="11" y="5.75" width="3.75" height="7.5" rx="1" fill="currentColor" />
      </>
    ),
  },
)
export const PhoneGlyph = defineGlyph(
  'phone',
  <>
    <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.25" />
    <Dot x={7} y={11} w={2} h={1.5} />
  </>,
  {
    plane: <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.25" fill="currentColor" />,
    cut: <Hole x={7} y={11} w={2} h={1.5} />,
  },
)
export const KeyboardGlyph = defineGlyph(
  'keyboard',
  <>
    <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1" />
    <Dot x={4} y={6} w={1.5} h={1.5} />
    <Dot x={7.25} y={6} w={1.5} h={1.5} />
    <Dot x={10.5} y={6} w={1.5} h={1.5} />
    <path d="M5 9.75 H11" />
  </>,
  {
    plane: <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1" fill="currentColor" />,
    cut: (
      <>
        <Hole x={4} y={6} w={1.5} h={1.5} />
        <Hole x={7.25} y={6} w={1.5} h={1.5} />
        <Hole x={10.5} y={6} w={1.5} h={1.5} />
        <Slit d="M5 9.75 H11" />
      </>
    ),
  },
)

const TRAY = 'M1.75 8.75 L3.75 3.25 H12.25 L14.25 8.75 V12.25 A1 1 0 0 1 13.25 13.25 H2.75 A1 1 0 0 1 1.75 12.25 Z'
const TRAY_EDGE = 'M1.75 8.75 H5.25 L6.25 10.5 H9.75 L10.75 8.75 H14.25'
export const InboxGlyph = defineGlyph(
  'inbox',
  <>
    <path d={TRAY} />
    <path d={TRAY_EDGE} />
  </>,
  { plane: <Plane d={TRAY} />, cut: <Slit d={TRAY_EDGE} /> },
)

const BUBBLE =
  'M2.75 3.75 A1 1 0 0 1 3.75 2.75 H12.25 A1 1 0 0 1 13.25 3.75 V10.25 A1 1 0 0 1 12.25 11.25 H6.5 L3.75 13.75 V11.25 A1 1 0 0 1 2.75 10.25 Z'
export const MessageGlyph = defineGlyph('message', <path d={BUBBLE} />, { plane: <Plane d={BUBBLE} /> })

const EYE = 'M1.25 8 C3 4.9 5.25 3.25 8 3.25 C10.75 3.25 13 4.9 14.75 8 C13 11.1 10.75 12.75 8 12.75 C5.25 12.75 3 11.1 1.25 8 Z'
export const EyeGlyph = defineGlyph(
  'eye',
  <>
    <path d={EYE} />
    <Dot x={6.5} y={6.5} w={3} h={3} />
  </>,
  { plane: <Plane d={EYE} />, cut: <Hole x={6.5} y={6.5} w={3} h={3} /> },
)

const MERIDIANS = 'M2.25 8 H13.75 M8 2.25 C10 4 10.75 6 10.75 8 C10.75 10 10 12 8 13.75 C6 12 5.25 10 5.25 8 C5.25 6 6 4 8 2.25 Z'
export const GlobeGlyph = defineGlyph(
  'globe',
  <>
    <Ring />
    <path d={MERIDIANS} />
  </>,
  { plane: <Disc />, cut: <Slit d={MERIDIANS} /> },
)

export const CodeGlyph = defineGlyph('code', <path d="M5 4.25 L1.5 8 L5 11.75 M11 4.25 L14.5 8 L11 11.75 M9.5 2.75 L6.5 13.25" />)

/** 思考: three lines, each shorter than the last, as a thought being written out (never a brain). */
export const ReasonGlyph = defineGlyph('reason', <path d="M2.75 4.25 H13.25 M2.75 8 H10.25 M2.75 11.75 H7.25" />)

/** Sliders, for 设置 and 通用 (never a gear). */
export const SettingsGlyph = defineGlyph(
  'settings',
  <>
    <path d="M2 4.25 H8.25 M12.25 4.25 H14 M2 8 H3.25 M7.25 8 H14 M2 11.75 H7.25 M11.25 11.75 H14" />
    <Dot x={9} y={2.75} w={2.5} h={3} />
    <Dot x={4} y={6.5} w={2.5} h={3} />
    <Dot x={8} y={10.25} w={2.5} h={3} />
  </>,
)

/** Plugins and pages: four tiles, the one being added solid. */
export const PluginsGlyph = defineGlyph(
  'plugins',
  <>
    <rect x="2.75" y="2.75" width="4.5" height="4.5" rx="1" />
    <rect x="8.75" y="2.75" width="4.5" height="4.5" rx="1" />
    <rect x="2.75" y="8.75" width="4.5" height="4.5" rx="1" />
    <rect x="8" y="8" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
  </>,
  {
    plane: (
      <>
        <rect x="2" y="2" width="5.25" height="5.25" rx="1" fill="currentColor" stroke="none" />
        <rect x="8.75" y="2" width="5.25" height="5.25" rx="1" fill="currentColor" stroke="none" />
        <rect x="2" y="8.75" width="5.25" height="5.25" rx="1" fill="currentColor" stroke="none" />
        <rect x="8.75" y="8.75" width="5.25" height="5.25" rx="1" fill="currentColor" stroke="none" />
      </>
    ),
  },
)

const PINS = 'M6 1.75 V4 M10 1.75 V4 M6 12 V14.25 M10 12 V14.25 M1.75 6 H4 M1.75 10 H4 M12 6 H14.25 M12 10 H14.25'
/** A model service: a chip, its core solid. */
export const ModelGlyph = defineGlyph(
  'model',
  <>
    <rect x="4" y="4" width="8" height="8" rx="1" />
    <Dot x={6.5} y={6.5} w={3} h={3} />
    <path d={PINS} />
  </>,
  {
    plane: (
      <>
        <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
        <path d={PINS} />
      </>
    ),
    cut: <Hole x={6.5} y={6.5} w={3} h={3} />,
  },
)

const CUBE = 'M8 1.75 L13.75 4.75 V11.25 L8 14.25 L2.25 11.25 V4.75 Z'
const CUBE_TOP = 'M8 1.75 L13.75 4.75 L8 7.75 L2.25 4.75 Z'
const CUBE_EDGES = 'M2.25 4.75 L8 7.75 L13.75 4.75 M8 7.75 V14.25'
/** A Harness: a cube, its top face solid. */
export const HarnessGlyph = defineGlyph(
  'harness',
  <>
    <path d={CUBE} />
    <path d={CUBE_TOP} fill="currentColor" />
    <path d="M8 7.75 V14.25" />
  </>,
  { plane: <Plane d={CUBE} />, cut: <Slit d={CUBE_EDGES} /> },
)

/** Workbench navigation and evidence, on the same 16 grid. */
export const OverviewGlyph = defineGlyph(
  'overview',
  <>
    <Dot x={2} y={3.25} w={2.75} h={2.75} />
    <path d="M7 4.625 H14 M2 8.25 H4.75 M7 8.25 H14 M2 11.875 H4.75 M7 11.875 H11.5" />
  </>,
)
const WAITING_FLAG = 'M3.5 2.75 H12.75 L10.5 6.125 L12.75 9.5 H3.5'
export const WaitingGlyph = defineGlyph(
  'waiting',
  <>
    <path d="M3.5 14.25 V1.75" />
    <path d={WAITING_FLAG} />
  </>,
  {
    plane: (
      <>
        <path d="M3.5 14.25 V1.75" />
        <path d={`${WAITING_FLAG} Z`} fill="currentColor" />
      </>
    ),
  },
)
const PR_BRANCH = (
  <>
    <circle cx="4.5" cy="3.75" r="1.5" />
    <path d="M4.5 5.25 V10.75" />
    <circle cx="4.5" cy="12.25" r="1.5" />
    <path d="M11.5 10.5 V6.25 A1.5 1.5 0 0 0 10 4.75 H6.75 M8.5 3 L6.75 4.75 L8.5 6.5" />
    <Dot x={10.25} y={10.75} w={2.5} h={2.5} />
  </>
)
export const PullRequestGlyph = defineGlyph('pull-request', PR_BRANCH)
export const UnknownGlyph = defineGlyph(
  'unknown',
  <>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M6.25 6.5 A1.75 1.75 0 1 1 8.75 8.1 C8.2 8.4 8 8.75 8 9.5" />
    <Dot x={7.25} y={10.5} w={1.5} h={1.5} />
  </>,
)
const CLOCK_EARS = 'M2 4.25 L4.25 2 M14 4.25 L11.75 2'
export const ScheduleGlyph = defineGlyph(
  'schedule',
  <>
    <circle cx="8" cy="8.75" r="5" />
    <path d={`M8 6.25 V8.75 H10.25 ${CLOCK_EARS}`} />
  </>,
  {
    plane: (
      <>
        <circle cx="8" cy="8.75" r="5" fill="currentColor" />
        <path d={CLOCK_EARS} />
      </>
    ),
    cut: <Slit d="M8 6.25 V8.75 H10.25" />,
  },
)

/** Every Latch glyph by its name, for the gallery's sheet and the tests. */
export const LATCH_GLYPHS = {
  overview: OverviewGlyph,
  waiting: WaitingGlyph,
  'pull-request': PullRequestGlyph,
  schedule: ScheduleGlyph,
  unknown: UnknownGlyph,
  alert: AlertGlyph,
  warning: WarningGlyph,
  info: InfoGlyph,
  'circle-check': CircleCheckGlyph,
  blocked: BlockedGlyph,
  check: CheckGlyph,
  offline: OfflineGlyph,
  'chevron-right': ChevronRightGlyph,
  'chevron-left': ChevronLeftGlyph,
  'chevron-down': ChevronDownGlyph,
  'chevron-up': ChevronUpGlyph,
  'up-down': UpDownGlyph,
  send: SendGlyph,
  download: DownloadGlyph,
  enter: EnterGlyph,
  undo: UndoGlyph,
  refresh: RefreshGlyph,
  external: ExternalGlyph,
  close: CloseGlyph,
  plus: PlusGlyph,
  more: MoreGlyph,
  search: SearchGlyph,
  copy: CopyGlyph,
  edit: EditGlyph,
  'new-session': NewSessionGlyph,
  trash: TrashGlyph,
  pin: PinGlyph,
  unpin: UnpinGlyph,
  archive: ArchiveGlyph,
  folder: FolderGlyph,
  'folder-open': FolderOpenGlyph,
  file: FileGlyph,
  page: PageGlyph,
  diff: DiffGlyph,
  history: HistoryGlyph,
  terminal: TerminalGlyph,
  'panel-left': PanelLeftGlyph,
  'panel-right': PanelRightGlyph,
  branch: BranchGlyph,
  commit: CommitGlyph,
  shield: ShieldGlyph,
  'shield-alert': ShieldAlertGlyph,
  lock: LockGlyph,
  laptop: LaptopGlyph,
  devices: DevicesGlyph,
  phone: PhoneGlyph,
  keyboard: KeyboardGlyph,
  inbox: InboxGlyph,
  message: MessageGlyph,
  eye: EyeGlyph,
  globe: GlobeGlyph,
  code: CodeGlyph,
  reason: ReasonGlyph,
  settings: SettingsGlyph,
  plugins: PluginsGlyph,
  model: ModelGlyph,
  harness: HarnessGlyph,
} as const
