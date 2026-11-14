import { createServer } from 'node:http'

export type PairingStage = 'idle' | 'on-control' | 'off-control' | 'paste-ready' | 'consumed' | 'restored' | 'cleanup'

/** Read-only public milestones let one CUA call wait then press the real native button without a model round trip. */
export async function pairingStagePage() {
  let phase: PairingStage = 'idle'
  const page = `<!doctype html><meta charset="utf-8"><title>Native pairing test stage</title>
<output id="phase">idle</output><script>
async function update(){try{const r=await fetch('/phase',{cache:'no-store'});if(r.ok)document.getElementById('phase').textContent=(await r.json()).phase;}catch{}finally{setTimeout(update,100);}}
update();
</script>`
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (req.url === '/phase') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ phase }))
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(page)
    } else res.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Missing local stage listener')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    show(value: PairingStage) {
      phase = value
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close(error => (error ? reject(error) : resolve()))
      }),
  }
}
