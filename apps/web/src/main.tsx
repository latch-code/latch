import React from 'react'
import { createRoot } from 'react-dom/client'
import { CUSTOM_TOKENS, revealScrollbarsWhileScrolling } from '@latch/ui'
import { App } from './App.tsx'
import { bootCustomization } from './core/customBoot.ts'
import { resolveLocale, setLocale } from './core/i18n.ts'
import { readPreferences, setPreference } from './preferences.ts'
import './styles/index.css'

// The desktop recovery dialog can open Code's start page before a session's history is read.
const startAtHome =
  location.protocol === 'latch:' && location.pathname === '/link/' && location.search === '?recovery=start' && !location.hash
if (startAtHome) {
  history.replaceState(history.state, '', location.pathname)
  if (readPreferences().workView === 'board') setPreference('workView', 'chat')
}
// Before anything renders: the address and keys that return the page to the default look, then the cached customisation.
bootCustomization(CUSTOM_TOKENS)
setLocale(resolveLocale(readPreferences().locale))
revealScrollbarsWhileScrolling()
const root = document.getElementById('root')
if (root === null) throw new Error('Missing application root')
createRoot(root, {
  onUncaughtError: () => document.dispatchEvent(new Event('latch:page-load-error')),
  // Boundaries show fixed copy. React's default reporter prints the thrown value.
  ...(import.meta.env.PROD ? { onCaughtError: () => {} } : {}),
}).render(
  <React.StrictMode>
    <App startAtHome={startAtHome} />
  </React.StrictMode>,
)
