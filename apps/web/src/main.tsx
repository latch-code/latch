import React from 'react'
import { createRoot } from 'react-dom/client'
import { CUSTOM_TOKENS } from '@latch/ui'
import { App } from './App.tsx'
import { bootCustomization } from './core/customBoot.ts'
import './styles/index.css'

// Before anything renders: the address and keys that return the page to the default look, then the cached customisation.
bootCustomization(CUSTOM_TOKENS)
const root = document.getElementById('root')
if (root === null) throw new Error('Missing application root')
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
