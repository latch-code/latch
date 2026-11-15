import { useEffect, useLayoutEffect, useState } from 'react'
import { followSystemTheme } from '@latch/ui'
import { applyAppearance, applyTheme, usePreferences } from './preferences.ts'
import { customization } from './core/customBoot.ts'
import { CustomizationActionsContext, CustomizationWrites, useCustomizationActions, useCustomizationStatus } from './core/customization.ts'
import { deviceAccess } from './core/permissions.ts'
import { computerLabel } from './core/securityCopy.ts'
import { currentShell } from './core/shell.ts'
import { useHarness } from './core/useHarness.ts'
import { AppShell } from './shell/AppShell.tsx'
import { ConnectScreen, CrashScreen, EnrollmentPage } from './components/EnrollmentPage.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { SafeModeBanner } from './components/SafeModeBanner.tsx'
import { ModelSpendWritesProvider } from './settings/modelSpendWrites.tsx'

/** Composition root: theme, authority from the Host, then enrollment or the workspace shell. */
export function App() {
  const harness = useHarness()
  const preferences = usePreferences()
  useLayoutEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])
  useLayoutEffect(() => {
    applyAppearance(preferences.motion, preferences.density)
  }, [preferences.motion, preferences.density])
  // The Host's customisation: every snapshot hands it to the boot module, which shows it or keeps this device on the default.
  const custom = useCustomizationStatus()
  const snapshot = harness.snapshot
  const [writes] = useState(() => new CustomizationWrites())
  const identity = snapshot ? { hostId: snapshot.host.hostId, deviceId: snapshot.device.id } : null
  const writer = useCustomizationActions(writes, identity)
  useLayoutEffect(() => {
    if (snapshot) customization().hostState(snapshot.customization, snapshot.host.hostId)
  }, [snapshot])
  useEffect(() => {
    customization().markRendered()
  }, [])
  const safe = custom.safe !== null
  useLayoutEffect(() => {
    if (safe) document.documentElement.dataset.safeMode = ''
    else delete document.documentElement.dataset.safeMode
  }, [safe])
  // A flip of the system's light or dark preference switches the colours at once too.
  useEffect(() => followSystemTheme(), [])
  const page =
    harness.snapshot !== null ? (
      <ErrorBoundary
        key={JSON.stringify([harness.snapshot.host?.hostId, harness.snapshot.device.id])}
        resetKey={harness.selectedId}
        fallback={reset => (
          <CrashScreen
            onNewSession={() => {
              harness.select(null)
              reset()
            }}
          />
        )}>
        <ModelSpendWritesProvider>
          <AppShell harness={harness} snapshot={harness.snapshot} />
        </ModelSpendWritesProvider>
      </ErrorBoundary>
    ) : harness.auth !== null ? (
      <EnrollmentPage key={harness.auth.reason} auth={harness.auth} onEnrolled={harness.confirmEnrollment} />
    ) : (
      <ConnectScreen
        error={harness.loading ? '' : harness.error}
        onRetry={() => {
          void harness.resync()
        }}
      />
    )
  const access = snapshot ? deviceAccess(snapshot, currentShell()) : null
  return (
    <CustomizationActionsContext value={writer}>
      {safe && (
        <SafeModeBanner
          admin={access?.admin === true}
          computer={computerLabel(access?.local === true, snapshot?.hostName)}
          baseRevision={snapshot?.customization?.revision}
          writer={writer}
          onChanged={() => {
            void harness.resync()
          }}
        />
      )}
      {page}
    </CustomizationActionsContext>
  )
}
