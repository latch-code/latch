import { useEffect, useState } from 'react'

/** Whole seconds left until `expiresAt` and the share of `totalSeconds` remaining, ticking once a second. */
export function useCountdown(expiresAt: string | undefined, totalSeconds: number): { seconds: number; fraction: number } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [expiresAt])
  const end = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt)
  if (!Number.isFinite(end)) return { seconds: 0, fraction: 0 }
  const seconds = Math.max(0, Math.ceil((end - now) / 1000))
  return { seconds, fraction: Math.min(1, seconds / Math.max(1, totalSeconds)) }
}
