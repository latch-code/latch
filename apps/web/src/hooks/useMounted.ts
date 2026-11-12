import { useEffect, useRef, type RefObject } from 'react'

/**
 * The effect behind `useMounted`: true while mounted, false once unmounted. It sets true on every mount, since
 * StrictMode mounts, unmounts and mounts again, and a ref that is only cleared would stay false from the first render.
 */
export function markMounted(mounted: { current: boolean }): () => void {
  mounted.current = true
  return () => {
    mounted.current = false
  }
}

/** Whether the component is still mounted when an answer arrives that it would act on. */
export function useMounted(): RefObject<boolean> {
  const mounted = useRef(true)
  useEffect(() => markMounted(mounted), [])
  return mounted
}
