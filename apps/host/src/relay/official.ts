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
 * The deployed official nodes. EMPTY until the owner deploys apps/relay-edge and fills in each node's relay ID, relay
 * key, region and origins (workers.dev origins first) as its deploy guide describes. While empty, no Host uses an
 * official relay and nothing points at an undeployed one.
 *
 * Shape of one entry, with placeholders:
 *   { relayId: '<32 hex>', kind: 'edge', relayKey: '<64 hex>', region: 'apac-ne',
 *     urls: ['https://latch-relay-ne.<subdomain>.workers.dev/'] }
 */
export const OFFICIAL_EDGE_DEPLOYMENT: readonly OfficialRelay[] = []

/** A Host persists their seeds as built-in profiles (`RelayProfiles.syncOfficial`). */
export const OFFICIAL_RELAYS: readonly OfficialRelay[] = OFFICIAL_EDGE_DEPLOYMENT
