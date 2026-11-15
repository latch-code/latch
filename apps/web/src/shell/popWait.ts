import { MOTION, motionAllowed } from '@latch/ui'

/**
 * How long going back waits for the page's exit to play before the route changes: the exit of a pushed page, or
 * nothing when the change is instant or motion is not allowed (the system's preference, or 减弱 on this device), so
 * nobody waits for an animation that does not run.
 */
export const popWait = (instant: boolean): number => (instant || !motionAllowed() ? 0 : MOTION.pushExit)
