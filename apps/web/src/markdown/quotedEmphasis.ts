// In unspaced prose the quotes can sit right against an emphasis marker: 的**“重点”**是.
// Register them with the inline tokenizer so escapes, code, URLs and source offsets keep their Markdown semantics.
const quotes = ['"', '“', '”', '‘', '’', '「', '」', '『', '』', '《', '》']
const extension = { attentionMarkers: { null: quotes.map(quote => quote.charCodeAt(0)) } }

export const quotedEmphasis = function (this: { data(): object & { micromarkExtensions?: unknown[] } }) {
  const data = this.data()
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), extension]
}

export const isEmphasisQuote = (value: string | undefined): boolean => value !== undefined && quotes.includes(value)
