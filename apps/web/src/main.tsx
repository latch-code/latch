import React from 'react'
import { createRoot } from 'react-dom/client'
import { CUSTOM_TOKENS, revealScrollbarsWhileScrolling } from '@latch/ui'
import { App } from './App.tsx'
import { bootCustomization } from './core/customBoot.ts'
import { resolveLocale, setLocale } from './core/i18n.ts'
import { readPreferences } from './preferences.ts'
import './styles/index.css'

// Before anything renders: the address and keys that return the page to the default look, then the cached customisation.
bootCustomization(CUSTOM_TOKENS)
setLocale(resolveLocale(readPreferences().locale))
revealScrollbarsWhileScrolling()
const root = document.getElementById('root')
if (root === null) throw new Error('Missing application root')
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
