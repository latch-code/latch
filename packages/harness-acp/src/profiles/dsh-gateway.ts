/** Exact IDs in dsh 0.2.2-rc.1's public Google catalog whose serializer uses discrete levels. No alias inference. */
const GEMINI_LEVEL_MODELS = new Set([
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-4-argon',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
])

export const dshGatewayThinking = (model: string, wire: string): boolean => wire !== 'gemini' || GEMINI_LEVEL_MODELS.has(model)
