import { useCallback, useEffect, useState } from 'react'
import { Button, ConfirmDialog, InlineNotice } from '@latch/ui'
import { errorMessage, MessageError } from '../core/api.ts'
import { addressRows, readPolicy, removeFromPolicy, type PolicyView } from '../core/policyView.ts'
import { NOTICE_COPY, PROVIDER_COPY } from '../core/securityCopy.ts'
import { NoteLine, SettingsGroup, SettingsRow } from './common.tsx'
import { SETTINGS_COPY } from './settings.copy.ts'

interface Removal {
  address?: string
  allowance?: string
  title: string
  message: string
}

/**
 * The model-service addresses this computer confirmed and what each one allows, each removable here. Removing asks for
 * no Touch ID, since it only takes something away; saving a service at that address again is what confirms it again.
 */
export function ConfirmedAddresses({
  providers,
  revision,
  onChanged,
}: {
  providers: ReadonlyArray<{ name: string; baseURL: string }>
  /** Changes when a save may have confirmed another address. */
  revision: string
  onChanged: () => void
}) {
  const [policy, setPolicy] = useState<PolicyView | null>(null)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<Removal | null>(null)
  const [auditMissing, setAuditMissing] = useState(false)
  const load = useCallback(() => {
    setError('')
    return readPolicy().then(setPolicy, (cause: unknown) => {
      setError(errorMessage(cause))
    })
  }, [])
  useEffect(() => {
    void load()
  }, [load, revision])
  if (error)
    return (
      <SettingsGroup title={PROVIDER_COPY.confirmedAddressesTitle} bare>
        <InlineNotice
          tone="error"
          action={
            <Button
              onClick={() => {
                void load()
              }}>
              {SETTINGS_COPY.retry}
            </Button>
          }>
          {error}
        </InlineNotice>
      </SettingsGroup>
    )
  if (!policy) return null
  const { addresses, allowances } = addressRows(policy, providers)
  // The last removal empties the list, and what it failed to record still has to be said.
  if (addresses.length === 0 && allowances.length === 0 && !auditMissing) return null
  return (
    <SettingsGroup title={PROVIDER_COPY.confirmedAddressesTitle} note={<NoteLine brief={PROVIDER_COPY.confirmedAddressesCaption} />}>
      {addresses.map(row => (
        <SettingsRow
          key={row.address}
          className="address-row"
          title={row.shown}
          description={PROVIDER_COPY.addressUse(row.services, row.allowance)}
          trailing={
            <Button
              onClick={() => {
                setRemoving({
                  address: row.address,
                  ...(row.allowance ? { allowance: row.allowance } : {}),
                  title: SETTINGS_COPY.removeTitle(row.shown),
                  message: PROVIDER_COPY.removeAddress(row.services),
                })
              }}>
              {SETTINGS_COPY.remove}
            </Button>
          }
        />
      ))}
      {allowances.map(entry => (
        <SettingsRow
          key={entry}
          className="address-row"
          title={entry}
          description={PROVIDER_COPY.allowanceRow}
          trailing={
            <Button
              onClick={() => {
                setRemoving({ allowance: entry, title: SETTINGS_COPY.removeTitle(entry), message: PROVIDER_COPY.removeAllowance })
              }}>
              {SETTINGS_COPY.remove}
            </Button>
          }
        />
      ))}
      {auditMissing && <InlineNotice tone="error">{NOTICE_COPY.auditNotRecorded}</InlineNotice>}
      {removing && (
        <ConfirmDialog
          title={removing.title}
          danger
          confirmLabel={SETTINGS_COPY.remove}
          message={removing.message}
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            try {
              const result = await removeFromPolicy({
                ...(removing.address ? { address: removing.address } : {}),
                ...(removing.allowance ? { allowance: removing.allowance } : {}),
              })
              setAuditMissing(result.auditFailed)
            } catch (cause) {
              // A removal that timed out may have happened, so what is listed comes from the Host either way.
              void load()
              throw new MessageError(errorMessage(cause), { cause })
            }
            await load()
            onChanged()
          }}
        />
      )}
    </SettingsGroup>
  )
}
