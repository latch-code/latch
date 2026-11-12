import { useEffect, useRef, type RefObject } from 'react'
import { ICON_STROKE, type IconSize } from '@latch/ui'
import type { AgentAvatar as Avatar } from '@latch/protocol'
import {
  avatarName,
  avatarTier,
  BRACKET_PATHS,
  BRACKET_STROKE,
  EYE_X,
  eyeShape,
  GENERAL_AVATAR,
  PROP_ALERT,
  PROP_ASK,
  PROP_CURSOR,
  PROP_SLEEP,
  type AvatarState,
  type EyeShape,
} from './avatarFace.ts'
import { avatarScheduler, type MotionPart, type MotionTarget } from './avatarMotion.ts'

function Eye({ shape }: { shape: EyeShape }) {
  if (shape.kind === 'circle') return <circle cx={shape.cx} cy={shape.cy} r={shape.r} className="agent-avatar-fill" />
  if (shape.kind === 'ellipse') return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} className="agent-avatar-fill" />
  return <path d={shape.d} strokeWidth={shape.width} className="agent-avatar-line" />
}

function targetOf(svg: SVGSVGElement): MotionTarget {
  return {
    play(part: MotionPart, keyframes: Keyframe[], duration: number) {
      for (const element of svg.querySelectorAll(`[data-part='${part}']`))
        if (typeof element.animate === 'function') element.animate(keyframes, { duration, easing: 'ease-in-out' })
    },
    setMoving(moving: boolean) {
      if (moving) svg.setAttribute('data-moving', '')
      else svg.removeAttribute('data-moving')
    },
    setLooping(looping: boolean) {
      if (looping) svg.setAttribute('data-looping', '')
      else svg.removeAttribute('data-looping')
    },
    setPhase(seconds: number) {
      svg.style.setProperty('--avatar-phase', `${seconds}s`)
    },
  }
}

/** Joins the page's one scheduler while mounted; a run that ends in the open page gets one squint. */
function useAvatarMotion(ref: RefObject<SVGSVGElement | null>, size: number, state: AvatarState, still: boolean) {
  const tier = still ? 'still' : avatarTier(size)
  const handle = useRef<ReturnType<ReturnType<typeof avatarScheduler>['add']>>(undefined)
  const last = useRef(state)
  useEffect(() => {
    const svg = ref.current
    if (!svg || tier === 'still') return undefined
    const added = avatarScheduler().add(svg, targetOf(svg), tier, last.current)
    handle.current = added
    return () => {
      added.remove()
      handle.current = undefined
    }
  }, [ref, tier])
  useEffect(() => {
    const previous = last.current
    last.current = state
    if (previous === state) return
    handle.current?.setState(state)
    if (previous === 'running' && state === 'idle') handle.current?.celebrate()
  }, [state])
}

/**
 * An Agent's face: a pair of brackets around two eyes on a soft plate, in the Agent's hue (`general` is 通用, in grey).
 * From 32px it blinks, glances and now and then squints, and wears a small prop for its state: a cursor while running,
 * an amber ? while it waits for you, a red ! after a failure, a drifting z while it cannot start. The state word stays
 * beside it; the face only goes along. Beside a name it is decorative.
 */
export function AgentAvatar({
  avatar,
  size,
  state = 'idle',
  decorative = true,
  still = false,
  className,
}: {
  avatar: Avatar | 'general'
  size: number
  state?: AvatarState
  /** False only where the face stands for itself, such as a choice in the picker. */
  decorative?: boolean
  /** Never moves: a choice among many, which should not all blink at once. */
  still?: boolean
  className?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  useAvatarMotion(ref, size, state, still)
  const face = avatar === 'general' ? GENERAL_AVATAR : avatar
  const tier = avatarTier(size)
  const props = tier === 'full'
  const resting = state === 'resting'
  return (
    <svg
      ref={ref}
      className={className ? `agent-avatar ${className}` : 'agent-avatar'}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      data-hue={face.hue}
      data-state={state}
      data-tier={tier}
      focusable="false"
      {...(decorative || avatar === 'general' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': avatarName(avatar) })}>
      <rect className="agent-avatar-plate" width="40" height="40" rx="13" />
      {BRACKET_PATHS[face.bracket].map(d => (
        <path key={d} d={d} strokeWidth={BRACKET_STROKE} className="agent-avatar-line" />
      ))}
      <g className="agent-avatar-gaze">
        <g data-part="eyes">
          <g className="agent-avatar-base" data-part="base" opacity={resting ? 0 : undefined}>
            {EYE_X.map(x => (
              <g key={x} data-part="eye" className="agent-avatar-eye">
                <Eye shape={eyeShape(face.eyes, x)} />
              </g>
            ))}
          </g>
          {props && (
            <g data-part="happy" opacity="0">
              {EYE_X.map(x => (
                <Eye key={x} shape={eyeShape('happy', x)} />
              ))}
            </g>
          )}
          {resting && (
            <g>
              {EYE_X.map(x => (
                <Eye key={x} shape={eyeShape('shut', x)} />
              ))}
            </g>
          )}
        </g>
      </g>
      {props && state === 'running' && <rect className="agent-avatar-cursor agent-avatar-fill" {...PROP_CURSOR} />}
      {props && state === 'waiting' && (
        <g className="agent-avatar-prop" data-part="ask" data-tone="waiting">
          <path d={PROP_ASK.d} strokeWidth="1.5" />
          <circle cx={PROP_ASK.dot.cx} cy={PROP_ASK.dot.cy} r="0.95" />
        </g>
      )}
      {props && state === 'failed' && (
        <g className="agent-avatar-prop" data-tone="failed">
          <path d={PROP_ALERT.d} strokeWidth="1.7" />
          <circle cx={PROP_ALERT.dot.cx} cy={PROP_ALERT.dot.cy} r="1" />
        </g>
      )}
      {props && resting && <path className="agent-avatar-sleep agent-avatar-line" d={PROP_SLEEP} strokeWidth="1.3" />}
    </svg>
  )
}

/**
 * The 我的 Agent entry: the face as a single-colour line drawing, `(··)`, with the stroke of the icons beside it. It
 * stands still.
 */
export function AgentsMark({ size = 16 }: { size?: IconSize }) {
  return (
    <svg className="agents-mark ui-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8.2 5.6 Q3.6 12 8.2 18.4" strokeWidth={ICON_STROKE[size]} />
      <path d="M15.8 5.6 Q20.4 12 15.8 18.4" strokeWidth={ICON_STROKE[size]} />
      <circle cx="10.1" cy="12.6" r="1.35" />
      <circle cx="13.9" cy="12.6" r="1.35" />
    </svg>
  )
}
