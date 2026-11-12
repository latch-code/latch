import { fileURLToPath } from 'node:url'

/** The deterministic fake ACP v1 agent (no network, no model); run it as `process.execPath` with this argument. */
export const FAKE_ACP_AGENT: string = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))
/** A fake MCP server over stdio (`fixtures/fake-mcp-stdio.mjs`); `FAKE_MCP_MODE` and `FAKE_MCP_LOG` steer it. */
export const FAKE_MCP_STDIO: string = fileURLToPath(new URL('../fixtures/fake-mcp-stdio.mjs', import.meta.url))

/** The deterministic stand-in for `pi --mode rpc` (no network, no model); run it as `process.execPath` with this argument. */
export const FAKE_PI_AGENT: string = fileURLToPath(new URL('../fixtures/fake-pi-agent.mjs', import.meta.url))

/** The deterministic stand-in for `codex app-server` (no network, no model); run it as `process.execPath` with this argument. */
export const FAKE_CODEX_APP_SERVER: string = fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url))
