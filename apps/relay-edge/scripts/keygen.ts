import { randomBytes } from 'node:crypto'
import { nodeCrypto } from '@latch/link-client/crypto'

/**
 * Generates one node's relay key. The private seed goes to standard output only when that is a pipe (straight into
 * `wrangler secret put`), never to a terminal or a file named here; the public key and a fresh node ID go to standard
 * error for the person to copy into the Host's official list and the Worker's vars.
 */
if (process.stdout.isTTY) {
  process.stderr.write(
    '私钥只能经管道交给 wrangler secret put，例如：\n  pnpm --silent relay-edge:keygen | npx wrangler secret put RELAY_SIGNING_SEED --env ne\n',
  )
  process.exit(1)
}
const seed = randomBytes(32)
const publicKey = Buffer.from(await nodeCrypto.publicKey(seed)).toString('hex')
process.stderr.write(`中继公钥 relayKey: ${publicKey}\n节点标识 relayId（新生成，可用于这个节点）: ${randomBytes(16).toString('hex')}\n`)
process.stdout.write(seed.toString('hex'))
seed.fill(0)
