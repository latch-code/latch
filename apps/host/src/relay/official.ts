/** A relay every Host uses without being told: its address and the TLS key it is pinned to. */
export interface OfficialRelay {
  relayId: string
  url: string
  spkiHash: string
}

/** Empty until the official relays are deployed. A Host persists their seeds as built-in profiles (`RelayProfiles.syncOfficial`). */
export const OFFICIAL_RELAYS: readonly OfficialRelay[] = []
