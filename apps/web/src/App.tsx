import { useEffect, useLayoutEffect, useState } from 'react'
import { followSystemTheme } from '@latch/ui'
import { applyAppearance, applyTheme, usePreferences } from './preferences.ts'
import { customization } from './core/customBoot.ts'
import { CustomizationActionsContext, CustomizationWrites, useCustomizationActions, useCustomizationStatus } from './core/customization.ts'
import { defineCopy, resolveLocale, setLocale, useLocale } from './core/i18n.ts'
import { deviceAccess } from './core/permissions.ts'
import { computerLabel } from './core/securityCopy.ts'
import { currentShell } from './core/shell.ts'
import { shortcutBindings, useShortcutBindings } from './core/shortcutBindings.ts'
import { useHarness } from './core/useHarness.ts'
import { AppShell } from './shell/AppShell.tsx'
import { ConnectScreen, CrashScreen, EnrollmentPage } from './components/EnrollmentPage.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { SafeModeBanner } from './components/SafeModeBanner.tsx'
import { ModelSpendWritesProvider } from './settings/modelSpendWrites.tsx'

const COPY = defineCopy(
  { description: 'Latch：在桌面和手机之间接续的 Agent 工作台，自由组合 Harness、模型与项目。' },
  { description: 'Latch is an Agent workbench for desktop and phone. Choose your Harness, model, and project.' },
)

/** Composition root: theme, authority from the Host, then enrollment or the workspace shell. */
export function App() {
  const harness = useHarness()
  const preferences = usePreferences()
  const { motion, density, palette, accent, floatingMaterial } = preferences
  const locale = useLocale()
  useLayoutEffect(() => {
    const apply = () => setLocale(resolveLocale(preferences.locale))
    apply()
    if (preferences.locale !== 'system') return
    window.addEventListener('languagechange', apply)
    return () => window.removeEventListener('languagechange', apply)
  }, [preferences.locale])
  useLayoutEffect(() => {
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (description) description.content = COPY.description
    const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    if (manifest) manifest.href = locale === 'en' ? '/link/manifest.en.webmanifest' : '/link/manifest.webmanifest'
    currentShell()?.locale?.set(preferences.locale, locale)
  }, [preferences.locale, locale])
  useLayoutEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])
  useLayoutEffect(() => {
    applyAppearance({ motion, density, palette, accent, floatingMaterial })
  }, [motion, density, palette, accent, floatingMaterial])
  // The Host's customisation: every snapshot hands it to the boot module, which shows it or keeps this device on the default.
  const custom = useCustomizationStatus()
  const accentPreview = custom.preview !== null && custom.preview.appearance.accentHue !== custom.host?.doc.appearance.accentHue
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-host-accent-preview', accentPreview)
  }, [accentPreview])
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
  // This device's key bindings, read again from each Host and device it connects as.
  const hostId = snapshot?.host.hostId
  const deviceId = snapshot?.device.id
  const shortcutsFeature = snapshot?.catalog?.features?.shortcuts === true
  useEffect(() => {
    void shortcutBindings.load(hostId !== undefined && deviceId !== undefined ? { hostId, deviceId } : null, shortcutsFeature)
  }, [hostId, deviceId, shortcutsFeature])
  // The desktop app's menu bar shows and answers Code and 我的 Agent with this window's keys for them.
  const bindings = useShortcutBindings()
  useEffect(() => {
    const keys = shortcutBindings.effective()
    currentShell()?.spaces?.setKeys?.({
      code: keys.get('space-code') ?? null,
      agents: keys.get('space-agents') ?? null,
      pastePlainTextConflict: [...keys.values()].includes('Mod+Shift+KeyV'),
    })
  }, [bindings])
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
