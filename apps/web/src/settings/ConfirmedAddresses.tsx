import { useCallback, useEffect, useState } from 'react'
import { Button, ConfirmDialog, InlineNotice } from '@latch/ui'
import { errorMessage } from '../core/api.ts'
import { addressRows, readPolicy, removeFromPolicy, type PolicyView } from '../core/policyView.ts'
import { AUDIT_NOT_RECORDED_TEXT, PROVIDER_COPY } from '../core/securityCopy.ts'
import { NoteLine, SettingsGroup, SettingsRow } from './common.tsx'

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
              重试
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
                  title: `移除 ${row.shown}？`,
                  message: PROVIDER_COPY.removeAddress(row.services),
                })
              }}>
              移除
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
                setRemoving({ allowance: entry, title: `移除 ${entry}？`, message: PROVIDER_COPY.removeAllowance })
              }}>
              移除
            </Button>
          }
        />
      ))}
      {auditMissing && <InlineNotice tone="error">{AUDIT_NOT_RECORDED_TEXT}</InlineNotice>}
      {removing && (
        <ConfirmDialog
          title={removing.title}
          danger
          confirmLabel="移除"
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
              throw new Error(errorMessage(cause), { cause })
            }
            await load()
            onChanged()
          }}
        />
      )}
    </SettingsGroup>
  )
}
