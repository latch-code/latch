import { configure } from 'vitest-browser-react/pure'
import tokens from '../src/tokens.css?inline'
import primitives from '../src/ui.css?inline'

// The design system's stylesheets, in the order a page loads them: the tokens declare the cascade layers first.
for (const text of [tokens, primitives]) {
  const style = document.createElement('style')
  style.textContent = text
  document.head.append(style)
}

// Effects run twice on mount, as in the page's development build, so opening and closing layers must be idempotent.
configure({ reactStrictMode: true })
