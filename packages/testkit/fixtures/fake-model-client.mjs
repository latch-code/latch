/** A deterministic Agent's request to the loopback model server, using its declared protocol without conversion. */
export async function callFakeModel({ wire, baseURL, key, model, input }) {
  const root = baseURL.replace(/\/+$/u, '')
  const headers = { 'content-type': 'application/json' }
  let path
  let body
  if (wire === 'gemini') {
    path = `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    headers['x-goog-api-key'] = key
    body = { contents: [{ role: 'user', parts: [{ text: input }] }] }
  } else {
    headers[wire === 'anthropic-messages' ? 'x-api-key' : 'authorization'] = wire === 'anthropic-messages' ? key : `Bearer ${key}`
    path = wire === 'responses' ? '/responses' : wire === 'chat-completions' ? '/chat/completions' : '/messages'
    body =
      wire === 'responses'
        ? { model, input: [{ role: 'user', content: input }], stream: true }
        : { model, messages: [{ role: 'user', content: input }], stream: true, max_tokens: 256 }
  }
  const response = await fetch(`${root}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const raw = await response.text()
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
      if (wire === 'anthropic-messages') return event.type === 'content_block_delta' ? (event.delta?.text ?? '') : ''
      return event.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? ''
    })
    .join('')
  return { status: response.status, text: response.ok ? text : raw }
}
