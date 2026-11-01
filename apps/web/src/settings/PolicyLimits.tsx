import { useCallback, useEffect, useState } from 'react'
import type { HostCatalog } from '@latch/protocol'
import { Button, InlineNotice } from '@latch/ui'
import { errorMessage } from '../core/api.ts'
import { limitRows, readPolicy, type PolicyView } from '../core/policyView.ts'
import { LIMIT_COPY } from '../core/securityCopy.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'

/** 这台 Mac 的限制: what the policy file holds differently from a new Host, on the computer that can change it. */
export function PolicyLimits({ catalog }: { catalog: HostCatalog | undefined }) {
  const [policy, setPolicy] = useState<PolicyView | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    setError('')
    return readPolicy().then(setPolicy, (cause: unknown) => {
      setError(errorMessage(cause))
    })
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  if (error)
    return (
      <SettingsGroup title={LIMIT_COPY.title} bare>
        <InlineNotice
          tone="error"
          action={
            <Button
              onClick={() => {
                void load()
              }}>
              重试
            </Button>
          }>
          {error}
        </InlineNotice>
      </SettingsGroup>
    )
  if (!policy || !catalog) return null
  const rows = limitRows(policy, catalog)
  if (rows.length === 0) return null
  return (
    <SettingsGroup title={LIMIT_COPY.title} caption={LIMIT_COPY.howToChange}>
      {rows.map(row => (
        <SettingsRow key={row.id} title={row.title} description={row.description} />
      ))}
    </SettingsGroup>
  )
}
