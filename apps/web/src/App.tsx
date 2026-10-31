import { useEffect, useLayoutEffect } from 'react'
import { followSystemTheme } from '@latch/ui'
import { applyTheme, usePreferences } from './preferences.ts'
import { useHarness } from './core/useHarness.ts'
import { AppShell } from './shell/AppShell.tsx'
import { ConnectScreen, CrashScreen, EnrollmentPage } from './components/EnrollmentPage.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

/** Composition root: theme, authority from the Host, then enrollment or the workspace shell. */
export function App() {
  const harness = useHarness()
  const preferences = usePreferences()
  useLayoutEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])
  // A flip of the system's light or dark preference switches the colours at once too.
  useEffect(() => followSystemTheme(), [])
  const page =
    harness.snapshot !== null ? (
      <ErrorBoundary
        key={harness.snapshot.device.id}
        resetKey={harness.selectedId}
        fallback={reset => (
          <CrashScreen
            onNewSession={() => {
              harness.select(null)
              reset()
            }}
          />
        )}>
        <AppShell harness={harness} snapshot={harness.snapshot} />
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
  return page
}
