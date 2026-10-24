import { fileURLToPath } from 'node:url'

/** The deterministic fake ACP v1 agent (no network, no model); run it as `process.execPath` with this argument. */
export const FAKE_ACP_AGENT: string = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))
