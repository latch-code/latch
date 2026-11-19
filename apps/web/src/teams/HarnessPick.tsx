import type { HarnessInfo, ModelRef } from '@latch/protocol'
import { ValuePicker } from '@latch/ui'
import { HarnessTile, MarkTile } from '../components/BrandTile.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { harnessName } from '../core/harnessName.ts'
import { TEAM_COPY } from './copy.ts'

/**
 * The Harness a member runs on: its mark and name, picked from the ones that are ready. Beside it, muted, the model of
 * a Latch service that member will use, when the person's own choice for that Harness is one.
 */
export function HarnessPick({
  value,
  ready,
  listed,
  model,
  disabled,
  onChange,
}: {
  value: string
  ready: readonly HarnessInfo[]
  /** Every Harness the computer lists, so one that is not ready now still shows by name. */
  listed: readonly HarnessInfo[]
  model?: ModelRef | undefined
  disabled?: boolean
  onChange: (harnessId: string) => void
}) {
  const current = listed.find(harness => harness.id === value)
  const options = (current && !ready.includes(current) ? [...ready, current] : ready).map(harness => ({
    value: harness.id,
    label: escapeHiddenCharacters(harnessName(harness)),
    media: <HarnessTile harness={harness} size={20} />,
  }))
  return (
    <span className="team-harness">
      <ValuePicker
        label={TEAM_COPY.harness}
        value={current ? value : undefined}
        placeholder={value || TEAM_COPY.noHarness}
        options={options}
        leading={current ? <HarnessTile harness={current} size={16} /> : <MarkTile mark={undefined} size={16} />}
        disabled={disabled === true || options.length === 0}
        onValueChange={onChange}
      />
      {model && <span className="team-model">{escapeHiddenCharacters(model.model)}</span>}
    </span>
  )
}
