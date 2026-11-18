import type { AgentAvatar, AgentBracket, AgentEyes, AgentHue } from '@latch/protocol'
import { defineCopy } from '../core/i18n.ts'

/**
 * The bracket face on a 40 grid: the two halves of each bracket, the eyes a little below the middle, every line with
 * round caps and joins. Approved geometry; change it only with the design.
 */
export const BRACKET_PATHS: Record<AgentBracket, readonly [string, string]> = {
  round: ['M13.6 12.8 Q8.6 20.5 13.6 28.2', 'M26.4 12.8 Q31.4 20.5 26.4 28.2'],
  curly: [
    'M14.2 12.6 C11.4 12.6 11.9 14.6 11.9 16.9 C11.9 18.9 11.3 20.5 9.4 20.5 C11.3 20.5 11.9 22.1 11.9 24.1 C11.9 26.4 11.4 28.4 14.2 28.4',
    'M25.8 12.6 C28.6 12.6 28.1 14.6 28.1 16.9 C28.1 18.9 28.7 20.5 30.6 20.5 C28.7 20.5 28.1 22.1 28.1 24.1 C28.1 26.4 28.6 28.4 25.8 28.4',
  ],
  square: [
    'M13.8 13 H12.2 Q10.6 13 10.6 14.6 V26.4 Q10.6 28 12.2 28 H13.8',
    'M26.2 13 H27.8 Q29.4 13 29.4 14.6 V26.4 Q29.4 28 27.8 28 H26.2',
  ],
  angle: ['M13.4 14 L10 20.5 L13.4 27', 'M26.6 14 L30 20.5 L26.6 27'],
}
export const BRACKET_STROKE = 2.3
export const EYE_X = [16.9, 23.1] as const

export type EyeShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'line'; d: string; width: number }

export function eyeShape(eyes: AgentEyes | 'happy' | 'shut', x: number): EyeShape {
  switch (eyes) {
    case 'dot':
      return { kind: 'circle', cx: x, cy: 21.2, r: 2.15 }
    case 'oval':
      return { kind: 'ellipse', cx: x, cy: 21.1, rx: 1.6, ry: 2.35 }
    case 'arc':
    case 'happy':
      return { kind: 'line', d: `M${round(x - 1.7)} 22.1 Q${x} 19.4 ${round(x + 1.7)} 22.1`, width: 1.9 }
    case 'sleepy':
    case 'shut':
      return { kind: 'line', d: `M${round(x - 1.5)} 21.4 H${round(x + 1.5)}`, width: 2 }
  }
}
const round = (value: number) => Math.round(value * 10) / 10

/** The small props, drawn as lines so they stay crisp and soft at every size: `_`, `?`, `!` and `z`. */
export const PROP_CURSOR = { x: 31, y: 27.2, width: 4, height: 1.8, rx: 0.9 }
export const PROP_ASK = {
  d: 'M31.7 6.9 Q31.8 5.1 33.6 5.1 Q35.4 5.1 35.4 6.8 Q35.4 8.1 34 8.7 Q33.6 8.9 33.6 9.7',
  dot: { cx: 33.6, cy: 11.6 },
}
export const PROP_ALERT = { d: 'M33.6 5.2 V9.2', dot: { cx: 33.6, cy: 11.6 } }
export const PROP_SLEEP = 'M32.2 6.6 H35.2 L32.2 10.4 H35.2'

/** What the face says beside its state word. 休息: the Agent cannot start now. 刚完成 is a moment, not a state. */
export type AvatarState = 'idle' | 'running' | 'waiting' | 'failed' | 'resting'

/**
 * How much a size can carry: from 32px every motion and prop; at 20–31px only an occasional blink, the state shown by
 * the row's own word; below that it stands still.
 */
export type AvatarTier = 'full' | 'blink' | 'still'
export const avatarTier = (size: number): AvatarTier => (size >= 32 ? 'full' : size >= 20 ? 'blink' : 'still')

/** 通用: the same face in a neutral grey. */
export const GENERAL_AVATAR = { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'neutral' } as const

export const BRACKET_NAMES = defineCopy<Record<AgentBracket, string>>(
  { round: '圆括号', curly: '花括号', square: '方括号', angle: '尖括号' },
  { round: 'Round brackets', curly: 'Curly brackets', square: 'Square brackets', angle: 'Angle brackets' },
)
export const EYES_NAMES = defineCopy<Record<AgentEyes, string>>(
  { dot: '圆点', arc: '弯眼', oval: '椭圆', sleepy: '眯眼' },
  { dot: 'Dots', arc: 'Arcs', oval: 'Ovals', sleepy: 'Sleepy eyes' },
)
export const HUE_NAMES = defineCopy<Record<AgentHue, string>>(
  {
    ink: '墨',
    slate: '岩',
    pine: '松',
    plum: '李',
    wisteria: '藤',
    cocoa: '可可',
    sand: '砂',
    moss: '苔',
    mist: '雾',
  },
  {
    ink: 'Ink',
    slate: 'Slate',
    pine: 'Pine',
    plum: 'Plum',
    wisteria: 'Wisteria',
    cocoa: 'Cocoa',
    sand: 'Sand',
    moss: 'Moss',
    mist: 'Mist',
  },
)
export const avatarName = (avatar: AgentAvatar) => `${BRACKET_NAMES[avatar.bracket]}、${EYES_NAMES[avatar.eyes]}、${HUE_NAMES[avatar.hue]}`
