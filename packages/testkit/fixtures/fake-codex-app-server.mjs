// What `codex-acp cli app-server` answers, for the fake ACP agent started with those arguments: initialize, config/read
// and model/list, two models per page. FAKE_CODEX_MODELS is a JSON array of models in Codex's shape; FAKE_CODEX_MODEL
// is the configured model; FAKE_CODEX_LIST_ERROR makes model/list fail. Everything received goes to FAKE_ACP_LOG.
import { appendFileSync } from 'node:fs'

const env = process.env
const log = (event, data = {}) => {
  if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, `${JSON.stringify({ pid: process.pid, event, ...data })}\n`)
}
const effort = (reasoningEffort, description) => ({ reasoningEffort, description })
const models = env.FAKE_CODEX_MODELS
  ? JSON.parse(env.FAKE_CODEX_MODELS)
  : [
      {
        id: 'gpt-fake',
        model: 'gpt-fake',
        displayName: 'GPT Fake',
        description: 'The default',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [effort('low', 'Fast'), effort('medium', 'Balanced'), effort('high', 'Deep')],
      },
      {
        id: 'gpt-fake-mini',
        model: 'gpt-fake-mini',
        displayName: 'GPT Fake Mini',
        description: 'Small',
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [effort('low', 'Fast'), effort('medium', 'Balanced')],
      },
      {
        id: 'gpt-fake-hidden',
        model: 'gpt-fake-hidden',
        displayName: 'Hidden',
        description: '',
        hidden: true,
        isDefault: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [],
      },
    ]

log('start', { cwd: process.cwd(), argv: process.argv.slice(2), mode: 'app-server', codexPath: env.CODEX_PATH ?? null })
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

function handle(method, params) {
  switch (method) {
    case 'initialize':
      return { userAgent: 'fake-codex/0.0.0', codexHome: '/nonexistent' }
    case 'config/read':
      return { config: { model: env.FAKE_CODEX_MODEL ?? null, model_reasoning_effort: null }, origins: {}, layers: null }
    case 'model/list': {
      if (env.FAKE_CODEX_LIST_ERROR) throw Object.assign(new Error(env.FAKE_CODEX_LIST_ERROR), { code: -32603 })
      const start = params.cursor ? Number(params.cursor) : 0
      const data = models.filter(item => params.includeHidden || !item.hidden)
      const next = start + 2 < data.length ? String(start + 2) : null
      return { data: data.slice(start, start + 2), nextCursor: next }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    log('recv', { method: message.method ?? null, id: message.id ?? null, params: message.params })
    if (message.id === undefined || message.method === undefined) continue
    try {
      send({ id: message.id, result: handle(message.method, message.params ?? {}) })
    } catch (error) {
      send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } })
    }
  }
})
process.stdin.on('end', () => {
  log('exit')
  process.exit(0)
})
