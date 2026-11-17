import { runStop } from './stop-core.ts'

// Kept separate from the reusable command: import.meta.url is the entry URL after bundling.
process.exitCode = await runStop(process.argv.slice(2))
