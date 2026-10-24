import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Gallery } from './Gallery.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('Missing gallery root')
createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
)
