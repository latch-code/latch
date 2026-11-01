import { useEffect, useState } from 'react'

/** How long new choices take no press, so a click meant for what was there before cannot land on them. */
const ARMING_MS = 320

/** True once `id` has been on screen for the arming time; every new request starts over. */
export function useArmed(id: string): boolean {
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setArmed(id), ARMING_MS)
    return () => clearTimeout(timer)
  }, [id])
  return armed === id
}
