/**
 * The edge (Cloudflare Workers) relay kind is available: an operator's own node, registration by token. The node's
 * byte caps (received work, cover queues, unauthenticated output) hold without runtime signals; its per-socket send
 * budget is a rate, so a pass-holding phone that stops reading can still grow the platform's buffer unless the runtime
 * reports and drains `bufferedAmount`. What only the platform shows is checked by the operator's acceptance run
 * (`pnpm relay-edge:accept`, docs/RELAY.md). False turns the kind off in every build.
 */
export const EDGE_RELAY_AVAILABLE: boolean = true
