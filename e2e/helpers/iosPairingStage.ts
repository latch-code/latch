import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type PairingStage = 'idle' | 'on-control' | 'off-control' | 'paste-ready' | 'consumed' | 'restored' | 'cleanup'

type ControlStage = 'on-control' | 'off-control'

/** Public milestones and optional operator acknowledgements contain no pairing inputs or product write endpoint. */
export async function pairingStagePage(
  options: { acknowledge?: (stage: ControlStage) => Promise<void>; start?: () => Promise<void> } = {},
) {
  let phase: PairingStage = 'idle'
  let version = 0,
    accepted: number | undefined,
    origin = '',
    closed = false
  let pending = Promise.resolve()
  const page = `<!doctype html><meta charset="utf-8"><title>Native pairing test stage</title>
<output id="phase">idle</output>
${options.acknowledge ? '<button data-phase="on-control" hidden>已打开共享</button><button data-phase="off-control" hidden>已关闭共享</button>' : ''}
${options.start ? '<button data-phase="idle" data-action="start" hidden>开始本次配对</button><button data-phase="restored" data-action="start" hidden>开始本次配对</button>' : ''}
${options.acknowledge || options.start ? '<p id="note" aria-live="polite"></p>' : ''}<script>
let state={phase:'idle',version:0},busy=false,accepted;
const buttons=[...document.querySelectorAll('button[data-phase]')];
function render(){document.getElementById('phase').textContent=state.phase;for(const b of buttons){b.hidden=b.dataset.phase!==state.phase;b.disabled=busy||accepted===state.version;}}
for(const b of buttons)b.onclick=async()=>{if(busy||b.dataset.phase!==state.phase)return;const sent={phase:state.phase,version:state.version};busy=true;render();try{const r=await fetch('/'+(b.dataset.action||'ack'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(sent)});if(r.ok)accepted=sent.version;document.getElementById('note').textContent=r.ok?'已确认当前操作':'确认未被接受，请重新核对当前阶段';}catch{document.getElementById('note').textContent='确认失败，请重试';}finally{busy=false;render();}};
async function update(){try{const r=await fetch('/phase',{cache:'no-store'});if(r.ok){state=await r.json();render();}}catch{}finally{setTimeout(update,100);}}
update();
</script>`
  async function respond(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'DENY')
    if (closed) {
      res.writeHead(503).end()
      return
    }
    const starting = req.url === '/start'
    if (req.method === 'POST' && ((req.url === '/ack' && options.acknowledge) || (starting && options.start))) {
      if (
        req.headers.origin !== origin
        || req.headers.host !== new URL(origin).host
        || req.headers['content-type']?.split(';')[0] !== 'application/json'
      ) {
        res.writeHead(403).end()
        return
      }
      req.setEncoding('utf8')
      let text = ''
      for await (const chunk of req) {
        if (typeof chunk !== 'string' || Buffer.byteLength(text) + Buffer.byteLength(chunk) > 128) {
          res.writeHead(413).end()
          return
        }
        text += chunk
      }
      const input: unknown = JSON.parse(text)
      if (
        typeof input !== 'object'
        || input === null
        || Array.isArray(input)
        || Object.keys(input).length !== 2
        || !('phase' in input)
        || !('version' in input)
        || (starting ? input.phase !== 'idle' && input.phase !== 'restored' : input.phase !== 'on-control' && input.phase !== 'off-control')
        || input.phase !== phase
        || input.version !== version
        || accepted === version
        || closed
      ) {
        res.writeHead(409).end()
        return
      }
      const control = input.phase,
        revision = version
      accepted = revision
      const work = pending.then(() => (starting ? options.start!() : options.acknowledge!(control as ControlStage)))
      pending = work.catch(() => {})
      try {
        await work
        res.writeHead(204).end()
      } catch {
        if (version === revision) accepted = undefined
        res.writeHead(500).end()
      }
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (req.url === '/phase') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ phase, ...(options.acknowledge || options.start ? { version } : {}) }))
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(page)
    } else res.writeHead(404).end()
  }
  const server = createServer((req, res) => {
    void respond(req, res).catch(() => {
      if (!res.writableEnded) res.writeHead(400).end()
    })
  })
  server.requestTimeout = 3000
  server.headersTimeout = 3000
  server.maxHeadersCount = 24
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Missing local stage listener')
  }
  origin = `http://127.0.0.1:${address.port}`
  return {
    url: origin + '/',
    show(value: PairingStage) {
      // A prior ACK must finish writing its flag before the next stage can start and remove that flag.
      const next = pending.then(() => {
        if (!closed) {
          phase = value
          version++
          accepted = undefined
        }
      })
      pending = next
      return next
    },
    close: async () => {
      closed = true
      await pending
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close(error => (error ? reject(error) : resolve()))
      })
    },
  }
}
