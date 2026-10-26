/** Local desktop preferences; no notification text, session identifier or OS authorization claim crosses this interface. */
export interface DesktopNotificationPreferences {
  completion: boolean
  approval: boolean
  title: boolean
}
export type DesktopNotificationConsent = 'unasked' | 'pending' | 'accepted' | 'declined'
export interface DesktopNotificationState extends DesktopNotificationPreferences {
  supported: boolean
  needsConsent: boolean
  /** Absent on older desktop shells. */
  consent?: DesktopNotificationConsent
}
export interface DesktopNotificationResponse {
  choice: 'enable' | 'decline'
}
