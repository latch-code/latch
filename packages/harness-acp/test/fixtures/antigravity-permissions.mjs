import { pathToFileURL } from 'node:url'

// Reuse the shared fake's configurable command: it requests permission over ACP and writes a marker only when allowed.
const decision = process.argv.includes('--dangerously-skip-permissions') ? 'allow' : 'ask'
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { '*': decision } })
await import(pathToFileURL(process.env.FAKE_ACP_AGENT).href)
