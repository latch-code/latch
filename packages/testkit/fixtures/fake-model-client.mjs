/** A stream's last event in each protocol; a service may keep the connection open after it. */
const LAST_EVENT = /"type":"response\.(?:completed|failed)"|data: \[DONE\]|"type":"message_stop"/gu

/** A reply as a client reads it: a stream up to its last event, whether or not the service has closed it yet. */
async function replyText(response) {
  if (!response.ok || !response.body || !/text\/event-stream/u.test(response.headers.get('content-type') ?? '')) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const next = await reader.read()
    if (next.done) return text
    text += decoder.decode(next.value, { stream: true })
    const last = [...text.matchAll(LAST_EVENT)].at(-1)
    if (last && (last[0].startsWith('data: [DONE]') || text.indexOf('\n\n', last.index) >= 0)) {
      await reader.cancel().catch(() => {})
      return text
    }
  }
}

/** A deterministic Agent's request to the loopback model server, using its declared protocol without conversion. */
export async function callFakeModel({ wire, baseURL, key, model, input }) {
  const root = baseURL.replace(/\/+$/u, '')
  const headers = { 'content-type': 'application/json' }
  headers[wire === 'anthropic-messages' ? 'x-api-key' : 'authorization'] = wire === 'anthropic-messages' ? key : `Bearer ${key}`
  const path = wire === 'responses' ? '/responses' : wire === 'chat-completions' ? '/chat/completions' : '/messages'
  const body =
    wire === 'responses'
      ? { model, input: [{ role: 'user', content: input }], stream: true }
      : { model, messages: [{ role: 'user', content: input }], stream: true, max_tokens: 256 }
  const response = await fetch(`${root}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const raw = await replyText(response)
  const events = raw
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .flatMap(line => {
      try {
        return [JSON.parse(line.slice(6))]
      } catch {
        return []
      }
    })
  const text = events
    .map(event => {
      if (wire === 'responses') return event.type === 'response.output_text.delta' ? event.delta : ''
      if (wire === 'chat-completions') return event.choices?.[0]?.delta?.content ?? ''
      return event.type === 'content_block_delta' ? (event.delta?.text ?? '') : ''
    })
    .join('')
  return { status: response.status, text: response.ok ? text : raw }
}
