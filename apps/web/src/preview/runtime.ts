interface ScriptPolicy {
  createScriptURL(value: string): unknown
}
interface ScriptPolicies {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): ScriptPolicy
}
let policy: ScriptPolicy | undefined

/** Only immutable application modules can enter a script URL sink; no HTML or script-text policy exists. */
function validate(value: string | URL): string {
  const input = String(value)
  const target = new URL(input, location.href)
  const base = new URL(location.href)
  const sameOrigin = target.protocol === base.protocol && target.host === base.host
  const built = /^\/link\/assets\/[A-Za-z0-9_.-]+\.(?:js|mjs)$/u.test(target.pathname)
  const module = /^\/link\/api\/ui-modules\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\.mjs$/u.test(target.pathname)
  // Vite fixtures and development use source workers; production never serves .ts assets.
  const development =
    import.meta.env.DEV
    && /^\/(?:link\/)?(?:src\/preview\/[A-Za-z0-9.-]+\.worker\.ts|node_modules\/\.vite\/deps\/[A-Za-z0-9_.-]+\.js)$/u.test(target.pathname)
  const pdfDevelopment =
    import.meta.env.DEV
    && target.pathname.startsWith('/@fs/')
    && /\/node_modules\/pdfjs-dist\/build\/pdf\.worker\.min\.mjs$/u.test(target.pathname)
  if (
    !sameOrigin
    || target.username
    || target.password
    || target.hash
    || (!built && !module && !development && !pdfDevelopment)
    || (!development && !pdfDevelopment && target.search)
  )
    throw new Error('script-url-refused')
  return target.href
}
export function trustedScriptUrl(value: string | URL): string {
  const url = validate(value)
  const factory = (globalThis as typeof globalThis & { trustedTypes?: ScriptPolicies }).trustedTypes
  if (!factory) return url
  policy ??= factory.createPolicy('latch-runtime', { createScriptURL: validate })
  return policy.createScriptURL(url) as string
}
