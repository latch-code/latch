/**
 * The edge (Cloudflare Workers) relay kind is available: an operator's own node, registration by token. Its memory bounds
 * hold without runtime close or backlog signals (apps/relay-edge/src/buffers.ts); what only the platform can show is
 * checked by the operator's acceptance run (`pnpm relay-edge:accept`, docs/RELAY.md).
 */
export const EDGE_RELAY_AVAILABLE: boolean = true
