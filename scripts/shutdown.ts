/** Repeated shutdown requests must all wait for the same complete cleanup. */
export function createShutdown(cleanup: () => void | Promise<void>): () => Promise<void> {
  let shutdown: Promise<void> | undefined
  // Defer invocation so synchronous throws are memoized as a rejected Promise too.
  return () => shutdown ??= Promise.resolve().then(cleanup)
}
