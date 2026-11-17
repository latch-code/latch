/**
 * A relay every Host uses without being told, unless the person turns the official relay off. The official relay is the
 * edge kind (apps/relay-edge): one entry per regional node, identified by its relay key, reached at one or more origins
 * that clients race. Origins are only addresses; the relay-key signature binds a connection to the node.
 */
export type OfficialRelay =
  | {
      relayId: string
      kind: 'edge'
      /** The node's origins, the preferred first (at most four). */
      urls: readonly string[]
      /** The node's Ed25519 relay key, 64 hex characters. */
      relayKey: string
      /** The node's location (`apac-ne`, `apac-se`); the Host measures which is nearest. */
      region: string
    }
  /** A built-in self-hosted node, pinned by its TLS key (used by tests; the official relay is the edge kind). */
  | { relayId: string; kind: 'self'; url: string; spkiHash: string }

/**
 * The official Workers nodes. Keep this empty until the platform release gate is satisfied, the owner deploys the
 * nodes, and their IDs, keys, regions and origins have been verified.
 *
 * Shape of one entry, with placeholders:
 *   { relayId: '<32 hex>', kind: 'edge', relayKey: '<64 hex>', region: 'apac-ne',
 *     urls: ['https://latch-relay-ne.<subdomain>.workers.dev/'] }
 */
export const OFFICIAL_EDGE_DEPLOYMENT: readonly OfficialRelay[] = []

/** A Host persists their seeds as built-in profiles (`RelayProfiles.syncOfficial`). */
export const OFFICIAL_RELAYS: readonly OfficialRelay[] = OFFICIAL_EDGE_DEPLOYMENT
