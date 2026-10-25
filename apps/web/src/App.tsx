import { useLayoutEffect } from 'react'
import { applyTheme, usePreferences } from './preferences.ts'
import { useHarness } from './core/useHarness.ts'
import { viewportFor } from './breakpoints.ts'
import { Workspace } from './Workspace.tsx'
import { ConnectScreen, CrashScreen, EnrollmentPage } from './components/EnrollmentPage.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

/** A phone opens on its session list; wider screens on the latest session. */
const opensLatest = () => viewportFor(innerWidth) !== 'phone'

/** Composition root: theme, authority from the Host, then enrollment or the workspace shell. */
export function App() {
  const harness = useHarness({ openLatest: opensLatest })
  const preferences = usePreferences()
  useLayoutEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])
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
          void harness.resync()
        }}
      />
    )
  return page
}
