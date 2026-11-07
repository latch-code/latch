import { fileURLToPath } from 'node:url'

/** The deterministic fake ACP v1 agent (no network, no model); run it as `process.execPath` with this argument. */
export const FAKE_ACP_AGENT: string = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))

/** The deterministic stand-in for `pi --mode rpc` (no network, no model); run it as `process.execPath` with this argument. */
export const FAKE_PI_AGENT: string = fileURLToPath(new URL('../fixtures/fake-pi-agent.mjs', import.meta.url))
