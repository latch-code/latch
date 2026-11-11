'use strict'
// Where a packaged build looks for updates and the key that signs them. The packaging step (not in this repository yet;
// see docs/UPDATES.md) writes the fixed HTTPS feed URL, the base64 SPKI of the Ed25519 release key and whether the app
// is signed. A source checkout carries none, so it reports updates as unsupported. Nothing at run time (the page, a
// plugin, an argument or the environment) can change these.
module.exports = Object.freeze({
  /** @type {string | null} */
  feedUrl: null,
  /** @type {string | null} */
  publicKey: null,
  signed: false,
})
