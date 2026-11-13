import { createRoot } from 'react-dom/client'
import { AGENT_PRESETS } from '@latch/protocol'
import { MarkTile } from '../src/components/BrandTile.tsx'
import '@latch/ui/tokens.css'
import '@latch/ui/ui.css'
import '../src/styles/ui.css'

const marks = [{ id: 'latch', name: 'Latch' }, ...AGENT_PRESETS]

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16, maxWidth: 320, margin: '0 auto', color: 'var(--ink)' }}>
    <h1 style={{ fontSize: 'var(--fs-title)', lineHeight: 'var(--lh-title)', margin: '0 0 16px' }}>Harness</h1>
    <div style={{ display: 'grid', gridTemplateColumns: '90px repeat(4, 32px)', gap: '12px' }}>
      <span />
      {[14, 16, 20, 24].map(size => (
        <span key={size} style={{ fontSize: 'var(--fs-caption)', lineHeight: 'var(--lh-caption)' }}>
          {size}
        </span>
      ))}
      {marks.map(mark => (
        <div key={mark.id} data-mark={mark.id} style={{ display: 'contents' }}>
          <span style={{ fontSize: 'var(--fs-caption)', lineHeight: 'var(--lh-caption)', alignSelf: 'center' }}>{mark.name}</span>
          {([14, 16, 20, 24] as const).map(size => (
            <span key={size} data-mark-size={size} style={{ height: 32, display: 'flex', alignItems: 'center' }}>
              <MarkTile mark={mark.id} size={size} label={mark.name} />
            </span>
          ))}
        </div>
      ))}
    </div>
  </main>,
)
