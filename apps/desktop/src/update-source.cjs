'use strict'
// Where a release build looks for updates and the key that signs them. The release signing step (not provided yet)
// writes the fixed HTTPS feed URL, the base64 SPKI of the Ed25519 release key and whether the app
// is signed. Source and local unsigned packages carry none, so updates are unsupported. Nothing at run time (the page, a
// plugin, an argument or the environment) can change these.
module.exports = Object.freeze({
  /** @type {string | null} */
  feedUrl: null,
  /** @type {string | null} */
  publicKey: null,
  signed: false,
})
