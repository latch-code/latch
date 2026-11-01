import type { ListenerClass } from './types.ts'

/**
 * The one rule for "this computer", shared by the Host and the page. Only host.sock counts: the Host creates it 0600
 * inside a 0700 runtime directory, where the desktop app connects. Loopback TCP does not count, because other accounts
 * and containers on the computer can connect to it, and anything that forwards the port (a reverse SSH tunnel, an
 * editor's port forwarding) delivers remote peers there as 127.0.0.1. Every other value, including a listener class
 * added later, is remote.
 */
export function isLocalListener(listener: ListenerClass | 'cli'): boolean {
  return listener === 'unix'
}

/** Both native paths retain the same device identity. */
export function isNativeListener(listener: ListenerClass): boolean {
  return listener === 'native-direct' || listener === 'native-relay'
}
