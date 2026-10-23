import { useLayoutEffect } from 'react'
import { applyTheme, usePreferences } from './preferences.ts'
import { useHarness } from './useHarness.ts'
import { Workspace } from './Workspace.tsx'
import { ConfirmationDialog } from './components/ConfirmationDialog.tsx'
import { ConnectScreen, CrashScreen, EnrollmentPage } from './components/EnrollmentPage.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

/** Composition root: theme, authority from the Host, then enrollment or the workspace shell. */
export function App() {
  const harness = useHarness()
  const preferences = usePreferences()
  useLayoutEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])
  // The confirmation dialog sits outside the boundary, so a render error never hides a pending local confirmation.
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
        <Workspace harness={harness} snapshot={harness.snapshot} />
      </ErrorBoundary>
    ) : harness.auth !== null ? (
      <EnrollmentPage key={harness.auth.reason} auth={harness.auth} onEnrolled={harness.confirmEnrollment} />
    ) : (
      <ConnectScreen
        error={harness.loading ? '' : harness.error}
        onRetry={() => {
          void harness.refresh()
        }}
      />
    )
  return (
    <>
      {page}
      <ConfirmationDialog />
    </>
  )
}
