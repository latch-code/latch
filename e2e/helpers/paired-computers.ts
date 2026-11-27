import { writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'

export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(done => server.close(() => done()))
  return port
}

/** As in multi-host.e2e.ts: trusts the test certificate of B's HTTPS entry, a fixture clipboard and the registry handle. */
export async function trustBootstrap(directory: string, ca: string): Promise<string> {
  const path = join(directory, 'paired-computers-main.cjs')
  await writeFile(
    path,
    `
'use strict'
const remotes = require(${JSON.stringify(resolve('apps/desktop/src/remote-proxy.cjs'))})
const ca = ${JSON.stringify(ca)}
const lookup = (_hostname, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (options && options.all) done(null, [{ address: '127.0.0.1', family: 4 }])
  else done(null, '127.0.0.1', 4)
}
remotes.tlsOptions = () => ({ ca: [ca], lookup })
const Module = require('node:module')
const originalLoad = Module._load, electron = require('electron')
const fixture = globalThis.multiHostFixture = { registry: undefined, clipboardText: '' }
const facade = Object.create(electron)
Object.defineProperties(facade, {
  clipboard: { value: { readText: () => fixture.clipboardText, clear: () => { fixture.clipboardText = '' } } },
})
const computers = require(${JSON.stringify(resolve('apps/desktop/src/computers.cjs'))})
const create = computers.createComputers
computers.createComputers = options => (fixture.registry = create(options))
Module._load = function(request, parent, isMain) {
  return request === 'electron' ? facade : Reflect.apply(originalLoad, this, [request, parent, isMain])
}
try { require(${JSON.stringify(resolve('apps/desktop/src/main.cjs'))}) }
finally { Module._load = originalLoad; computers.createComputers = create }
`,
    { mode: 0o600 },
  )
  return path
}
