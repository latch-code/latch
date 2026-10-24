// The `pnpm build:presence` command. It builds as soon as it is loaded, so nothing may import it: a module bundled into
// another entry cannot tell whether it is the entry, because its import.meta.url is the bundle's (dist/start.js).
// Code that needs the build imports presence-helper.ts instead.
import { buildPresenceHelper } from './presence-helper.ts'

const result = await buildPresenceHelper({ force: process.argv.includes('--force'), log: text => console.log(text) })
// Skipping is not an error: the Host reports presence as unavailable instead.
process.exitCode = result.built || result.reason !== 'failed' ? 0 : 1
