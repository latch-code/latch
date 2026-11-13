// The active-device key first shipped with Slash history. Keep its name when other private stores use the same owner.
export const storageDeviceKey = (origin: string): string => `latch.slash-device.${origin}`
const owners = new Map<string, string>()

/** The in-window guard also works when quota prevents the shared marker from being written. */
export function storageDeviceCurrent(origin: string, deviceId: string): boolean {
  const owner = owners.get(origin)
  if (owner !== undefined && owner !== deviceId) return false
  const stored = localStorage.getItem(storageDeviceKey(origin))
  return stored === null || stored === deviceId
}

/** Called before cleanup and again after it frees space; an empty owner revokes all existing handles. */
export function markStorageDevice(origin: string, keep?: string): void {
  owners.set(origin, keep ?? '')
  try {
    localStorage.setItem(storageDeviceKey(origin), keep ?? '')
  } catch {
    // Callers still remove old records and may retry the marker after freeing quota.
  }
}
